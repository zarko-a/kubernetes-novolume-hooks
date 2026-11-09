import * as core from '@actions/core'
import * as path from 'path'
import { spawn } from 'child_process'
import * as k8s from '@kubernetes/client-node'
import tar from 'tar-fs'
import * as stream from 'stream'
import type { EventEmitter } from 'events'
import { createHash } from 'crypto'
import type { ContainerInfo, Registry } from 'hooklib'
import {
  getSecretName,
  JOB_CONTAINER_NAME,
  RunnerInstanceLabel
} from '../hooks/constants'
import {
  PodPhase,
  formatError,
  mergePodSpecWithOptions,
  mergeObjectMeta,
  fixArgs,
  githubLinkCommands,
  listDirAllCommand,
  sleep,
  EXTERNALS_VOLUME_NAME,
  GITHUB_VOLUME_NAME,
  WORK_VOLUME
} from './utils'
import * as shlex from 'shlex'
import { collectingStream, CollectingStream } from './collect-stream'
import { parsePositiveMsEnv, WebSocketHeartbeat } from './heartbeat'
import {
  CopyStats,
  HOOK_LOG_PREFIX,
  hookInfo,
  Stopwatch,
  TarEntryCounter
} from './hook-log'
import { PollSchedule } from './poll'
import { rejectIfClosedWithoutStatus, trackStatus } from './exec-status'
import {
  eventsSince,
  FailFastSettings,
  FailFastTracker,
  PodStatusReporter,
  renderEvent,
  renderPodTrouble
} from './pod-status'
import type { HeartbeatWebSocket } from './heartbeat'
import {
  ExternalsMode,
  externalsInitCommands,
  externalsVolume,
  mountExternalsFromImage
} from './externals'
import {
  WORK_TOKEN_ENV,
  WORK_URL_ENV,
  WorkDownload,
  workDownloadScript
} from './work-transfer'

const kc = new k8s.KubeConfig()

kc.loadFromDefault()

const k8sApi = kc.makeApiClient(k8s.CoreV1Api)
const k8sAuthorizationV1Api = kc.makeApiClient(k8s.AuthorizationV1Api)

const DEFAULT_WAIT_FOR_POD_TIME_SECONDS = 10 * 60 // 10 min

export const requiredPermissions = [
  {
    group: '',
    verbs: ['get', 'list', 'create', 'delete'],
    resource: 'pods',
    subresource: ''
  },
  {
    group: '',
    verbs: ['get', 'create'],
    resource: 'pods',
    subresource: 'exec'
  },
  {
    group: '',
    verbs: ['create', 'delete', 'get', 'list'],
    resource: 'secrets',
    subresource: ''
  }
]

export async function createJobPod(
  name: string,
  jobContainer?: k8s.V1Container,
  services?: k8s.V1Container[],
  registry?: Registry,
  extension?: k8s.V1PodTemplateSpec,
  workDownload?: WorkDownload,
  externals: ExternalsMode = 'copy'
): Promise<k8s.V1Pod> {
  const containers: k8s.V1Container[] = []
  if (jobContainer) {
    containers.push(jobContainer)
  }
  if (services?.length) {
    containers.push(...services)
  }
  if (externals === 'image') {
    mountExternalsFromImage(containers)
  }
  const runnerImage =
    process.env.ACTIONS_RUNNER_IMAGE || 'ghcr.io/actions/actions-runner:latest'

  const appPod = new k8s.V1Pod()

  appPod.apiVersion = 'v1'
  appPod.kind = 'Pod'

  appPod.metadata = new k8s.V1ObjectMeta()
  appPod.metadata.name = name

  const instanceLabel = new RunnerInstanceLabel()
  appPod.metadata.labels = {
    [instanceLabel.key]: instanceLabel.value
  }
  appPod.metadata.annotations = {}

  appPod.spec = new k8s.V1PodSpec()
  appPod.spec.containers = containers
  appPod.spec.securityContext = {
    fsGroup: 1001
  }

  // Extract working directory from GITHUB_WORKSPACE
  // GITHUB_WORKSPACE is like /__w/repo-name/repo-name
  const githubWorkspace = process.env.GITHUB_WORKSPACE
  const workingDirPath = githubWorkspace?.split('/').slice(-2).join('/') ?? ''

  const initCommands = [
    // Group-writable directories: fsGroup 1001 puts every container in group 1001, so a job
    // container running as any uid can write the workspace fs-init creates as uid 1001.
    'umask 0002',
    'mkdir -p /mnt/work',
    'mkdir -p /mnt/github',
    ...githubLinkCommands('/mnt/github'),
    ...externalsInitCommands(externals)
  ]

  if (workingDirPath) {
    initCommands.push(`mkdir -p /mnt/work/${workingDirPath}`)
  }

  if (workDownload) {
    // Last, after the directories exist. It always exits 0; see workDownloadScript.
    initCommands.push(workDownloadScript())
  }

  appPod.spec.initContainers = [
    {
      name: 'fs-init',
      image: runnerImage,
      command: ['sh', '-c', initCommands.join(' && ')],
      env: workDownload
        ? [
            { name: WORK_URL_ENV, value: workDownload.url },
            { name: WORK_TOKEN_ENV, value: workDownload.token }
          ]
        : undefined,
      securityContext: {
        runAsGroup: 1001,
        runAsUser: 1001
      },
      volumeMounts: [
        ...(externals === 'copy'
          ? [{ name: EXTERNALS_VOLUME_NAME, mountPath: '/mnt/externals' }]
          : []),
        {
          name: WORK_VOLUME,
          mountPath: '/mnt/work'
        },
        {
          name: GITHUB_VOLUME_NAME,
          mountPath: '/mnt/github'
        }
      ]
    }
  ]

  appPod.spec.restartPolicy = 'Never'

  appPod.spec.volumes = [
    externalsVolume(externals, runnerImage),
    {
      name: GITHUB_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: WORK_VOLUME,
      emptyDir: {}
    }
  ]

  if (registry) {
    const secret = await createDockerSecret(registry)
    if (!secret?.metadata?.name) {
      throw new Error(`created secret does not have secret.metadata.name`)
    }
    const secretReference = new k8s.V1LocalObjectReference()
    secretReference.name = secret.metadata.name
    appPod.spec.imagePullSecrets = [secretReference]
  }

  if (extension?.metadata) {
    mergeObjectMeta(appPod, extension.metadata)
  }

  if (extension?.spec) {
    mergePodSpecWithOptions(appPod.spec, extension.spec)
  }

  return await k8sApi.createNamespacedPod({
    namespace: namespace(),
    body: appPod
  })
}

export async function createContainerStepPod(
  name: string,
  container: k8s.V1Container,
  extension?: k8s.V1PodTemplateSpec
): Promise<k8s.V1Pod> {
  const appPod = new k8s.V1Pod()

  appPod.apiVersion = 'v1'
  appPod.kind = 'Pod'

  appPod.metadata = new k8s.V1ObjectMeta()
  appPod.metadata.name = name

  const instanceLabel = new RunnerInstanceLabel()
  appPod.metadata.labels = {
    [instanceLabel.key]: instanceLabel.value
  }
  appPod.metadata.annotations = {}

  appPod.spec = new k8s.V1PodSpec()
  appPod.spec.containers = [container]

  appPod.spec.restartPolicy = 'Never'

  appPod.spec.volumes = [
    {
      name: EXTERNALS_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: GITHUB_VOLUME_NAME,
      emptyDir: {}
    },
    {
      name: WORK_VOLUME,
      emptyDir: {}
    }
  ]

  if (extension?.metadata) {
    mergeObjectMeta(appPod, extension.metadata)
  }

  if (extension?.spec) {
    mergePodSpecWithOptions(appPod.spec, extension.spec)
  }

  return await k8sApi.createNamespacedPod({
    namespace: namespace(),
    body: appPod
  })
}

export async function deletePod(name: string): Promise<void> {
  await k8sApi.deleteNamespacedPod({
    name,
    namespace: namespace(),
    gracePeriodSeconds: 0
  })
}

export async function execPodStep(
  command: string[],
  podName: string,
  containerName: string,
  stdin?: stream.Readable
): Promise<number> {
  const exec = new k8s.Exec(kc)
  core.debug(
    `[execPodStep] Starting: cmd="${command[0]}" (${command.length} args), pod=${podName}, container=${containerName}`
  )

  command = fixArgs(command)

  const DEFAULT_PING_PERIOD_MS = 5000
  const pingPeriodMs = parsePositiveMsEnv(
    process.env.ACTIONS_RUNNER_HEARTBEAT_PERIOD_MS,
    DEFAULT_PING_PERIOD_MS
  )
  const pongDeadlineMs = parsePositiveMsEnv(
    process.env.ACTIONS_RUNNER_HEARTBEAT_DEADLINE_MS,
    pingPeriodMs * 12 + 1000
  )
  core.debug(
    `[execPodStep] Heartbeat config: pingPeriodMs=${pingPeriodMs}, pongDeadlineMs=${pongDeadlineMs}`
  )

  const heartbeat = new WebSocketHeartbeat(pingPeriodMs, pongDeadlineMs)

  return new Promise<number>((resolve, reject) => {
    core.debug('[execPodStep] About to call exec.exec')
    let ws: HeartbeatWebSocket | null = null

    const status = trackStatus<k8s.V1Status>(async resp => {
      core.debug(`[execPodStep] execPodStep response: ${JSON.stringify(resp)}`)

      heartbeat.stop()

      // Close WebSocket and wait for it before resolving/rejecting
      const closeWebSocket = async (): Promise<void> => {
        const socket = ws
        if (socket && (socket.readyState === 1 || socket.readyState === 0)) {
          return new Promise<void>(closeResolve => {
            const closeTimeout = setTimeout(() => {
              core.warning(
                '[execPodStep] WebSocket close timeout, forcing cleanup'
              )
              closeResolve()
            }, 5000)

            socket.once('close', () => {
              clearTimeout(closeTimeout)
              core.debug('[execPodStep] WebSocket closed cleanly')
              closeResolve()
            })
            socket.close()
          })
        }
      }

      if (resp.status === 'Success') {
        core.debug(`[execPodStep] Success, code: ${resp.code}`)
        await closeWebSocket()
        resolve(resp.code || 0)
      } else {
        core.debug(
          `[execPodStep] Failure: ${JSON.stringify({ message: resp?.message, details: resp?.details })}`
        )
        await closeWebSocket()
        reject(new Error(resp?.message || 'execPodStep failed'))
      }
    })

    exec
      .exec(
        namespace(),
        podName,
        containerName,
        command,
        process.stdout,
        process.stderr,
        stdin ?? null,
        false /* tty */,
        status.callback
      )
      .then(websocket => {
        core.debug('[execPodStep] exec.exec resolved, ws object received')
        ws = websocket
        rejectIfClosedWithoutStatus(
          ws,
          status.received,
          reject,
          `command ${command[0]} in ${podName}`
        )
        if (ws) {
          heartbeat.start(ws, reject)
        } else {
          core.warning('[Heartbeat] WebSocket is null, heartbeat not started')
        }
      })
      .catch(async e => {
        heartbeat.stop()
        core.error(`[execPodStep] exec.exec threw error: ${e}`)

        // Close WebSocket before rejecting with timeout protection
        const socket = ws
        if (socket && (socket.readyState === 1 || socket.readyState === 0)) {
          await new Promise<void>(closeResolve => {
            const closeTimeout = setTimeout(() => {
              core.warning(
                '[execPodStep] WebSocket close timeout in error handler'
              )
              closeResolve()
            }, 5000)

            socket.once('close', () => {
              clearTimeout(closeTimeout)
              closeResolve()
            })
            socket.close()
          })
        }

        reject(e)
      })
  })
}

// Runs a listing command in the job pod and returns its stdout.
export async function execListing(
  podName: string,
  containerName: string,
  command: string[]
): Promise<string> {
  const exec = new k8s.Exec(kc)

  let output = ''
  const outputWriter = new stream.Writable({
    write(chunk, _enc, cb) {
      try {
        output += chunk.toString('utf8')
        cb()
      } catch (e) {
        cb(e as Error)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    const status = trackStatus<k8s.V1Status>(resp => {
      core.debug(`execListing response: ${JSON.stringify(resp)}`)
      if (resp.status === 'Success') {
        resolve()
      } else {
        reject(new Error(resp?.message || 'listing in the job pod failed'))
      }
    })
    exec
      .exec(
        namespace(),
        podName,
        containerName,
        command,
        outputWriter, // capture stdout
        process.stderr,
        null,
        false /* tty */,
        status.callback
      )
      .then(ws =>
        rejectIfClosedWithoutStatus(
          ws,
          status.received,
          reject,
          'listing in the job pod'
        )
      )
      .catch(e => reject(e))
  })

  outputWriter.end()
  return output
}

// Runs a listing command on the runner and returns its stdout.
export async function localListing(commands: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(commands[0], commands.slice(1), {
      stdio: ['ignore', 'pipe', 'ignore']
    })

    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code: number) => {
      if (code === 0) {
        resolve(output)
      } else {
        reject(new Error(`listing on the runner exited with code ${code}`))
      }
    })
  })
}

export interface ListingDigest {
  hash: string
  files: number
}

// Hash of a `listDirAllCommand` listing. Lines are sorted first, because `find` order
// differs between filesystems and `find -exec {} +` batches.
export function digestListing(output: string): ListingDigest {
  const lines = output
    .split('\n')
    .filter(line => line.length > 0)
    .sort()
  const hash = createHash('sha256')
  hash.update(`${lines.join('\n')}\n`)
  return { hash: hash.digest('hex'), files: lines.length }
}

interface VerifyResult {
  verified: boolean
  runnerFiles?: number
  podFiles?: number
  verifyError?: string
  verifyMs: number
}

// One comparison of the two sides' listings after a copy. A mismatch or a failed listing
// is a visible warning, not a retry and not a job failure: upstream retried 15 times,
// silently, and then carried on anyway.
async function verifyCopy(
  description: string,
  runnerSide: () => Promise<string>,
  podSide: () => Promise<string>
): Promise<VerifyResult> {
  const timer = new Stopwatch()
  try {
    const [runnerOutput, podOutput] = await Promise.all([
      runnerSide(),
      podSide()
    ])
    const runner = digestListing(runnerOutput)
    const pod = digestListing(podOutput)
    const verified = runner.hash === pod.hash
    if (!verified) {
      core.warning(
        `${HOOK_LOG_PREFIX} ${description}: the files differ after the copy ` +
          `(runner: ${runner.files} files, job pod: ${pod.files} files). The job continues.`
      )
    }
    return {
      verified,
      runnerFiles: runner.files,
      podFiles: pod.files,
      verifyMs: timer.elapsedMs()
    }
  } catch (error) {
    const verifyError = formatError(error)
    core.warning(
      `${HOOK_LOG_PREFIX} ${description}: could not compare the files after the copy: ${verifyError}. The job continues.`
    )
    return { verified: false, verifyError, verifyMs: timer.elapsedMs() }
  }
}

// GNU tar run by a non-root job container cannot set the mode or times of directories it
// does not own (`/__w` itself, fs-init's workspace directory). It unpacks every file, then
// exits non-zero. Upstream discarded tar's status and stderr, so such containers work today;
// a failure whose stderr has only these errors is a success. Busybox tar does not report them.
const DIRECTORY_METADATA_ERRORS = [
  /: Cannot utime: Operation not permitted$/,
  /: Cannot change mode to \S+: Operation not permitted$/,
  /^tar: Exiting with failure status due to previous errors$/
]

export function onlyDirectoryMetadataErrors(stderr: string): boolean {
  const lines = stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  return (
    lines.length > 0 &&
    lines.every(line =>
      DIRECTORY_METADATA_ERRORS.some(pattern => pattern.test(line))
    )
  )
}

// Resolves when an exec'd copy command exits 0. A non-zero exit rejects with the command's
// stderr, so the caller retries the copy, unless the only errors are tar's directory
// metadata errors (see above). Stderr from a successful command is logged.
function settleCopyExec(
  description: string,
  errStream: CollectingStream,
  resolve: (value: unknown) => void,
  reject: (reason: Error) => void
): (status: k8s.V1Status) => void {
  return status => {
    const stderr = errStream.text().trim()
    if (status.status !== 'Success' && onlyDirectoryMetadataErrors(stderr)) {
      hookInfo(
        `${description}: tar could not set the mode or times of directories this user ` +
          'does not own; the files were copied'
      )
      resolve(status)
      return
    }
    if (status.status !== 'Success') {
      reject(
        new Error(
          `${description} failed: ${status.message || status.status}` +
            (stderr ? `; stderr: ${stderr}` : '')
        )
      )
      return
    }
    if (stderr) {
      hookInfo(`${description} printed to stderr: ${stderr}`)
    }
    resolve(status)
  }
}

const EXTRACT_FINISH_TIMEOUT_MS = 60000

// Resolves when a writable stream has emitted `finish`, rejects on `error` or after the
// timeout, so a stream that never finishes becomes a failed attempt instead of a hang.
export async function waitForFinish(
  writable: EventEmitter,
  timeoutMs: number
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`extracting did not finish in ${timeoutMs / 1000}s`)),
      timeoutMs
    )
    // A failed attempt's timer must not keep the hook process alive.
    timer.unref()
    writable.on('finish', () => {
      clearTimeout(timer)
      resolve()
    })
    writable.on('error', (error: Error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

// Shell command that unpacks the tar stream on stdin into containerPath, makes files and
// directories writable by the job container's user, and exits with tar's status (tar's
// stderr is kept). The chmods are best effort on purpose: a non-root job container cannot
// chmod directories it does not own (`/__w` itself, fs-init's workspace directory), and
// failing on that would break jobs that work today.
export function extractToPodCommand(containerPath: string): string {
  const target = shlex.quote(containerPath)
  return (
    `tar xf - --no-same-owner -C ${target}; status=$?; ` +
    `find ${target} -type f -exec chmod u+rw {} + 2>/dev/null; ` +
    `find ${target} -type d -exec chmod u+rwx {} + 2>/dev/null; ` +
    'exit $status'
  )
}

export async function execCpToPod(
  podName: string,
  runnerPath: string,
  containerPath: string
): Promise<CopyStats> {
  core.debug(`Copying ${runnerPath} to pod ${podName} at ${containerPath}`)
  const description = `copy ${runnerPath} to job pod ${containerPath}`

  const transferTimer = new Stopwatch()
  let counter = new TarEntryCounter()
  let attempt = 0
  while (true) {
    try {
      const exec = new k8s.Exec(kc)
      const command = ['sh', '-c', extractToPodCommand(containerPath)]
      counter = new TarEntryCounter()
      const readStream = tar.pack(runnerPath, { map: counter.map })
      const errStream = collectingStream()
      await new Promise((resolve, reject) => {
        const status = trackStatus(
          settleCopyExec(description, errStream, resolve, reject)
        )
        exec
          .exec(
            namespace(),
            podName,
            JOB_CONTAINER_NAME,
            command,
            null,
            errStream.stream,
            readStream,
            false,
            status.callback
          )
          .then(ws =>
            rejectIfClosedWithoutStatus(
              ws,
              status.received,
              reject,
              description
            )
          )
          .catch(e => reject(e))
      })
      break
    } catch (error) {
      core.debug(`cpToPod: Attempt ${attempt + 1} failed: ${error}`)
      attempt++
      if (attempt >= 30) {
        throw new Error(
          `cpToPod failed after ${attempt} attempts: ${formatError(error)}`
        )
      }
      await sleep(1000)
    }
  }
  const transferMs = transferTimer.elapsedMs()

  const verify = await verifyCopy(
    description,
    async () => localListing(['sh', '-c', listDirAllCommand(runnerPath)]),
    async () =>
      execListing(podName, JOB_CONTAINER_NAME, [
        'sh',
        '-c',
        listDirAllCommand(containerPath)
      ])
  )

  return {
    files: counter.files,
    bytes: counter.bytes,
    transferAttempts: attempt + 1,
    transferMs,
    ...verify
  }
}

export async function execCpFromPod(
  podName: string,
  containerPath: string,
  parentRunnerPath: string
): Promise<CopyStats> {
  const targetRunnerPath = `${parentRunnerPath}/${path.basename(containerPath)}`
  core.debug(
    `Copying from pod ${podName} ${containerPath} to ${targetRunnerPath}`
  )
  const description = `copy job pod ${containerPath} to ${targetRunnerPath}`

  const transferTimer = new Stopwatch()
  let counter = new TarEntryCounter()
  let attempt = 0
  while (true) {
    try {
      const exec = new k8s.Exec(kc)
      const containerPaths = containerPath.split('/')
      const dirname = containerPaths.pop() as string
      const command = [
        'tar',
        'cf',
        '-',
        '-C',
        containerPaths.join('/') || '/',
        dirname
      ]
      counter = new TarEntryCounter()
      const writerStream = tar.extract(parentRunnerPath, { map: counter.map })
      const errStream = collectingStream()
      // The exec's status arrives as soon as tar in the pod exits, while tar-fs may still be
      // writing what it received. Wait for tar-fs to finish too, or the runner reads files
      // (step outputs) that are not complete yet. Upstream's 15 hash retries hid this race.
      const extracted = waitForFinish(writerStream, EXTRACT_FINISH_TIMEOUT_MS)
      // Awaited below once the exec succeeded; when the exec fails first, nobody awaits it,
      // and an unhandled rejection would crash the hook.
      extracted.catch(() => undefined)

      await new Promise((resolve, reject) => {
        const status = trackStatus(
          settleCopyExec(description, errStream, resolve, reject)
        )
        exec
          .exec(
            namespace(),
            podName,
            JOB_CONTAINER_NAME,
            command,
            writerStream,
            errStream.stream,
            null,
            false,
            status.callback
          )
          .then(ws =>
            rejectIfClosedWithoutStatus(
              ws,
              status.received,
              reject,
              description
            )
          )
          .catch(e => reject(e))
      })
      await extracted
      break
    } catch (error) {
      core.debug(`Attempt ${attempt + 1} failed: ${error}`)
      attempt++
      if (attempt >= 30) {
        throw new Error(
          `execCpFromPod failed after ${attempt} attempts: ${formatError(error)}`
        )
      }
      await sleep(1000)
    }
  }
  const transferMs = transferTimer.elapsedMs()

  const verify = await verifyCopy(
    description,
    async () => localListing(['sh', '-c', listDirAllCommand(targetRunnerPath)]),
    async () =>
      execListing(podName, JOB_CONTAINER_NAME, [
        'sh',
        '-c',
        listDirAllCommand(containerPath)
      ])
  )

  return {
    files: counter.files,
    bytes: counter.bytes,
    transferAttempts: attempt + 1,
    transferMs,
    ...verify
  }
}

export async function createDockerSecret(
  registry: Registry
): Promise<k8s.V1Secret> {
  const authContent = {
    auths: {
      [registry.serverUrl || 'https://index.docker.io/v1/']: {
        username: registry.username,
        password: registry.password,
        auth: Buffer.from(`${registry.username}:${registry.password}`).toString(
          'base64'
        )
      }
    }
  }

  const runnerInstanceLabel = new RunnerInstanceLabel()

  const secretName = getSecretName()
  const secret = new k8s.V1Secret()
  secret.immutable = true
  secret.apiVersion = 'v1'
  secret.metadata = new k8s.V1ObjectMeta()
  secret.metadata.name = secretName
  secret.metadata.namespace = namespace()
  secret.metadata.labels = {
    [runnerInstanceLabel.key]: runnerInstanceLabel.value
  }
  secret.type = 'kubernetes.io/dockerconfigjson'
  secret.kind = 'Secret'
  secret.data = {
    '.dockerconfigjson': Buffer.from(JSON.stringify(authContent)).toString(
      'base64'
    )
  }

  return await k8sApi.createNamespacedSecret({
    namespace: namespace(),
    body: secret
  })
}

export async function deleteSecret(name: string): Promise<void> {
  await k8sApi.deleteNamespacedSecret({
    name,
    namespace: namespace()
  })
}

export async function pruneSecrets(): Promise<void> {
  const secretList = await k8sApi.listNamespacedSecret({
    namespace: namespace(),
    labelSelector: new RunnerInstanceLabel().toString()
  })
  if (!secretList.items.length) {
    return
  }

  await Promise.all(
    secretList.items.map(
      async secret =>
        secret.metadata?.name && (await deleteSecret(secret.metadata.name))
    )
  )
}

export async function waitForPodPhases(
  podName: string,
  awaitingPhases: Set<PodPhase>,
  backOffPhases: Set<PodPhase>,
  maxTimeSeconds = DEFAULT_WAIT_FOR_POD_TIME_SECONDS
): Promise<void> {
  const schedule = new PollSchedule()
  const timer = new Stopwatch()
  let phase: PodPhase = PodPhase.UNKNOWN
  try {
    while (true) {
      phase = await getPodPhase(podName)
      if (awaitingPhases.has(phase)) {
        return
      }

      if (!backOffPhases.has(phase)) {
        throw new Error(
          `Pod ${podName} is unhealthy with phase status ${phase}`
        )
      }
      // Wall-clock timeout: unlike upstream's sum of sleeps, it includes the API calls.
      if (maxTimeSeconds > 0 && timer.elapsedMs() >= maxTimeSeconds * 1000) {
        throw new Error(`timed out after ${maxTimeSeconds}s`)
      }
      await sleep(schedule.next())
    }
  } catch (error) {
    throw new Error(
      `Pod ${podName} is unhealthy with phase status ${phase}: ${formatError(error)}`
    )
  }
}

function apiErrorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'number' ? code : undefined
}

// Events about one pod. Needs `list` on `events` in the runner's Role, which ARC's
// kubernetes-mode Role does not grant: add it through
// containerMode.kubernetesModeAdditionalRoleRules.
export async function listPodEvents(
  podUid: string
): Promise<k8s.CoreV1Event[]> {
  const list = await k8sApi.listNamespacedEvent({
    namespace: namespace(),
    fieldSelector: `involvedObject.uid=${podUid}`
  })
  return list.items
}

const EVENTS_INTERVAL_MS = 2000

// Waits for the job pod to be Running, like waitForPodPhases, and shows what the pod is
// doing in the job log meanwhile (see pod-status.ts). Fails early when a container waits
// with a reason that does not resolve on its own (FailFastTracker).
export async function waitForJobPodRunning(
  podName: string,
  maxTimeSeconds: number,
  failFast: FailFastSettings
): Promise<void> {
  const schedule = new PollSchedule()
  const timer = new Stopwatch()
  const reporter = new PodStatusReporter(line => hookInfo(line))
  const tracker = new FailFastTracker(failFast)
  let canListEvents = true
  let lastEventsMs: number | undefined

  const showEvents = async (pod: k8s.V1Pod): Promise<void> => {
    const uid = pod.metadata?.uid
    if (!canListEvents || !uid) {
      return
    }
    lastEventsMs = Date.now()
    try {
      reporter.addEvents(pod, await listPodEvents(uid))
    } catch (error) {
      if (apiErrorCode(error) === 403) {
        canListEvents = false
        core.warning(
          `${HOOK_LOG_PREFIX} cannot list events in ${namespace()}, so only the pod's ` +
            'status is shown. Grant `get` and `list` on `events` to the runner to see them.'
        )
      } else {
        core.debug(`listing events failed: ${formatError(error)}`)
      }
    }
  }

  let phase: PodPhase = PodPhase.UNKNOWN
  try {
    while (true) {
      const pod = await getPodByName(podName)
      phase = podPhase(pod)
      if (
        lastEventsMs === undefined ||
        Date.now() - lastEventsMs >= EVENTS_INTERVAL_MS
      ) {
        await showEvents(pod)
      }
      reporter.observe(pod)

      if (phase === PodPhase.RUNNING) {
        await showEvents(pod)
        reporter.ready(pod)
        return
      }
      const failure = tracker.check(pod)
      if (failure) {
        await showEvents(pod)
        throw new Error(`failed fast: ${failure}`)
      }
      if (phase !== PodPhase.PENDING) {
        throw new Error(
          `Pod ${podName} is unhealthy with phase status ${phase}`
        )
      }
      if (maxTimeSeconds > 0 && timer.elapsedMs() >= maxTimeSeconds * 1000) {
        throw new Error(`timed out after ${maxTimeSeconds}s`)
      }
      await sleep(schedule.next())
    }
  } catch (error) {
    throw new Error(
      `Pod ${podName} is unhealthy with phase status ${phase}: ${formatError(error)}`
    )
  }
}

// How long to keep re-reading the pod after a failed step before concluding nothing
// happened to it. The exec session breaks the moment the kernel kills the container (an OOM
// kill takes the whole container on cgroup v2), but the kubelet reports it in the pod
// status a few seconds later. A plain non-zero exit, like a failing test, needs no wait.
export function troubleWaitMs(error: unknown): number {
  const match = /exit code (\d+)/.exec(formatError(error))
  if (match && match[1] !== '137') {
    return 0
  }
  // SIGKILL (137), or the session broke without an exit code.
  return 15000
}

// After a step failed: print, as errors, what happened to the job pod (OOM kill, eviction,
// the pod gone) and the pod's events since the step started. A plain step failure, like a
// failing test, changes nothing in the pod, so nothing is printed. Never throws.
export async function reportPodTrouble(
  podName: string,
  stepStartedMs: number,
  waitMs = 0
): Promise<void> {
  try {
    const timer = new Stopwatch()
    let pod: k8s.V1Pod
    let trouble: string[]
    while (true) {
      try {
        pod = await getPodByName(podName)
      } catch (error) {
        if (apiErrorCode(error) === 404) {
          core.error(`${HOOK_LOG_PREFIX} job pod ${podName} no longer exists`)
        } else {
          core.debug(`reading the job pod failed: ${formatError(error)}`)
        }
        return
      }
      trouble = renderPodTrouble(pod)
      if (trouble.length || timer.elapsedMs() >= waitMs) {
        break
      }
      await sleep(1000)
    }
    let events: k8s.CoreV1Event[] = []
    if (pod.metadata?.uid) {
      try {
        events = eventsSince(
          await listPodEvents(pod.metadata.uid),
          stepStartedMs
        )
      } catch (error) {
        core.debug(`listing events failed: ${formatError(error)}`)
      }
    }
    for (const line of [...trouble, ...events.map(renderEvent)]) {
      core.error(`${HOOK_LOG_PREFIX} ${line}`)
    }
  } catch (error) {
    core.debug(`reporting the job pod's state failed: ${formatError(error)}`)
  }
}

export function getPrepareJobTimeoutSeconds(): number {
  const envTimeoutSeconds =
    process.env['ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS']

  if (!envTimeoutSeconds) {
    return DEFAULT_WAIT_FOR_POD_TIME_SECONDS
  }

  const timeoutSeconds = parseInt(envTimeoutSeconds, 10)
  if (!timeoutSeconds || timeoutSeconds <= 0) {
    core.warning(
      `Prepare job timeout is invalid ("${timeoutSeconds}"): use an int > 0`
    )
    return DEFAULT_WAIT_FOR_POD_TIME_SECONDS
  }

  return timeoutSeconds
}

const POD_PHASES = new Set<string>([
  PodPhase.PENDING,
  PodPhase.RUNNING,
  PodPhase.SUCCEEDED,
  PodPhase.FAILED,
  PodPhase.UNKNOWN
])

function podPhase(pod: k8s.V1Pod): PodPhase {
  if (!pod.status?.phase || !POD_PHASES.has(pod.status.phase)) {
    return PodPhase.UNKNOWN
  }
  return pod.status.phase as PodPhase
}

async function getPodPhase(name: string): Promise<PodPhase> {
  const pod = await k8sApi.readNamespacedPod({
    name,
    namespace: namespace()
  })
  return podPhase(pod)
}

export async function prunePods(): Promise<void> {
  const podList = await k8sApi.listNamespacedPod({
    namespace: namespace(),
    labelSelector: new RunnerInstanceLabel().toString()
  })
  if (!podList.items.length) {
    return
  }

  await Promise.all(
    podList.items.map(
      async pod => pod.metadata?.name && (await deletePod(pod.metadata.name))
    )
  )
}

export async function isAuthPermissionsOK(): Promise<boolean> {
  const sar = new k8s.V1SelfSubjectAccessReview()
  const asyncs: Promise<k8s.V1SelfSubjectAccessReview>[] = []
  for (const resource of requiredPermissions) {
    for (const verb of resource.verbs) {
      sar.spec = new k8s.V1SelfSubjectAccessReviewSpec()
      sar.spec.resourceAttributes = new k8s.V1ResourceAttributes()
      sar.spec.resourceAttributes.verb = verb
      sar.spec.resourceAttributes.namespace = namespace()
      sar.spec.resourceAttributes.group = resource.group
      sar.spec.resourceAttributes.resource = resource.resource
      sar.spec.resourceAttributes.subresource = resource.subresource
      asyncs.push(
        k8sAuthorizationV1Api.createSelfSubjectAccessReview({ body: sar })
      )
    }
  }
  const responses = await Promise.all(asyncs)
  return responses.every(resp => resp.status?.allowed)
}

export async function isPodContainerAlpine(
  podName: string,
  containerName: string
): Promise<boolean> {
  let isAlpine = true
  try {
    await execPodStep(
      [
        'sh',
        '-c',
        `[ $(cat /etc/*release* | grep -i -e "^ID=*alpine*" -c) != 0 ] || exit 1`
      ],
      podName,
      containerName
    )
  } catch {
    isAlpine = false
  }

  return isAlpine
}

export function namespace(): string {
  if (process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']) {
    return process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  }

  const context = kc.getContexts().find(ctx => ctx.namespace)
  if (!context?.namespace) {
    throw new Error(
      'Failed to determine namespace, falling back to `default`. Namespace should be set in context, or in env variable "ACTIONS_RUNNER_KUBERNETES_NAMESPACE"'
    )
  }
  return context.namespace
}

export function containerPorts(
  container: ContainerInfo
): k8s.V1ContainerPort[] {
  const ports: k8s.V1ContainerPort[] = []
  if (!container.portMappings?.length) {
    return ports
  }
  for (const portDefinition of container.portMappings) {
    const portProtoSplit = portDefinition.split('/')
    if (portProtoSplit.length > 2) {
      throw new Error(`Unexpected port format: ${portDefinition}`)
    }

    const port = new k8s.V1ContainerPort()
    port.protocol =
      portProtoSplit.length === 2 ? portProtoSplit[1].toUpperCase() : 'TCP'

    const portSplit = portProtoSplit[0].split(':')
    if (portSplit.length > 2) {
      throw new Error('ports should have at most one ":" separator')
    }

    const parsePort = (p: string): number => {
      const num = Number(p)
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        throw new Error(`invalid container port: ${p}`)
      }
      return num
    }

    if (portSplit.length === 1) {
      port.containerPort = parsePort(portSplit[0])
    } else {
      port.hostPort = parsePort(portSplit[0])
      port.containerPort = parsePort(portSplit[1])
    }

    ports.push(port)
  }
  return ports
}

export async function getPodByName(name): Promise<k8s.V1Pod> {
  return await k8sApi.readNamespacedPod({
    name,
    namespace: namespace()
  })
}
