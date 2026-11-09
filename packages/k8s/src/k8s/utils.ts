import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import * as core from '@actions/core'
import { randomUUID } from 'crypto'
import { CONTAINER_EXTENSION_PREFIX } from '../hooks/constants'
import * as shlex from 'shlex'
import { Mount } from 'hooklib'

export const DEFAULT_CONTAINER_ENTRY_POINT_ARGS = [`-f`, `/dev/null`]
export const DEFAULT_CONTAINER_ENTRY_POINT = 'tail'

export const ENV_HOOK_TEMPLATE_PATH = 'ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE'

export const EXTERNALS_VOLUME_NAME = 'externals'
export const GITHUB_VOLUME_NAME = 'github'
export const WORK_VOLUME = 'work'

export const CONTAINER_VOLUMES: k8s.V1VolumeMount[] = [
  {
    name: EXTERNALS_VOLUME_NAME,
    mountPath: '/__e'
  },
  {
    name: WORK_VOLUME,
    mountPath: '/__w'
  },
  {
    name: GITHUB_VOLUME_NAME,
    mountPath: '/github'
  }
]

// `/github/workflow` (`GITHUB_EVENT_PATH` is `/github/workflow/event.json`) and `/github/home`
// are links into `_temp`, where the runner writes them and where every step's `_temp` sync
// updates them, so the job container always sees the current files. fs-init creates them in
// the `/github` volume (mounted at `githubDir`); the absolute targets resolve in the job
// container. Upstream copied the two directories once, and only for jobs that declared
// `container.volumes` (actions/runner-container-hooks#330), so other jobs had no event file.
// `ln -sfn` replaces an existing link, so a pod template's postStart that creates the same
// links still works.
export function githubLinkCommands(githubDir: string): string[] {
  return [
    `ln -sfn /__w/_temp/_github_workflow ${githubDir}/workflow`,
    `ln -sfn /__w/_temp/_github_home ${githubDir}/home`
  ]
}

export function prepareJobScript(userVolumeMounts: Mount[]): {
  containerPath: string
  runnerPath: string
} {
  let mountDirs = userVolumeMounts.map(m => m.targetVolumePath).join(' ')

  const content = `#!/bin/sh -l
set -e
mkdir -p ${mountDirs}
`

  const filename = `${randomUUID()}.sh`
  const entryPointPath = `${process.env.RUNNER_TEMP}/${filename}`
  fs.writeFileSync(entryPointPath, content)
  return {
    containerPath: `/__w/_temp/${filename}`,
    runnerPath: entryPointPath
  }
}

export function writeRunScript(
  workingDirectory: string,
  entryPoint: string,
  entryPointArgs?: string[],
  prependPath?: string[],
  environmentVariables?: { [key: string]: string }
): { containerPath: string; runnerPath: string } {
  let exportPath = ''
  if (prependPath?.length) {
    // TODO: remove compatibility with typeof prependPath === 'string' as we bump to next major version, the hooks will lose PrependPath compat with runners 2.293.0 and older
    const prepend =
      typeof prependPath === 'string' ? prependPath : prependPath.join(':')
    exportPath = `export PATH=${prepend}:$PATH`
  }

  let environmentPrefix = scriptEnv(environmentVariables)

  const content = `#!/bin/sh -l
set -e
rm "$0" # remove script after running
${exportPath}
cd ${workingDirectory} && \
exec ${environmentPrefix} ${entryPoint} ${
    entryPointArgs?.length ? entryPointArgs.join(' ') : ''
  }
`
  const filename = `${randomUUID()}.sh`
  const entryPointPath = `${process.env.RUNNER_TEMP}/${filename}`
  fs.writeFileSync(entryPointPath, content)
  return {
    containerPath: `/__w/_temp/${filename}`,
    runnerPath: entryPointPath
  }
}

export function writeContainerStepScript(
  dst: string,
  workingDirectory: string,
  entryPoint: string,
  entryPointArgs?: string[],
  environmentVariables?: { [key: string]: string }
): { containerPath: string; runnerPath: string } {
  let environmentPrefix = scriptEnv(environmentVariables)

  const parts = workingDirectory.split('/').slice(-2)
  if (parts.length !== 2) {
    throw new Error(`Invalid working directory: ${workingDirectory}`)
  }

  const content = `#!/bin/sh -l
rm "$0" # remove script after running
mv /__w/_temp/_github_home /github/home && \
mv /__w/_temp/_github_workflow /github/workflow && \
mv /__w/_temp/_runner_file_commands /github/file_commands || true && \
mv /__w/${parts.join('/')}/ /github/workspace && \
cd /github/workspace && \
exec ${environmentPrefix} ${entryPoint} ${
    entryPointArgs?.length ? entryPointArgs.join(' ') : ''
  }
`
  const filename = `${randomUUID()}.sh`
  const entryPointPath = `${dst}/${filename}`
  core.debug(`Writing container step script to ${entryPointPath}`)
  fs.writeFileSync(entryPointPath, content)
  return {
    containerPath: `/__w/_temp/${filename}`,
    runnerPath: entryPointPath
  }
}

function scriptEnv(envs?: { [key: string]: string }): string {
  if (!envs || !Object.entries(envs).length) {
    return ''
  }
  const envBuffer: string[] = []
  for (const [key, value] of Object.entries(envs)) {
    if (
      key.includes(`=`) ||
      key.includes(`'`) ||
      key.includes(`"`) ||
      key.includes(`$`)
    ) {
      throw new Error(
        `environment key ${key} is invalid - the key must not contain =, $, ', or "`
      )
    }
    envBuffer.push(
      `"${key}=${value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`')}"`
    )
  }

  if (!envBuffer?.length) {
    return ''
  }

  return `env ${envBuffer.join(' ')} `
}

export function generateContainerName(image: string): string {
  const nameWithTag = image.split('/').pop()
  const name = nameWithTag?.split(':')[0]

  if (!name) {
    throw new Error(`Image definition '${image}' is invalid`)
  }

  return name
}

// Overwrite or append based on container options
//
// Keep in mind, envs and volumes could be passed as fields in container definition
// so default volume mounts and envs are appended first, and then create options are used
// to append more values
//
// Rest of the fields are just applied
// For example, container.createOptions.container.image is going to overwrite container.image field
export function mergeContainerWithOptions(
  base: k8s.V1Container,
  from: k8s.V1Container
): void {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'name') {
      if (value !== CONTAINER_EXTENSION_PREFIX + base.name) {
        core.warning("Skipping name override: name can't be overwritten")
      }
      continue
    } else if (key === 'image') {
      core.warning("Skipping image override: image can't be overwritten")
      continue
    } else if (key === 'env') {
      const envs = value as k8s.V1EnvVar[]
      base.env = mergeLists(base.env, envs)
    } else if (key === 'volumeMounts' && value) {
      const volumeMounts = value as k8s.V1VolumeMount[]
      base.volumeMounts = mergeLists(base.volumeMounts, volumeMounts)
    } else if (key === 'ports' && value) {
      const ports = value as k8s.V1ContainerPort[]
      base.ports = mergeLists(base.ports, ports)
    } else {
      base[key] = value
    }
  }
}

export function mergePodSpecWithOptions(
  base: k8s.V1PodSpec,
  from: k8s.V1PodSpec
): void {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'containers') {
      base.containers.push(
        ...from.containers.filter(
          e => !e.name?.startsWith(CONTAINER_EXTENSION_PREFIX)
        )
      )
    } else if (key === 'volumes' && value) {
      const volumes = value as k8s.V1Volume[]
      base.volumes = mergeLists(base.volumes, volumes)
    } else if (key === 'initContainers' && value) {
      base.initContainers = mergeInitContainers(
        base.initContainers,
        value as k8s.V1Container[]
      )
    } else {
      base[key] = value
    }
  }
}

export function mergeObjectMeta(
  base: { metadata?: k8s.V1ObjectMeta },
  from: k8s.V1ObjectMeta
): void {
  if (!base.metadata?.labels || !base.metadata?.annotations) {
    throw new Error(
      "Can't merge metadata: base.metadata or base.annotations field is undefined"
    )
  }
  if (from?.labels) {
    for (const [key, value] of Object.entries(from.labels)) {
      if (base.metadata?.labels?.[key]) {
        core.warning(`Label ${key} is already defined and will be overwritten`)
      }
      base.metadata.labels[key] = value
    }
  }

  if (from?.annotations) {
    for (const [key, value] of Object.entries(from.annotations)) {
      if (base.metadata?.annotations?.[key]) {
        core.warning(
          `Annotation ${key} is already defined and will be overwritten`
        )
      }
      base.metadata.annotations[key] = value
    }
  }
}

export function readExtensionFromFile(): k8s.V1PodTemplateSpec | undefined {
  const filePath = process.env[ENV_HOOK_TEMPLATE_PATH]
  if (!filePath) {
    return undefined
  }
  return readExtension(filePath)
}

export function readExtension(filePath: string): k8s.V1PodTemplateSpec {
  const doc = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!doc || typeof doc !== 'object') {
    throw new Error(`Failed to parse ${filePath}`)
  }
  return doc as k8s.V1PodTemplateSpec
}

export enum PodPhase {
  PENDING = 'Pending',
  RUNNING = 'Running',
  SUCCEEDED = 'Succeeded',
  FAILED = 'Failed',
  UNKNOWN = 'Unknown',
  COMPLETED = 'Completed'
}

// A template's init containers run after the hook's own (`fs-init`, which sets up `_work`,
// `/__e` and `/github`). Replacing them, as upstream did, left every job pod without its
// workspace (actions/runner-container-hooks#347).
export function mergeInitContainers(
  base: k8s.V1Container[] | undefined,
  from: k8s.V1Container[]
): k8s.V1Container[] {
  const own = new Set((base ?? []).map(c => c.name))
  const clashes = from.filter(c => own.has(c.name)).map(c => c.name)
  if (clashes.length) {
    throw new Error(
      `the pod template's init container name ${clashes.join(', ')} is used by the hook; rename it in the template`
    )
  }
  return [...(base ?? []), ...from]
}

function mergeLists<T>(base?: T[], from?: T[]): T[] {
  const b: T[] = base || []
  if (!from?.length) {
    return b
  }
  b.push(...from)
  return b
}

export function fixArgs(args: string[]): string[] {
  // Preserve shell command strings passed via `sh -c` without re-tokenizing.
  // Retokenizing would split the script into multiple args, breaking `sh -c`.
  if (args.length >= 2 && args[0] === 'sh' && args[1] === '-c') {
    return args
  }
  return shlex.split(args.join(' '))
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// `{} +` runs one `stat` for many files instead of one per file (11k files: ~10s -> ~0.1s).
// Callers sort the output before hashing, so the batching does not change the hash.
export function listDirAllCommand(dir: string): string {
  return `cd ${shlex.quote(dir)} && find . -type f -not -path '*/_runner_hook_responses*' -exec stat -c '%s %n' {} +`
}

// Shell script that merges the `_temp` copied from the runner (src) into the job pod's
// `_temp` (dst), then removes src: `_runner_file_commands` is overwritten as a whole, every
// other file is copied over its counterpart. One `sh` handles a batch of files (`{} +`).
export function mergeTempCommand(src: string, dst: string): string {
  return [
    'set -e',
    `SRC=${shlex.quote(src)}`,
    `DST=${shlex.quote(dst)}`,
    'mkdir -p "$DST" "$SRC"',
    'cp -a "$SRC/_runner_file_commands/." "$DST/_runner_file_commands"',
    `find "$SRC" -type f ! -path "*/_runner_file_commands/*" -exec sh -c '
    src="$1"; dst="$2"; shift 2
    for f; do
      rel="\${f#$src/}"
      target="$dst/$rel"
      mkdir -p "$(dirname "$target")"
      cp -a "$f" "$target"
    done
  ' _ "$SRC" "$DST" {} +`,
    'rm -rf "$SRC"'
  ].join(' && ')
}

// Safely turn an unknown thrown value into a diagnostic string without
// throwing. The previous `JSON.stringify(err)` pattern crashed with
// `TypeError: Converting circular structure to JSON` when err was a
// @kubernetes/client-node HTTP error (its response embeds a
// TLSSocket <-> HTTPParser cycle). The thrown TypeError shadowed the
// original failure in every catch block that used it (issue #329).
export function formatError(err: unknown): string {
  if (err === null || err === undefined) {
    return String(err)
  }

  // @kubernetes/client-node API errors expose the actual server message
  // under response.body — prefer that when available.
  const body =
    (err as { response?: { body?: unknown } })?.response?.body ??
    (err as { body?: unknown })?.body
  if (body && typeof body === 'object') {
    const msg = (body as { message?: unknown }).message
    const reason = (body as { reason?: unknown }).reason
    if (typeof msg === 'string') {
      return typeof reason === 'string' && reason.length > 0
        ? `${msg} (reason: ${reason})`
        : msg
    }
  }

  if (err instanceof Error) {
    return err.message
  }

  if (typeof err === 'object') {
    // Non-Error objects sometimes carry a top-level message (axios-style
    // errors, hand-rolled error-likes). Extract before the JSON.stringify
    // branch so a circular ref doesn't reduce the diagnostic to
    // "[object Object]".
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string') {
      return msg
    }
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }

  // Primitives serialise more readably via String() than JSON.stringify
  // (which would quote strings and refuse to handle symbols).
  return String(err)
}
