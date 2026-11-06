import * as k8s from '@kubernetes/client-node'
import * as path from 'path'
import { JOB_CONTAINER_EXTENSION_NAME } from '../hooks/constants'
import { Env } from './settings'
import { ENV_HOOK_TEMPLATE_PATH, readExtension } from './utils'

// Per-job sizing. Upstream reads one fixed pod template per runner
// (ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE), so every job-pod size needs its own runner scale
// set. With per-job sizing, the job asks for its size in the job container's env
// (`container.env` in the workflow), and the hook builds the template from a base profile and
// those values, so one scale set serves every size.
//
// The job's values are read from the job container's env only, never from the runner's env:
// the runner's env holds the limits. Values are parsed strictly and never rounded, and any
// problem fails the job before a pod is created, with every problem named at once.

// What the job asks for (job container env).
export const JOB_MEMORY_ENV = 'HOOK_JOB_MEMORY'
export const JOB_CPU_ENV = 'HOOK_JOB_CPU'
export const JOB_DISK_ENV = 'HOOK_JOB_DISK'
export const JOB_ARCH_ENV = 'HOOK_JOB_ARCH'
export const JOB_PROFILE_ENV = 'HOOK_JOB_PROFILE'

const JOB_REQUEST_ENVS = [
  JOB_MEMORY_ENV,
  JOB_CPU_ENV,
  JOB_DISK_ENV,
  JOB_ARCH_ENV,
  JOB_PROFILE_ENV
]

// What the runner allows (runner env, set per scale set).
export const JOB_PROFILE_DIR_ENV = 'HOOK_JOB_PROFILE_DIR'
export const JOB_PROFILES_ENV = 'HOOK_JOB_PROFILES'
export const JOB_MAX_MEMORY_ENV = 'HOOK_JOB_MAX_MEMORY'
export const JOB_MAX_CPU_ENV = 'HOOK_JOB_MAX_CPU'
export const JOB_MAX_DISK_ENV = 'HOOK_JOB_MAX_DISK'
export const JOB_CPU_LIMIT_ENV = 'HOOK_JOB_CPU_LIMIT'

export const JOB_ARCHES = ['amd64', 'arm64'] as const
export type JobArch = (typeof JOB_ARCHES)[number]

export const DEFAULT_JOB_ARCH: JobArch = 'amd64'
export const DEFAULT_JOB_PROFILE = 'standard'

// Pod annotations with the requested values, so right-sizing queries can read them next to
// actual usage.
export const JOB_SIZE_ANNOTATION_PREFIX = 'custom-hook/'

export interface JobSize {
  memoryMiB: number
  cpuMillis: number
  // Ephemeral-storage request; undefined keeps the profile's.
  diskMiB?: number
  arch: JobArch
  profile: string
}

export interface JobSizeLimits {
  profileDir: string
  profiles: string[]
  maxMemoryMiB: number
  maxCpuMillis: number
  maxDiskMiB?: number
  // undefined: the job container gets no CPU limit.
  cpuLimitMillis?: number
}

export type JobTemplateSource =
  | { kind: 'per-job'; size: JobSize; limits: JobSizeLimits }
  | { kind: 'fixed'; path: string }
  | { kind: 'none' }

export class JobSizeError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '))
    this.name = 'JobSizeError'
    // Keeps `instanceof` working when the class is compiled to ES5 (as the tests are).
    Object.setPrototypeOf(this, JobSizeError.prototype)
  }
}

// A memory or disk quantity in Mi or Gi, as a whole number of MiB. `1.5Gi` is 1536 MiB;
// `0.3Gi` is not a whole number of MiB and is rejected rather than rounded. Returns an error
// message instead of a number when the value is not valid.
export function parseMebibytes(name: string, raw: string): number | string {
  const value = raw.trim()
  const match = /^(\d{1,7})(?:\.(\d{1,6}))?(Mi|Gi)$/.exec(value)
  if (!match) {
    return `${name} is "${raw}", not a quantity in Mi or Gi (e.g. 512Mi, 7Gi, 1.5Gi)`
  }
  const [, whole, fraction = '', unit] = match
  const perUnit = unit === 'Gi' ? 1024 : 1
  const scale = 10 ** fraction.length
  const scaled = (Number(whole) * scale + Number(fraction || '0')) * perUnit
  if (scaled % scale !== 0) {
    return `${name} is "${raw}", not a whole number of Mi`
  }
  const mebibytes = scaled / scale
  if (mebibytes <= 0) {
    return `${name} is "${raw}", must be more than zero`
  }
  return mebibytes
}

// CPU as a whole or decimal number of cores (`3`, `0.5`) or millicores (`500m`), as
// millicores. Finer than a millicore is rejected rather than rounded.
export function parseMillicores(name: string, raw: string): number | string {
  const value = raw.trim()
  const millis = /^(\d{1,7})m$/.exec(value)
  const cores = /^(\d{1,4})(?:\.(\d+))?$/.exec(value)
  let result: number
  if (millis) {
    result = Number(millis[1])
  } else if (cores) {
    const fraction = cores[2] ?? ''
    if (fraction.length > 3) {
      return `${name} is "${raw}", finer than a millicore (use at most 3 decimals)`
    }
    result = Number(cores[1]) * 1000 + Number(fraction.padEnd(3, '0'))
  } else {
    return `${name} is "${raw}", not a number of CPUs (e.g. 2, 0.5 or 500m)`
  }
  if (result <= 0) {
    return `${name} is "${raw}", must be more than zero`
  }
  return result
}

export function formatMebibytes(mebibytes: number): string {
  return mebibytes % 1024 === 0 ? `${mebibytes / 1024}Gi` : `${mebibytes}Mi`
}

export function formatMillicores(millis: number): string {
  return millis % 1000 === 0 ? `${millis / 1000}` : `${millis}m`
}

// Profile names become file names, so only a DNS-label-like name is accepted.
const PROFILE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function present(env: Env | undefined, name: string): string | undefined {
  const value = env?.[name]
  return value === undefined || value.trim() === '' ? undefined : value
}

// Decides where the job pod's template comes from:
// - the job container's env sets any HOOK_JOB_* request: per-job sizing, which the runner
//   must allow (HOOK_JOB_PROFILE_DIR and the limits);
// - otherwise the runner's fixed template, as upstream;
// - a runner with per-job sizing and no fixed template fails, naming what to set;
// - a runner with neither runs the job pod without a template, as upstream.
export function resolveJobTemplateSource(
  jobEnv: Env | undefined,
  runnerEnv: Env
): JobTemplateSource {
  const requested = JOB_REQUEST_ENVS.filter(n => present(jobEnv, n))
  const fixedPath = present(runnerEnv, ENV_HOOK_TEMPLATE_PATH)
  const runnerSizes = present(runnerEnv, JOB_PROFILE_DIR_ENV) !== undefined

  if (requested.length === 0) {
    if (fixedPath) {
      return { kind: 'fixed', path: fixedPath }
    }
    if (runnerSizes) {
      throw new JobSizeError([
        `this runner sizes each job pod from the job: set ${JOB_MEMORY_ENV} and ` +
          `${JOB_CPU_ENV} (and optionally ${JOB_DISK_ENV}, ${JOB_ARCH_ENV}, ` +
          `${JOB_PROFILE_ENV}) under container.env in the workflow`
      ])
    }
    return { kind: 'none' }
  }

  if (!runnerSizes) {
    throw new JobSizeError([
      `the job sets ${requested.join(', ')}, but this runner does not size job pods per ` +
        `job (${JOB_PROFILE_DIR_ENV} is not set on the runner); use a runner that does, ` +
        'or remove them from container.env'
    ])
  }

  const limits = resolveLimits(runnerEnv)
  const size = resolveSize(jobEnv ?? {}, limits)
  return { kind: 'per-job', size, limits }
}

function resolveLimits(runnerEnv: Env): JobSizeLimits {
  const problems: string[] = []
  const profileDir = present(runnerEnv, JOB_PROFILE_DIR_ENV) as string

  const profiles = (present(runnerEnv, JOB_PROFILES_ENV) ?? DEFAULT_JOB_PROFILE)
    .split(',')
    .map(p => p.trim())
    .filter(p => p !== '')
  for (const profile of profiles) {
    if (!PROFILE_NAME.test(profile)) {
      problems.push(
        `${JOB_PROFILES_ENV} lists "${profile}", not a valid profile name`
      )
    }
  }

  const required = (name: string, parse: typeof parseMebibytes): number => {
    const raw = present(runnerEnv, name)
    if (raw === undefined) {
      problems.push(`${name} is not set`)
      return 0
    }
    const parsed = parse(name, raw)
    if (typeof parsed === 'string') {
      problems.push(parsed)
      return 0
    }
    return parsed
  }
  const optional = (
    name: string,
    parse: typeof parseMebibytes
  ): number | undefined => {
    const raw = present(runnerEnv, name)
    if (raw === undefined) {
      return undefined
    }
    const parsed = parse(name, raw)
    if (typeof parsed === 'string') {
      problems.push(parsed)
      return undefined
    }
    return parsed
  }

  const maxMemoryMiB = required(JOB_MAX_MEMORY_ENV, parseMebibytes)
  const maxCpuMillis = required(JOB_MAX_CPU_ENV, parseMillicores)
  const maxDiskMiB = optional(JOB_MAX_DISK_ENV, parseMebibytes)
  const cpuLimitMillis = optional(JOB_CPU_LIMIT_ENV, parseMillicores)
  if (
    cpuLimitMillis !== undefined &&
    maxCpuMillis > 0 &&
    cpuLimitMillis < maxCpuMillis
  ) {
    // A request above the limit makes the API server reject the pod.
    problems.push(
      `${JOB_CPU_LIMIT_ENV} (${formatMillicores(cpuLimitMillis)}) is below ` +
        `${JOB_MAX_CPU_ENV} (${formatMillicores(maxCpuMillis)})`
    )
  }

  if (problems.length) {
    throw new JobSizeError(problems.map(p => `runner configuration: ${p}`))
  }
  return {
    profileDir,
    profiles,
    maxMemoryMiB,
    maxCpuMillis,
    maxDiskMiB,
    cpuLimitMillis
  }
}

function resolveSize(jobEnv: Env, limits: JobSizeLimits): JobSize {
  const problems: string[] = []

  const quantity = (
    name: string,
    parse: typeof parseMebibytes,
    max: number | undefined,
    maxName: string,
    format: (n: number) => string
  ): number | undefined => {
    const raw = present(jobEnv, name)
    if (raw === undefined) {
      return undefined
    }
    const parsed = parse(name, raw)
    if (typeof parsed === 'string') {
      problems.push(parsed)
      return undefined
    }
    if (max === undefined) {
      problems.push(
        `${name} is set, but this runner does not allow it (${maxName} is not set on the runner)`
      )
      return undefined
    }
    if (parsed > max) {
      problems.push(
        `${name} is ${format(parsed)}, more than this runner allows (${format(max)})`
      )
      return undefined
    }
    return parsed
  }

  const memoryMiB = quantity(
    JOB_MEMORY_ENV,
    parseMebibytes,
    limits.maxMemoryMiB,
    JOB_MAX_MEMORY_ENV,
    formatMebibytes
  )
  if (present(jobEnv, JOB_MEMORY_ENV) === undefined) {
    problems.push(`${JOB_MEMORY_ENV} is required`)
  }
  const cpuMillis = quantity(
    JOB_CPU_ENV,
    parseMillicores,
    limits.maxCpuMillis,
    JOB_MAX_CPU_ENV,
    formatMillicores
  )
  if (present(jobEnv, JOB_CPU_ENV) === undefined) {
    problems.push(`${JOB_CPU_ENV} is required`)
  }
  const diskMiB = quantity(
    JOB_DISK_ENV,
    parseMebibytes,
    limits.maxDiskMiB,
    JOB_MAX_DISK_ENV,
    formatMebibytes
  )

  let arch: JobArch = DEFAULT_JOB_ARCH
  const rawArch = present(jobEnv, JOB_ARCH_ENV)
  if (rawArch !== undefined) {
    const found = JOB_ARCHES.find(a => a === rawArch.trim())
    if (found) {
      arch = found
    } else {
      problems.push(
        `${JOB_ARCH_ENV} is "${rawArch}", not ${JOB_ARCHES.join(' or ')}`
      )
    }
  }

  let profile = DEFAULT_JOB_PROFILE
  const rawProfile = present(jobEnv, JOB_PROFILE_ENV)
  if (rawProfile !== undefined) {
    profile = rawProfile.trim()
  }
  if (!limits.profiles.includes(profile)) {
    problems.push(
      `${JOB_PROFILE_ENV} is "${profile}", not one this runner allows ` +
        `(${limits.profiles.join(', ')})`
    )
  }

  if (problems.length) {
    throw new JobSizeError(problems)
  }
  return {
    memoryMiB: memoryMiB as number,
    cpuMillis: cpuMillis as number,
    diskMiB,
    arch,
    profile
  }
}

export function profilePath(limits: JobSizeLimits, profile: string): string {
  return path.join(limits.profileDir, `profile-${profile}.yaml`)
}

// The profile's template with the job's size applied. The hook owns the job container's
// memory and CPU: the profile's values for them are replaced (memory request = limit, never
// overcommitted; the CPU limit is HOOK_JOB_CPU_LIMIT, or none). The ephemeral-storage request
// is the profile's unless the job sets HOOK_JOB_DISK. The architecture selector is the job's.
export function applyJobSize(
  profile: k8s.V1PodTemplateSpec,
  size: JobSize,
  limits: JobSizeLimits
): k8s.V1PodTemplateSpec {
  const template: k8s.V1PodTemplateSpec = structuredClone(profile)
  template.spec = template.spec ?? ({ containers: [] } as k8s.V1PodSpec)
  template.spec.containers = template.spec.containers ?? []

  let job = template.spec.containers.find(
    c => c.name === JOB_CONTAINER_EXTENSION_NAME
  )
  if (!job) {
    job = { name: JOB_CONTAINER_EXTENSION_NAME }
    template.spec.containers.push(job)
  }

  const memory = formatMebibytes(size.memoryMiB)
  const requests: Record<string, string> = {
    ...(job.resources?.requests as Record<string, string> | undefined),
    memory,
    cpu: formatMillicores(size.cpuMillis)
  }
  if (size.diskMiB !== undefined) {
    requests['ephemeral-storage'] = formatMebibytes(size.diskMiB)
  }
  const jobLimits: Record<string, string> = {
    ...(job.resources?.limits as Record<string, string> | undefined),
    memory
  }
  if (limits.cpuLimitMillis !== undefined) {
    jobLimits.cpu = formatMillicores(limits.cpuLimitMillis)
  } else {
    delete jobLimits.cpu
  }
  job.resources = { ...job.resources, requests, limits: jobLimits }

  template.spec.nodeSelector = {
    ...template.spec.nodeSelector,
    'kubernetes.io/arch': size.arch
  }

  template.metadata = template.metadata ?? {}
  template.metadata.annotations = {
    ...template.metadata.annotations,
    ...jobSizeAnnotations(size)
  }
  return template
}

export function jobSizeAnnotations(size: JobSize): Record<string, string> {
  const annotations: Record<string, string> = {
    [`${JOB_SIZE_ANNOTATION_PREFIX}memory`]: formatMebibytes(size.memoryMiB),
    [`${JOB_SIZE_ANNOTATION_PREFIX}cpu`]: formatMillicores(size.cpuMillis),
    [`${JOB_SIZE_ANNOTATION_PREFIX}arch`]: size.arch,
    [`${JOB_SIZE_ANNOTATION_PREFIX}profile`]: size.profile
  }
  if (size.diskMiB !== undefined) {
    annotations[`${JOB_SIZE_ANNOTATION_PREFIX}disk`] = formatMebibytes(
      size.diskMiB
    )
  }
  return annotations
}

export function formatJobSize(size: JobSize, limits: JobSizeLimits): string {
  const cpuLimit =
    limits.cpuLimitMillis === undefined
      ? 'no limit'
      : `limit ${formatMillicores(limits.cpuLimitMillis)}`
  const disk =
    size.diskMiB === undefined
      ? 'disk from profile'
      : `disk ${formatMebibytes(size.diskMiB)}`
  return (
    `job pod sized from the job: memory ${formatMebibytes(size.memoryMiB)}, ` +
    `cpu ${formatMillicores(size.cpuMillis)} (${cpuLimit}), ${disk}, ` +
    `arch ${size.arch}, profile ${size.profile}`
  )
}

// The template the job pod is built from, and a line for the job log (undefined when the
// hook behaves as upstream). Throws JobSizeError for anything the job or runner got wrong.
export function loadJobTemplate(
  jobEnv: Env | undefined,
  runnerEnv: Env
): { template?: k8s.V1PodTemplateSpec; log?: string } {
  const source = resolveJobTemplateSource(jobEnv, runnerEnv)
  if (source.kind === 'none') {
    return {}
  }
  if (source.kind === 'fixed') {
    return { template: readExtension(source.path) }
  }
  const file = profilePath(source.limits, source.size.profile)
  let profile: k8s.V1PodTemplateSpec
  try {
    profile = readExtension(file)
  } catch (error) {
    throw new JobSizeError([
      `runner configuration: cannot read profile ${source.size.profile} from ${file}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    ])
  }
  return {
    template: applyJobSize(profile, source.size, source.limits),
    log: formatJobSize(source.size, source.limits)
  }
}
