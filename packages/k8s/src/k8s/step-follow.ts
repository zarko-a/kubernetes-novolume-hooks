import * as stream from 'stream'
import { execExitCode } from './exec-status'
import { formatSeconds, hookInfo } from './hook-log'
import { STEP_NOT_LAUNCHED_EXIT } from './step-supervisor'
import { formatError } from './utils'

// The hook's side of a detached step (see step-supervisor.ts): run the launch in one exec
// session, count the output bytes as they arrive, and when the session breaks, resume with
// `follow` from those counts until the step's exit code arrives or the reconnect budget runs
// out.

export interface ExecSession {
  // Test only: cut the session after this long.
  dropAfterMs?: number
  // Called once the session's connection is open.
  onOpen?: () => void
  // Write a byte a second to the command's stdin for as long as the session lasts: how the
  // process reading a step's output knows the hook is still there (step-supervisor.ts).
  heartbeat?: boolean
}

// Runs a shell command in the job container with its output to the given streams. Resolves
// when it exits 0; rejects with an error execExitCode can read when it exits non-zero, and
// with any other error when the exec session broke.
export type StepExec = (
  command: string,
  stdout: stream.Writable,
  stderr: stream.Writable,
  session?: ExecSession
) => Promise<void>

export interface DetachedStepDeps {
  exec: StepExec
  // Why the job container cannot run the step any more, or undefined (see
  // jobContainerEnded in index.ts).
  jobContainerEnded: () => Promise<string | undefined>
  // The step server has had a request: the step was launched.
  contacted: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  // Calls back after ms, unless the function it returns is called first.
  setTimer: (ms: number, callback: () => void) => () => void
  stdout: stream.Writable
  stderr: stream.Writable
}

export interface DetachedStepOptions {
  launch: string
  follow: (stdoutOffset: number, stderrOffset: number) => string
  // Prints `exit <code>`, `running` or `gone` (stepStatusCommand).
  status: string
  // For each loss of the connection, not for the step as a whole.
  reconnectMs: number
  // Test only: drop each session that runs or reads the step after this long, so a step
  // longer than twice this loses its connection more than once.
  dropAfterMs?: number
}

// The job container ended (an OOM kill takes the whole container): nothing of the step runs.
export class JobContainerEndedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobContainerEndedError'
    // The ES5 target breaks subclassing Error: without this, instanceof is false.
    Object.setPrototypeOf(this, JobContainerEndedError.prototype)
  }
}

// A reconnect counts once its session has delivered output or stayed open this long. A
// session that opens and breaks at once (an API server that cannot reach the kubelet yet)
// is one more failed attempt, and does not renew the reconnect budget.
export const ESTABLISHED_AFTER_MS = 2000

// How many seconds the hook gives the kubelet to report that the job container ended, when
// the reader's exit code suggests it.
export const CONTAINER_END_WAITS = 3

// How often the hook reads on after the session reading the output ended with a signal's
// exit code while the step had recorded none.
export const MAX_REREADS = 5

class Receiver extends stream.Writable {
  constructor(private readonly receive: (chunk: Buffer) => void) {
    super()
  }

  _write(
    chunk: Buffer,
    _encoding: string,
    callback: (error?: Error | null) => void
  ): void {
    this.receive(chunk)
    callback()
  }
}

// The step's stdout on its way to the job log, and the hook's own lines about the
// connection. Those wait for the end of the step's current line: written in the middle of
// one, they would split it, and a split workflow command (`::add-mask::`) is not one.
class LineGate {
  private midLine = false
  private waiting: string[] = []

  constructor(private readonly target: stream.Writable) {}

  write(chunk: Buffer): void {
    let rest = chunk
    if (this.waiting.length) {
      const newline = rest.indexOf(10)
      if (newline >= 0) {
        this.target.write(rest.subarray(0, newline + 1))
        this.midLine = false
        rest = rest.subarray(newline + 1)
        this.release()
      }
    }
    if (rest.length) {
      this.target.write(rest)
      this.midLine = rest[rest.length - 1] !== 10
    }
  }

  note(message: string): void {
    if (this.midLine) {
      this.waiting.push(message)
    } else {
      hookInfo(message)
    }
  }

  // The step's output is over: end its last line, if it left one open, and say what waited.
  close(): void {
    if (this.waiting.length && this.midLine) {
      this.target.write('\n')
      this.midLine = false
    }
    this.release()
  }

  private release(): void {
    for (const message of this.waiting.splice(0)) {
      hookInfo(message)
    }
  }
}

// 128 + a signal number: how a shell, and the kubelet, report a process a signal ended.
function isSignalExit(code: number): boolean {
  return code > 128 && code <= 128 + 64
}

// 1s, 2s, 4s, then every 5s.
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 5000)
}

// Resolves when the step exited 0. Rejects with the session's error when it exited
// non-zero (execExitCode reads the code), with a JobContainerEndedError when the job
// container is gone, or with a plain error when the connection could not be restored.
export async function runDetachedStep(
  deps: DetachedStepDeps,
  options: DetachedStepOptions
): Promise<void> {
  const received = { stdout: 0, stderr: 0 }
  const log = new LineGate(deps.stdout)
  let launch = true
  let lostAt: number | undefined
  let failures = 0
  let rereads = 0

  // The connection is back: say so, and the next loss gets a full budget again.
  const established = (): void => {
    if (lostAt === undefined) {
      return
    }
    log.note(
      `reconnected to the step after ${formatSeconds(deps.now() - lostAt)}` +
        (failures
          ? ` (${failures} failed attempt${failures === 1 ? '' : 's'})`
          : '') +
        '; its output resumes where it stopped'
    )
    lostAt = undefined
    failures = 0
  }

  // What the step has recorded, or undefined when that could not be read.
  const stepState = async (): Promise<string | undefined> => {
    let answer = ''
    try {
      await deps.exec(
        options.status,
        new Receiver(chunk => (answer += chunk.toString())),
        new Receiver(() => undefined)
      )
    } catch {
      return undefined
    }
    answer = answer.trim()
    return /^(exit \d+|running$|gone$)/.test(answer) ? answer : undefined
  }

  while (true) {
    const command = launch
      ? options.launch
      : options.follow(received.stdout, received.stderr)
    // Once a session has ended, nothing it still delivers counts: the next session reads
    // from the offsets as they were then.
    let over = false
    let cancelTimer: (() => void) | undefined
    const end = (): void => {
      over = true
      cancelTimer?.()
    }
    const alive = (): void => {
      if (!over) {
        established()
      }
    }
    try {
      await deps.exec(
        command,
        new Receiver(chunk => {
          if (!over) {
            received.stdout += chunk.length
            established()
            log.write(chunk)
          }
        }),
        new Receiver(chunk => {
          if (!over) {
            received.stderr += chunk.length
            established()
            deps.stderr.write(chunk)
          }
        }),
        {
          dropAfterMs: options.dropAfterMs,
          heartbeat: true,
          onOpen: () => {
            if (!over && lostAt !== undefined) {
              cancelTimer = deps.setTimer(ESTABLISHED_AFTER_MS, alive)
            }
          }
        }
      )
      end()
      established()
      log.close()
      return
    } catch (error) {
      end()
      const code = execExitCode(error)
      if (code === STEP_NOT_LAUNCHED_EXIT && !launch && !deps.contacted()) {
        // The step's directory does not exist and nothing ever reached the step server:
        // the launch never ran (the session broke before its command started). Launching
        // again cannot run the step twice: its supervisor takes a lock (step-supervisor.ts).
        launch = true
        continue
      }
      let problem = formatError(error)
      if (code !== undefined) {
        // 128+n is also what the kubelet reports when the process reading the output was
        // killed by signal n (something in the job ran `pkill -9 node`), with the step
        // still running. Believe it only if the step recorded it.
        const state = isSignalExit(code) ? await stepState() : `exit ${code}`
        if (state?.startsWith(`exit ${code}`)) {
          established()
          log.close()
          throw error
        }
        if (state !== undefined) {
          rereads++
          if (rereads > MAX_REREADS) {
            log.close()
            throw new Error(
              `the session reading the step's output ended ${rereads} times with a ` +
                `signal's exit code (last: ${code}) while the step had recorded none`
            )
          }
          log.note(
            `the session reading the step's output ended with exit code ${code}, which ` +
              'the step has not recorded (something in the job killed the reader); ' +
              'reading on'
          )
          launch = false
          continue
        }
        problem = `${problem}, and what the step recorded could not be read`
      }
      // A session that breaks because the container is gone (an OOM kill takes the whole
      // container) is not a connection problem: say so, and do not wait for a reconnect.
      let ended = await deps.jobContainerEnded()
      // The reader ended with a signal's exit code and nothing answers for the step: most
      // likely the OOM killer took the container, which the kubelet reports a moment
      // later. Wait for that before calling it a lost connection.
      for (
        let waits = 0;
        code !== undefined && !ended && waits < CONTAINER_END_WAITS;
        waits++
      ) {
        await deps.sleep(1000)
        ended = await deps.jobContainerEnded()
      }
      if (ended) {
        log.close()
        throw new JobContainerEndedError(
          `the job container is no longer running (${ended}); ` +
            (deps.contacted()
              ? 'the step ended with it'
              : 'this step cannot run')
        )
      }
      if (lostAt === undefined) {
        lostAt = deps.now()
        log.note(
          `lost the connection to the step (${problem}); the step keeps running, ` +
            `reconnecting for up to ${formatSeconds(options.reconnectMs)}`
        )
      } else {
        failures++
      }
      if (deps.now() - lostAt >= options.reconnectMs) {
        log.close()
        throw new Error(
          `lost the connection to the step and could not reconnect within ` +
            `${formatSeconds(options.reconnectMs)}: ${problem}`
        )
      }
      await deps.sleep(reconnectDelayMs(failures))
      launch = false
    }
  }
}

export interface SignalSource {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

// What the step server tells the supervisor in its liveness reply (see step-transfer.ts).
export interface CancelOrder {
  signal?: 'SIGINT' | 'SIGKILL'
  // The last signal a liveness reply carried.
  delivered?: 'SIGINT' | 'SIGKILL'
}

export interface CancelDeps {
  process: SignalSource
  // Sends the signal to the step's process group through an exec session.
  signalStep: (signal: 'SIGINT' | 'SIGKILL') => Promise<void>
  setTimer: (ms: number, callback: () => void) => void
  exit: (code: number) => void
}

// How long after the runner's SIGINT the step's group gets SIGKILL, and how long after
// that the hook exits on its own. The runner sends SIGTERM about 7.5s after SIGINT and
// SIGKILL about 2.5s after that (ProcessInvoker in actions/runner): the step is killed, and
// the hook gone, before the runner's SIGKILL.
export const CANCEL_KILL_AFTER_MS = 6000
export const CANCEL_EXIT_AFTER_MS = 2000

// A detached step outlives the hook, so the runner's cancel (a cancelled run, or
// `timeout-minutes`) has to be carried to it. SIGINT goes to the step's process group, so
// the step can clean up as on a VM runner; SIGTERM, or a group still alive
// CANCEL_KILL_AFTER_MS later, gets SIGKILL. Each signal goes two ways: an exec session now,
// and the reply to the supervisor's next liveness poll (`cancel`), which still works while
// the API server is unreachable. The job pod makes sure the group gets the SIGINT once,
// whichever way arrives first. `finish`, once the step has ended, removes the handlers
// and, if the step was cancelled, kills what is left of its process group: a step that
// trapped SIGINT and exited leaves its background children running (a non-interactive
// shell starts them with SIGINT ignored), and nothing of a cancelled step may run on.
export interface StepCancel {
  // The runner has cancelled the step.
  cancelled: () => boolean
  finish: () => Promise<void>
}

export function installStepCancel(
  cancel: CancelOrder,
  deps: CancelDeps
): StepCancel {
  let state: 'running' | 'interrupted' | 'killed' = 'running'
  let finished = false

  const kill = (): void => {
    if (finished || state === 'killed') {
      return
    }
    state = 'killed'
    cancel.signal = 'SIGKILL'
    hookInfo('stopping the cancelled step: SIGKILL to its processes')
    void deps.signalStep('SIGKILL').catch(() => undefined)
    deps.setTimer(CANCEL_EXIT_AFTER_MS, () => {
      if (!finished) {
        deps.exit(1)
      }
    })
  }
  const onInterrupt = (): void => {
    if (state !== 'running') {
      return
    }
    state = 'interrupted'
    cancel.signal = 'SIGINT'
    hookInfo('the step was cancelled: SIGINT to its processes')
    void deps.signalStep('SIGINT').catch(() => undefined)
    deps.setTimer(CANCEL_KILL_AFTER_MS, kill)
  }
  deps.process.on('SIGINT', onInterrupt)
  deps.process.on('SIGTERM', kill)
  return {
    cancelled: () => state !== 'running',
    finish: async () => {
      finished = true
      deps.process.off('SIGINT', onInterrupt)
      deps.process.off('SIGTERM', kill)
      if (state !== 'running') {
        await deps.signalStep('SIGKILL').catch(() => undefined)
      }
    }
  }
}

// How long the hook waits for the supervisor to fetch a SIGKILL before it goes on.
export const ABANDON_WAIT_MS = 2500

// The hook is about to fail a step that may still run (it could not reconnect). The API
// server is what it cannot reach, so the SIGKILL goes through the supervisor's next
// liveness poll, pod to pod; without it the step would run on until the supervisor notices
// that the hook is gone.
export async function killAbandonedStep(
  cancel: CancelOrder,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  cancel.signal = 'SIGKILL'
  for (
    let waited = 0;
    waited < ABANDON_WAIT_MS && cancel.delivered !== 'SIGKILL';
    waited += 100
  ) {
    await sleep(100)
  }
}

export interface PositiveSetting {
  value: number
  warning?: string
}

// A whole number above 0 from a HOOK_* variable, or the fallback (with a warning when the
// value was set but is not one). `unit` names what the number counts, for the warning.
export function positiveSetting(
  name: string,
  raw: string | undefined,
  fallback: number,
  unit: string
): PositiveSetting {
  if (raw === undefined || raw.trim() === '') {
    return { value: fallback }
  }
  const value = Number(raw.trim())
  if (Number.isInteger(value) && value > 0) {
    return { value }
  }
  return {
    value: fallback,
    warning: `${name} is "${raw}", not a whole number of ${unit} above 0; using ${fallback}`
  }
}
