import type * as k8s from '@kubernetes/client-node'

// Pod status in the job log: what Kubernetes reports about the job pod while it starts,
// passed through as is. Nothing here maps reasons onto a list of known states, so a new
// event or reason (Karpenter, the scheduler, the kubelet, a CSI driver) shows up without a
// code change. Only fail fast names reasons, because only known reasons can be judged
// unrecoverable.

type Timestamp = Date | string | undefined | null

function toMs(value: Timestamp): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

// Whole seconds since `originMs`, never negative.
export function elapsedSeconds(originMs: number, atMs: number): number {
  return Math.max(0, Math.round((atMs - originMs) / 1000))
}

export function formatElapsed(seconds: number): string {
  return `${seconds}s`.padEnd(4)
}

export function podCreatedMs(pod: k8s.V1Pod): number | undefined {
  return toMs(pod.metadata?.creationTimestamp)
}

// ---- Events ----

// The time of an event's latest occurrence. Events from the events.k8s.io API (Karpenter)
// set only eventTime, and series.lastObservedTime when they repeat; core events set
// firstTimestamp and lastTimestamp.
export function eventTimeMs(event: k8s.CoreV1Event): number | undefined {
  return (
    toMs(event.series?.lastObservedTime) ??
    toMs(event.lastTimestamp) ??
    toMs(event.eventTime) ??
    toMs(event.firstTimestamp)
  )
}

export function eventCount(event: k8s.CoreV1Event): number {
  return event.series?.count ?? event.count ?? 1
}

export function renderEvent(event: k8s.CoreV1Event): string {
  const source =
    event.source?.component ||
    event.reportingComponent ||
    event.reportingInstance ||
    'unknown'
  const count = eventCount(event)
  const repeated = count > 1 ? ` (x${count})` : ''
  return (
    `${event.type || 'Unknown'} ${event.reason || 'Unknown'} (${source}): ` +
    `${(event.message || '').trim()}${repeated}`
  )
}

// Remembers which events were printed, so each is printed once, and again only when an
// aggregated event repeats (same name, higher count).
export class EventTracker {
  private readonly printed = new Map<string, number>()

  // The events not printed yet, oldest first.
  fresh(events: k8s.CoreV1Event[]): k8s.CoreV1Event[] {
    const result: k8s.CoreV1Event[] = []
    for (const event of events) {
      const key = event.metadata?.uid || event.metadata?.name
      if (!key) {
        continue
      }
      const count = eventCount(event)
      const seen = this.printed.get(key)
      if (seen !== undefined && seen >= count) {
        continue
      }
      this.printed.set(key, count)
      result.push(event)
    }
    return result.sort(
      (a, b) =>
        (eventTimeMs(a) ?? 0) - (eventTimeMs(b) ?? 0) ||
        (a.metadata?.name || '').localeCompare(b.metadata?.name || '')
    )
  }
}

// ---- Status ----

function renderContainerState(
  status: k8s.V1ContainerStatus,
  withMessages: boolean
): string {
  const state = status.state
  const message = (text?: string): string =>
    withMessages && text ? `: ${text.trim()}` : ''
  if (state?.waiting) {
    return (
      `${status.name} waiting ${state.waiting.reason || ''}`.trimEnd() +
      message(state.waiting.message)
    )
  }
  if (state?.running) {
    return `${status.name} running`
  }
  if (state?.terminated) {
    const t = state.terminated
    const reason = t.reason ? ` ${t.reason}` : ''
    return `${status.name} terminated${reason}, exit ${t.exitCode}${message(t.message)}`
  }
  return `${status.name} unknown`
}

// The pod's phase, every condition and every container's state (init containers first),
// rendered generically from the fields. Without messages for the heartbeat line.
export function renderStatus(pod: k8s.V1Pod, withMessages = true): string {
  const status = pod.status
  const parts = [`status: ${status?.phase || 'Unknown'}`]
  if (withMessages && status?.reason) {
    parts.push(
      `${status.reason}${status.message ? `: ${status.message.trim()}` : ''}`
    )
  }
  const conditions = (status?.conditions || []).map(condition => {
    let text = `${condition.type}=${condition.status}`
    if (condition.reason) {
      const message =
        withMessages && condition.message ? `: ${condition.message.trim()}` : ''
      text += ` (${condition.reason}${message})`
    }
    return text
  })
  if (conditions.length) {
    parts.push(conditions.join(', '))
  }
  const containers = [
    ...(status?.initContainerStatuses || []),
    ...(status?.containerStatuses || [])
  ].map(container => renderContainerState(container, withMessages))
  if (containers.length) {
    parts.push(containers.join(', '))
  }
  return parts.join('; ')
}

// Once the pod is Running: when each condition turned true and when each container
// started (and finished, for init containers), relative to pod creation. It shows where
// the time went without knowing what any of the conditions or containers mean.
export function renderReadyLine(pod: k8s.V1Pod, nowMs: number): string {
  const origin = podCreatedMs(pod) ?? nowMs
  const at = (ms: number): string => `+${elapsedSeconds(origin, ms)}s`
  const points: { ms: number; text: string }[] = []
  for (const condition of pod.status?.conditions || []) {
    const ms = toMs(condition.lastTransitionTime)
    if (condition.status === 'True' && ms !== undefined) {
      points.push({ ms, text: `${condition.type} ${at(ms)}` })
    }
  }
  for (const container of pod.status?.initContainerStatuses || []) {
    const started = toMs(container.state?.terminated?.startedAt)
    const finished = toMs(container.state?.terminated?.finishedAt)
    if (started !== undefined) {
      const end = finished !== undefined ? `..${at(finished)}` : ''
      points.push({
        ms: started,
        text: `${container.name} ${at(started)}${end}`
      })
    }
  }
  for (const container of pod.status?.containerStatuses || []) {
    const started = toMs(container.state?.running?.startedAt)
    if (started !== undefined) {
      points.push({ ms: started, text: `${container.name} ${at(started)}` })
    }
  }
  points.sort((a, b) => a.ms - b.ms)
  const after = elapsedSeconds(origin, nowMs)
  return `pod Running after ${after}s: ${points.map(p => p.text).join(', ')}`
}

// Prints status changes, a heartbeat while nothing changes, and new events, each line
// with the seconds since the pod was created.
export class PodStatusReporter {
  private readonly events = new EventTracker()
  private lastStatus = ''
  private lastPrintMs: number

  constructor(
    private readonly print: (line: string) => void,
    private readonly now: () => number = Date.now,
    private readonly heartbeatMs = 5000
  ) {
    this.lastPrintMs = now()
  }

  private line(pod: k8s.V1Pod, atMs: number, text: string): void {
    const origin = podCreatedMs(pod) ?? atMs
    this.print(`${formatElapsed(elapsedSeconds(origin, atMs))} ${text}`)
    this.lastPrintMs = this.now()
  }

  observe(pod: k8s.V1Pod): void {
    const now = this.now()
    const status = renderStatus(pod)
    if (status !== this.lastStatus) {
      this.lastStatus = status
      this.line(pod, now, status)
    } else if (now - this.lastPrintMs >= this.heartbeatMs) {
      this.line(pod, now, renderStatus(pod, false))
    }
  }

  addEvents(pod: k8s.V1Pod, events: k8s.CoreV1Event[]): void {
    for (const event of this.events.fresh(events)) {
      this.line(pod, eventTimeMs(event) ?? this.now(), renderEvent(event))
    }
  }

  ready(pod: k8s.V1Pod): void {
    this.print(renderReadyLine(pod, this.now()))
    this.lastPrintMs = this.now()
  }
}

// ---- Fail fast ----

// Waiting reasons that do not resolve on their own within a job's patience. Image pull
// errors alternate between ErrImagePull and ImagePullBackOff, so they share one period.
const FAIL_FAST_PERIODS: Record<string, string> = {
  ErrImagePull: 'image pull',
  ImagePullBackOff: 'image pull',
  CreateContainerConfigError: 'container config'
}
// The image is part of the pod spec and cannot change, so this fails at once.
const FAIL_AT_ONCE = new Set(['InvalidImageName'])

export interface FailFastSettings {
  enabled: boolean
  graceSeconds: number
}

interface Waiting {
  period: string
  sinceMs: number
  reason: string
  message: string
}

// Tracks, per container, how long it has been waiting with a fail-fast reason, and
// returns the reason to fail with once the grace period is over.
export class FailFastTracker {
  private readonly waiting = new Map<string, Waiting>()

  constructor(
    private readonly settings: FailFastSettings,
    private readonly now: () => number = Date.now
  ) {}

  check(pod: k8s.V1Pod): string | undefined {
    if (!this.settings.enabled) {
      return undefined
    }
    const now = this.now()
    const statuses = [
      ...(pod.status?.initContainerStatuses || []),
      ...(pod.status?.containerStatuses || [])
    ]
    for (const container of statuses) {
      const waiting = container.state?.waiting
      const reason = waiting?.reason || ''
      if (FAIL_AT_ONCE.has(reason)) {
        return describe(container.name, reason, waiting?.message, undefined)
      }
      const period = FAIL_FAST_PERIODS[reason]
      if (!period) {
        this.waiting.delete(container.name)
        continue
      }
      let entry = this.waiting.get(container.name)
      if (!entry || entry.period !== period) {
        entry = { period, sinceMs: now, reason, message: '' }
        this.waiting.set(container.name, entry)
      }
      entry.reason = reason
      // Keep ErrImagePull's message: it has the registry's error, while ImagePullBackOff
      // only says that the kubelet is backing off.
      if (waiting?.message && (reason === 'ErrImagePull' || !entry.message)) {
        entry.message = waiting.message
      }
      const waitedSeconds = (now - entry.sinceMs) / 1000
      if (waitedSeconds >= this.settings.graceSeconds) {
        return describe(
          container.name,
          entry.reason,
          entry.message,
          Math.round(waitedSeconds)
        )
      }
    }
    return undefined
  }
}

function describe(
  container: string,
  reason: string,
  message: string | undefined,
  seconds: number | undefined
): string {
  const duration = seconds === undefined ? '' : ` for ${seconds}s`
  const detail = message ? `: ${message.trim()}` : ''
  return `container ${container} has been ${reason}${duration}${detail}`
}

// ---- Settings ----

export const DEFAULT_FAIL_FAST = true
export const DEFAULT_FAIL_FAST_SECONDS = 60

export interface ResolvedSettings extends FailFastSettings {
  sources: { enabled: string; graceSeconds: string }
  warnings: string[]
}

type Env = Record<string, string | undefined>

// Each knob is read from the job container's env (`container.env` in the workflow) first,
// then from the runner's env (a scale-set default), then the built-in default. A malformed
// value is a warning and the default is used, as upstream does for the prepare-job timeout.
export function resolveFailFastSettings(
  jobEnv: Env | undefined,
  runnerEnv: Env,
  prepareTimeoutSeconds: number
): ResolvedSettings {
  const warnings: string[] = []
  const pick = (name: string): { value?: string; source: string } => {
    if (jobEnv?.[name] !== undefined && jobEnv[name] !== '') {
      return { value: jobEnv[name], source: 'job container env' }
    }
    if (runnerEnv[name] !== undefined && runnerEnv[name] !== '') {
      return { value: runnerEnv[name], source: 'runner env' }
    }
    return { source: 'default' }
  }

  const enabledRaw = pick('HOOK_FAIL_FAST')
  let enabled = DEFAULT_FAIL_FAST
  let enabledSource = enabledRaw.source
  if (enabledRaw.value !== undefined) {
    const value = enabledRaw.value.trim().toLowerCase()
    if (value === 'true' || value === 'false') {
      enabled = value === 'true'
    } else {
      warnings.push(
        `HOOK_FAIL_FAST from ${enabledRaw.source} is "${enabledRaw.value}", not true or false; using ${DEFAULT_FAIL_FAST}`
      )
      enabledSource = 'default'
    }
  }

  const graceRaw = pick('HOOK_FAIL_FAST_SECONDS')
  let graceSeconds = DEFAULT_FAIL_FAST_SECONDS
  let graceSource = graceRaw.source
  if (graceRaw.value !== undefined) {
    const value = graceRaw.value.trim()
    if (/^\d+$/.test(value)) {
      graceSeconds = parseInt(value, 10)
    } else {
      warnings.push(
        `HOOK_FAIL_FAST_SECONDS from ${graceRaw.source} is "${graceRaw.value}", not a whole number of seconds; using ${DEFAULT_FAIL_FAST_SECONDS}`
      )
      graceSource = 'default'
    }
  }
  if (enabled && graceSeconds >= prepareTimeoutSeconds) {
    warnings.push(
      `HOOK_FAIL_FAST_SECONDS is ${graceSeconds}, but the job pod must be Running within ` +
        `${prepareTimeoutSeconds}s (ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS), so that timeout comes first`
    )
  }

  return {
    enabled,
    graceSeconds,
    sources: { enabled: enabledSource, graceSeconds: graceSource },
    warnings
  }
}

export function renderSettings(settings: ResolvedSettings): string {
  return (
    `fail fast ${settings.enabled ? 'on' : 'off'} (${settings.sources.enabled}), ` +
    `grace period ${settings.graceSeconds}s (${settings.sources.graceSeconds})`
  )
}

// ---- Failed steps ----

// What looks wrong with the pod after a step failed: the pod's reason (Evicted), containers
// that are not running (with the memory limit for an OOM kill), and conditions that are
// not True. A plain step failure, like a failing test, leaves all of these as they were,
// so nothing is returned for it.
export function renderPodTrouble(pod: k8s.V1Pod): string[] {
  const lines: string[] = []
  const status = pod.status
  if (status?.phase && status.phase !== 'Running') {
    lines.push(`pod phase ${status.phase}`)
  }
  if (status?.reason) {
    lines.push(
      `pod ${status.reason}${status.message ? `: ${status.message.trim()}` : ''}`
    )
  }
  for (const container of status?.containerStatuses || []) {
    if (container.state?.running) {
      continue
    }
    let line = renderContainerState(container, true)
    if (container.state?.terminated?.reason === 'OOMKilled') {
      const spec = pod.spec?.containers?.find(c => c.name === container.name)
      const limit = spec?.resources?.limits?.memory
      line += limit ? ` (memory limit ${limit})` : ' (no memory limit set)'
    }
    lines.push(line)
  }
  for (const condition of status?.conditions || []) {
    if (condition.status !== 'True') {
      const reason = condition.reason ? ` (${condition.reason})` : ''
      const message = condition.message ? `: ${condition.message.trim()}` : ''
      lines.push(`${condition.type}=${condition.status}${reason}${message}`)
    }
  }
  return lines
}

// Events at or after the step started, allowing for clock skew between runner and API server.
export function eventsSince(
  events: k8s.CoreV1Event[],
  sinceMs: number,
  skewMs = 2000
): k8s.CoreV1Event[] {
  return new EventTracker()
    .fresh(events)
    .filter(event => (eventTimeMs(event) ?? 0) >= sinceMs - skewMs)
}
