import * as core from '@actions/core'
import * as k8s from '@kubernetes/client-node'
import {
  JobContainerInfo,
  ContextPorts,
  PrepareJobArgs,
  writeToResponseFile,
  ServiceContainerInfo
} from 'hooklib'
import {
  containerPorts,
  createJobPod,
  isPodContainerAlpine,
  prunePods,
  waitForJobPodRunning,
  getPrepareJobTimeoutSeconds,
  execCpToPod,
  execListing,
  execPodStep
} from '../k8s'
import {
  CONTAINER_VOLUMES,
  DEFAULT_CONTAINER_ENTRY_POINT,
  DEFAULT_CONTAINER_ENTRY_POINT_ARGS,
  formatError,
  generateContainerName,
  mergeContainerWithOptions,
  readExtensionFromFile,
  fixArgs,
  prepareJobScript
} from '../k8s/utils'
import {
  CONTAINER_EXTENSION_PREFIX,
  getJobPodName,
  JOB_CONTAINER_NAME
} from './constants'
import { dirname } from 'path'
import {
  formatCopyStats,
  formatSeconds,
  HOOK_LOG_PREFIX,
  hookInfo,
  Stopwatch
} from '../k8s/hook-log'
import { renderSettings, resolveFailFastSettings } from '../k8s/pod-status'
import { startReadAhead } from '../k8s/read-ahead'
import { ExternalsMode, resolveExternals } from '../k8s/externals'
import {
  formatWorkTransfer,
  JOB_WORK_STATUS,
  parseWorkStatus,
  resolveWorkTransfer,
  runnerPodIp,
  startWorkServer,
  WorkServer,
  workUrl,
  WorkStatus
} from '../k8s/work-transfer'

export async function prepareJob(
  args: PrepareJobArgs,
  responseFile
): Promise<void> {
  if (!args.container) {
    throw new Error('Job Container is required.')
  }
  const totalTimer = new Stopwatch()
  const runnerWorkspace = dirname(process.env.RUNNER_WORKSPACE as string)
  // First, so the reads overlap with creating the pod and waiting for it.
  const readAhead = startReadAhead(runnerWorkspace)
  let readAheadMs: number | undefined
  void readAhead.finished.then(ms => (readAheadMs = ms))

  await prunePods()

  const extension = readExtensionFromFile()

  let container: k8s.V1Container | undefined = undefined
  if (args.container?.image) {
    container = createContainerSpec(
      args.container,
      JOB_CONTAINER_NAME,
      true,
      extension
    )
  }

  let services: k8s.V1Container[] = []
  let serviceNames: string[] = []
  if (args.services?.length) {
    const occurrences = new Map<string, number>()
    for (const s of args.services) {
      const base = generateContainerName(s.image)
      occurrences.set(base, (occurrences.get(base) || 0) + 1)
    }

    const indices = new Map<string, number>()
    services = args.services.map(service => {
      const base = generateContainerName(service.image)
      const total = occurrences.get(base) || 0
      const idx = indices.get(base) || 0

      let name: string
      if (total > 1) {
        name = `${base}-${idx}`
      } else {
        name = base
      }

      indices.set(base, idx + 1)
      serviceNames.push(name)
      return createContainerSpec(service, name, false, extension)
    })
  }

  if (!container && !services?.length) {
    throw new Error('No containers exist, skipping hook invocation')
  }

  const transfer = resolveWorkTransfer(
    args.container.environmentVariables,
    process.env
  )
  const externals = resolveExternals(
    args.container.environmentVariables,
    process.env
  )
  for (const warning of [transfer.warning, externals.warning]) {
    if (warning) {
      core.warning(`${HOOK_LOG_PREFIX} ${warning}`)
    }
  }
  hookInfo(
    `work transfer ${transfer.mode} (${transfer.source}), ` +
      `externals ${externals.mode} (${externals.source})`
  )
  const work =
    transfer.mode === 'http' ? await serveWork(runnerWorkspace) : undefined
  try {
    await prepareJobPod(
      // Spelled out so the type carries the check above.
      { ...args, container: args.container },
      responseFile,
      container,
      services,
      serviceNames,
      extension,
      runnerWorkspace,
      work,
      externals.mode
    )
  } finally {
    readAhead.stop()
    await work?.server.close()
  }
  hookInfo(
    readAheadMs === undefined
      ? 'read-ahead of _work was still running when the copy finished'
      : `read-ahead of _work finished in ${formatSeconds(readAheadMs)}`
  )
  hookInfo(`prepare_job done in ${formatSeconds(totalTimer.elapsedMs())}`)
}

export interface ServedWork {
  server: WorkServer
  url: string
}

// Starts the HTTP server fs-init downloads `_work` from. Without one, the job pod gets
// `_work` through the exec copy, as upstream.
async function serveWork(root: string): Promise<ServedWork | undefined> {
  const ip = runnerPodIp(process.env)
  if (!ip) {
    core.warning(
      `${HOOK_LOG_PREFIX} cannot tell this runner pod's IP; set ACTIONS_RUNNER_POD_IP from ` +
        'status.podIP. Copying _work through the API server instead.'
    )
    return undefined
  }
  try {
    const server = await startWorkServer(root)
    return { server, url: workUrl(ip, server.port) }
  } catch (error) {
    core.warning(
      `${HOOK_LOG_PREFIX} cannot serve _work over HTTP (${formatError(error)}); ` +
        'copying it through the API server instead.'
    )
    return undefined
  }
}

// Logs the HTTP transfer if fs-init finished it, otherwise copies `_work` over exec.
export async function copyWorkToPod(
  podName: string,
  runnerWorkspace: string,
  work: ServedWork | undefined
): Promise<void> {
  if (work) {
    let status: WorkStatus
    try {
      status = parseWorkStatus(
        await execListing(podName, JOB_CONTAINER_NAME, [
          'sh',
          '-c',
          `cat ${JOB_WORK_STATUS} 2>/dev/null || true`
        ])
      )
    } catch (error) {
      status = {
        ok: false,
        reason: `reading the status failed: ${formatError(error)}`
      }
    }
    if (status.ok) {
      hookInfo(formatWorkTransfer(work.server.stats, status.downloadMs))
      return
    }
    core.warning(
      `${HOOK_LOG_PREFIX} fs-init did not download _work over HTTP (${status.reason}); ` +
        'copying it through the API server instead.'
    )
  }
  const workStats = await execCpToPod(podName, runnerWorkspace, '/__w')
  hookInfo(formatCopyStats('copy _work to job pod', workStats))
}

async function prepareJobPod(
  args: PrepareJobArgs & { container: JobContainerInfo },
  responseFile: string,
  container: k8s.V1Container | undefined,
  services: k8s.V1Container[],
  serviceNames: string[],
  extension: k8s.V1PodTemplateSpec | undefined,
  runnerWorkspace: string,
  work: ServedWork | undefined,
  externals: ExternalsMode
): Promise<void> {
  let createdPod: k8s.V1Pod | undefined = undefined
  const createTimer = new Stopwatch()
  try {
    createdPod = await createJobPod(
      getJobPodName(),
      container,
      services,
      args.container.registry,
      extension,
      work && { url: work.url, token: work.server.token },
      externals
    )
  } catch (err) {
    await prunePods()
    const message = formatError(err)
    core.debug(`createPod failed: ${message}`)
    throw new Error(`failed to create job pod: ${message}`)
  }

  if (!createdPod?.metadata?.name) {
    throw new Error('created pod should have metadata.name')
  }
  hookInfo(
    `job pod ${createdPod.metadata.name} created in ${formatSeconds(createTimer.elapsedMs())}`
  )
  core.debug(
    `Job pod created, waiting for it to come online ${createdPod?.metadata?.name}`
  )

  let prepareScript: { containerPath: string; runnerPath: string } | undefined
  if (args.container?.userMountVolumes?.length) {
    prepareScript = prepareJobScript(args.container.userMountVolumes || [])
  }

  const prepareTimeoutSeconds = getPrepareJobTimeoutSeconds()
  const failFast = resolveFailFastSettings(
    args.container.environmentVariables,
    process.env,
    prepareTimeoutSeconds
  )
  for (const warning of failFast.warnings) {
    core.warning(`${HOOK_LOG_PREFIX} ${warning}`)
  }
  hookInfo(renderSettings(failFast))

  try {
    await waitForJobPodRunning(
      createdPod.metadata.name,
      prepareTimeoutSeconds,
      failFast
    )
  } catch (err) {
    await prunePods()
    throw new Error(`pod failed to come online with error: ${formatError(err)}`)
  }
  hookInfo(
    `job pod Running ${formatSeconds(createTimer.elapsedMs())} after create`
  )

  await copyWorkToPod(createdPod.metadata.name, runnerWorkspace, work)

  if (prepareScript) {
    await execPodStep(
      ['sh', '-e', prepareScript.containerPath],
      createdPod.metadata.name,
      JOB_CONTAINER_NAME
    )

    const promises: Promise<void>[] = []
    for (const vol of args?.container?.userMountVolumes || []) {
      promises.push(
        execCpToPod(
          createdPod.metadata.name,
          vol.sourceVolumePath,
          vol.targetVolumePath
        ).then(stats =>
          hookInfo(
            formatCopyStats(`copy volume to ${vol.targetVolumePath}`, stats)
          )
        )
      )
    }
    await Promise.all(promises)
  }

  core.debug('Job pod is ready for traffic')

  let isAlpine = false
  try {
    isAlpine = await isPodContainerAlpine(
      createdPod.metadata.name,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    const message = formatError(err)
    core.debug(`Failed to determine if the pod is alpine: ${message}`)
    throw new Error(`failed to determine if the pod is alpine: ${message}`)
  }
  core.debug(`Setting isAlpine to ${isAlpine}`)
  generateResponseFile(responseFile, args, createdPod, isAlpine, serviceNames)
}

function generateResponseFile(
  responseFile: string,
  args: PrepareJobArgs,
  appPod: k8s.V1Pod,
  isAlpine: boolean,
  serviceNames?: string[]
): void {
  if (!appPod.metadata?.name) {
    throw new Error('app pod must have metadata.name specified')
  }
  const response = {
    state: {
      jobPod: appPod.metadata.name
    },
    context: {},
    isAlpine
  }

  const mainContainer = appPod.spec?.containers?.find(
    c => c.name === JOB_CONTAINER_NAME
  )
  if (mainContainer) {
    const mainContainerContextPorts: ContextPorts = {}
    if (mainContainer?.ports) {
      for (const port of mainContainer.ports) {
        mainContainerContextPorts[port.containerPort] =
          mainContainerContextPorts.hostPort
      }
    }

    response.context['container'] = {
      image: mainContainer.image,
      ports: mainContainerContextPorts
    }
  }

  if (args.services?.length) {
    const serviceContainerNames =
      serviceNames && serviceNames.length
        ? serviceNames
        : args.services?.map(s => generateContainerName(s.image)) || []

    response.context['services'] = appPod?.spec?.containers
      ?.filter(c => serviceContainerNames.includes(c.name))
      .map(c => {
        const ctxPorts: ContextPorts = {}
        if (c.ports?.length) {
          for (const port of c.ports) {
            if (port.containerPort && port.hostPort) {
              ctxPorts[port.containerPort.toString()] = port.hostPort.toString()
            }
          }
        }

        return {
          image: c.image,
          ports: ctxPorts
        }
      })
  }

  writeToResponseFile(responseFile, JSON.stringify(response))
}

export function createContainerSpec(
  container: JobContainerInfo | ServiceContainerInfo,
  name: string,
  jobContainer = false,
  extension?: k8s.V1PodTemplateSpec
): k8s.V1Container {
  if (!container.entryPoint && jobContainer) {
    container.entryPoint = DEFAULT_CONTAINER_ENTRY_POINT
    container.entryPointArgs = DEFAULT_CONTAINER_ENTRY_POINT_ARGS
  }

  const podContainer = {
    name,
    image: container.image,
    ports: containerPorts(container)
  } as k8s.V1Container
  if (container['workingDirectory']) {
    podContainer.workingDir = container['workingDirectory']
  }

  if (container.entryPoint) {
    podContainer.command = [container.entryPoint]
  }

  if (container.entryPointArgs && container.entryPointArgs.length > 0) {
    podContainer.args = fixArgs(container.entryPointArgs)
  }

  podContainer.env = []
  for (const [key, value] of Object.entries(
    container['environmentVariables'] || {}
  )) {
    if (value && key !== 'HOME') {
      podContainer.env.push({ name: key, value })
    }
  }

  podContainer.env.push({
    name: 'GITHUB_ACTIONS',
    value: 'true'
  })

  if (!('CI' in (container['environmentVariables'] || {}))) {
    podContainer.env.push({
      name: 'CI',
      value: 'true'
    })
  }

  podContainer.volumeMounts = CONTAINER_VOLUMES

  if (!extension) {
    return podContainer
  }

  const from = extension.spec?.containers?.find(
    c => c.name === CONTAINER_EXTENSION_PREFIX + name
  )

  if (from) {
    mergeContainerWithOptions(podContainer, from)
  }

  return podContainer
}
