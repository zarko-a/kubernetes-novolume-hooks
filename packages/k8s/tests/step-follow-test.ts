import { EventEmitter } from 'events'
import * as stream from 'stream'

// Everything that reaches the job log, in order: the step's stdout and the hook's own lines.
let jobLog: string[] = []
const mockInfo = jest.fn((message: string) => {
  jobLog.push(`${message}\n`)
})

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: (message: string) => mockInfo(message),
  warning: jest.fn(),
  error: jest.fn()
}))

import { ExecExitError } from '../src/k8s/exec-status'
import {
  ABANDON_WAIT_MS,
  CANCEL_EXIT_AFTER_MS,
  CANCEL_KILL_AFTER_MS,
  CancelOrder,
  DetachedStepDeps,
  ESTABLISHED_AFTER_MS,
  ExecSession,
  installStepCancel,
  JobContainerEndedError,
  killAbandonedStep,
  MAX_REREADS,
  positiveSetting,
  reconnectDelayMs,
  runDetachedStep
} from '../src/k8s/step-follow'

const DROPPED =
  'command sh in pod: the exec stream closed before the command reported an exit status'

class Sink extends stream.Writable {
  text = ''

  constructor(private readonly log?: string[]) {
    super()
  }

  _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.text += chunk.toString()
    this.log?.push(chunk.toString())
    callback()
  }
}

type Attempt = (
  command: string,
  stdout: stream.Writable,
  stderr: stream.Writable,
  session: ExecSession
) => Promise<void>

interface Timer {
  ms: number
  callback: () => void
  cancelled: boolean
}

// A fake clock that sleep and `advance` move, and an exec that runs the given attempts in
// order. Timers do not fire on their own: a test fires them with `fire`.
function setup(attempts: Attempt[]): {
  deps: DetachedStepDeps
  commands: string[]
  drops: (number | undefined)[]
  heartbeats: (boolean | undefined)[]
  stdout: Sink
  stderr: Sink
  sleeps: number[]
  timers: Timer[]
  advance: (ms: number) => void
  fire: () => void
} {
  let now = 0
  const commands: string[] = []
  const drops: (number | undefined)[] = []
  const heartbeats: (boolean | undefined)[] = []
  const sleeps: number[] = []
  const timers: Timer[] = []
  const stdout = new Sink(jobLog)
  const stderr = new Sink()
  const deps: DetachedStepDeps = {
    exec: async (command, out, err, session = {}) => {
      commands.push(command)
      drops.push(session.dropAfterMs)
      heartbeats.push(session.heartbeat)
      const attempt = attempts.shift()
      if (!attempt) {
        throw new Error(DROPPED)
      }
      await attempt(command, out, err, session)
    },
    jobContainerEnded: async () => undefined,
    contacted: () => true,
    sleep: async ms => {
      sleeps.push(ms)
      now += ms
    },
    now: () => now,
    setTimer: (ms, callback) => {
      const timer = { ms, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    stdout,
    stderr
  }
  return {
    deps,
    commands,
    drops,
    heartbeats,
    stdout,
    stderr,
    sleeps,
    timers,
    advance: ms => {
      now += ms
    },
    fire: () => {
      for (const timer of timers.splice(0)) {
        if (!timer.cancelled) {
          timer.callback()
        }
      }
    }
  }
}

const OPTIONS = {
  launch: 'LAUNCH',
  follow: (out: number, err: number) => `FOLLOW ${out} ${err}`,
  status: 'STATUS',
  reconnectMs: 300_000
}

const LOST =
  `[custom-hook] lost the connection to the step (${DROPPED}); the step keeps ` +
  'running, reconnecting for up to 300.0s'

function reconnected(after: string, failed = ''): string {
  return (
    `[custom-hook] reconnected to the step after ${after}${failed}; its output ` +
    'resumes where it stopped'
  )
}

function infos(): string[] {
  return mockInfo.mock.calls.map(([message]) => message)
}

function dropped(): never {
  throw new Error(DROPPED)
}

function exited(code: number): never {
  throw new ExecExitError(`command terminated with exit code ${code}`, code)
}

describe('runDetachedStep', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jobLog = []
  })

  it('runs the launch once when nothing goes wrong', async () => {
    const { deps, commands, drops, heartbeats, stdout } = setup([
      async (_command, out) => {
        out.write('hello\n')
      }
    ])
    await runDetachedStep(deps, { ...OPTIONS, dropAfterMs: 20_000 })
    expect(commands).toEqual(['LAUNCH'])
    expect(drops).toEqual([20_000])
    expect(heartbeats).toEqual([true])
    expect(stdout.text).toBe('hello\n')
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it('resumes from the bytes received on each stream after a drop', async () => {
    const { deps, commands, drops, stdout, stderr } = setup([
      async (_command, out, err) => {
        out.write('line 1\n')
        err.write('ä')
        dropped()
      },
      async (_command, out, err) => {
        out.write('line 2\n')
        err.write('rest\n')
      }
    ])
    await runDetachedStep(deps, { ...OPTIONS, dropAfterMs: 5000 })
    // 'ä' is two bytes: offsets are bytes, not characters.
    expect(commands).toEqual(['LAUNCH', 'FOLLOW 7 2'])
    // The test drop applies to every session, so a long step is cut more than once.
    expect(drops).toEqual([5000, 5000])
    expect(stdout.text).toBe('line 1\nline 2\n')
    expect(stderr.text).toBe('ärest\n')
    expect(infos()).toEqual([LOST, reconnected('1.0s')])
  })

  it("holds its own lines until the step's current line ends", async () => {
    const { deps, commands } = setup([
      async (_command, out) => {
        out.write('line 1\n::add-mask::sec')
        dropped()
      },
      async (_command, out) => {
        out.write('ret\nline 3\n')
      }
    ])
    await runDetachedStep(deps, OPTIONS)
    expect(commands).toEqual(['LAUNCH', 'FOLLOW 22 0'])
    expect(jobLog.join('')).toBe(
      `line 1\n::add-mask::secret\n${LOST}\n${reconnected('1.0s')}\nline 3\n`
    )
  })

  it('ends an open line before its own last lines when the step is given up', async () => {
    const { deps } = setup([
      async (_command, out) => {
        out.write('no newline')
        dropped()
      }
    ])
    await expect(
      runDetachedStep(deps, { ...OPTIONS, reconnectMs: 1000 })
    ).rejects.toThrow('could not reconnect within 1.0s')
    expect(jobLog.join('')).toBe(
      'no newline\n' + `${LOST.replace('300.0s', '1.0s')}\n`
    )
  })

  it('keeps the offsets across several failed reconnects, backing off', async () => {
    const { deps, commands, sleeps } = setup([
      async (_command, out) => {
        out.write('abc\n')
        dropped()
      },
      async () => {
        throw new Error('connect ECONNREFUSED')
      },
      async () => {
        throw new Error('connect ECONNREFUSED')
      },
      async () => undefined
    ])
    await runDetachedStep(deps, OPTIONS)
    expect(commands).toEqual([
      'LAUNCH',
      'FOLLOW 4 0',
      'FOLLOW 4 0',
      'FOLLOW 4 0'
    ])
    expect(sleeps).toEqual([1000, 2000, 4000])
    expect(mockInfo).toHaveBeenLastCalledWith(
      reconnected('7.0s', ' (2 failed attempts)')
    )
  })

  it('says it has reconnected when the session is established, not when the step ends', async () => {
    const { deps, advance, fire } = setup([
      async () => dropped(),
      async (_command, _out, _err, session) => {
        session.onOpen?.()
        expect(infos()).toEqual([LOST])
        // A quiet step: the session staying open is what establishes it.
        advance(ESTABLISHED_AFTER_MS)
        fire()
        expect(infos()).toEqual([LOST, reconnected('3.0s')])
        advance(3_000_000)
      }
    ])
    await runDetachedStep(deps, OPTIONS)
    expect(infos()).toEqual([LOST, reconnected('3.0s')])
  })

  it('gives every loss of the connection a full budget', async () => {
    const { deps, commands, advance, fire } = setup([
      async () => {
        advance(600_000)
        dropped()
      },
      async (_command, out, _err, session) => {
        session.onOpen?.()
        advance(ESTABLISHED_AFTER_MS)
        fire()
        out.write('six more minutes\n')
        // Longer than the budget after the first loss: the control plane's second
        // instance is replaced.
        advance(360_000)
        dropped()
      },
      async (_command, out) => {
        out.write('done\n')
      }
    ])
    await runDetachedStep(deps, OPTIONS)
    expect(commands).toEqual(['LAUNCH', 'FOLLOW 0 0', 'FOLLOW 17 0'])
    expect(infos()).toEqual([
      LOST,
      reconnected('3.0s'),
      LOST,
      reconnected('1.0s')
    ])
  })

  it('does not take a session that opens and breaks at once for a reconnect', async () => {
    const flap: Attempt = async (_command, _out, _err, session) => {
      session.onOpen?.()
      dropped()
    }
    const { deps, commands, timers } = setup([flap, flap, flap, flap, flap])
    await expect(
      runDetachedStep(deps, { ...OPTIONS, reconnectMs: 10_000 })
    ).rejects.toThrow('could not reconnect within 10.0s')
    // 0s, 1s, 3s, 7s, then 12s is past the budget: it was never renewed.
    expect(commands).toEqual([
      'LAUNCH',
      'FOLLOW 0 0',
      'FOLLOW 0 0',
      'FOLLOW 0 0',
      'FOLLOW 0 0'
    ])
    expect(timers.every(timer => timer.cancelled)).toBe(true)
    expect(infos()).toEqual([LOST.replace('300.0s', '10.0s')])
  })

  it('ignores what an ended session still delivers', async () => {
    let stale: stream.Writable | undefined
    const { deps, commands, stdout } = setup([
      async (_command, out) => {
        stale = out
        out.write('abc\n')
        dropped()
      },
      async (_command, out) => {
        stale?.write('LATE\n')
        out.write('def\n')
        dropped()
      },
      async () => undefined
    ])
    await runDetachedStep(deps, OPTIONS)
    expect(commands).toEqual(['LAUNCH', 'FOLLOW 4 0', 'FOLLOW 8 0'])
    expect(stdout.text).toBe('abc\ndef\n')
  })

  it("rejects with the step's exit code, after a reconnect too", async () => {
    const failed = new ExecExitError('command terminated with exit code 3', 3)
    const { deps } = setup([
      async () => dropped(),
      async () => {
        throw failed
      }
    ])
    await expect(runDetachedStep(deps, OPTIONS)).rejects.toBe(failed)
    expect(mockInfo).toHaveBeenLastCalledWith(reconnected('1.0s'))
  })

  it('gives up when the reconnect budget runs out', async () => {
    const { deps, commands } = setup([])
    await expect(
      runDetachedStep(deps, { ...OPTIONS, reconnectMs: 10_000 })
    ).rejects.toThrow(
      `lost the connection to the step and could not reconnect within 10.0s: ${DROPPED}`
    )
    // 0s, 1s, 3s, 7s, then 12s is past the budget.
    expect(commands).toEqual([
      'LAUNCH',
      'FOLLOW 0 0',
      'FOLLOW 0 0',
      'FOLLOW 0 0',
      'FOLLOW 0 0'
    ])
  })

  it('fails at once, without reconnecting, when the job container is gone', async () => {
    const { deps, commands } = setup([
      async () => {
        throw new Error(
          'Internal error occurred: unable to upgrade connection: container not found ("job")'
        )
      }
    ])
    deps.jobContainerEnded = async () => 'terminated OOMKilled, exit 137'
    deps.contacted = () => false
    const result = runDetachedStep(deps, OPTIONS)
    await expect(result).rejects.toThrow(
      'the job container is no longer running (terminated OOMKilled, exit 137); ' +
        'this step cannot run'
    )
    await expect(result).rejects.toBeInstanceOf(JobContainerEndedError)
    expect(commands).toEqual(['LAUNCH'])
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it('says a running step ended with its job container', async () => {
    // An OOM kill takes the reader with the container: 137, and no status to ask for. The
    // kubelet reports the container's end a moment later.
    const { deps, commands, sleeps } = setup([
      async () => exited(137),
      async () => {
        throw new Error('container not found ("job")')
      }
    ])
    let asked = 0
    deps.jobContainerEnded = async () =>
      ++asked < 3 ? undefined : 'terminated OOMKilled, exit 137'
    await expect(runDetachedStep(deps, OPTIONS)).rejects.toThrow(
      'the job container is no longer running (terminated OOMKilled, exit 137); ' +
        'the step ended with it'
    )
    expect(commands).toEqual(['LAUNCH', 'STATUS'])
    expect(sleeps).toEqual([1000, 1000])
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it('launches again when the first launch never ran', async () => {
    const { deps, commands } = setup([
      async () => {
        throw new Error('unable to upgrade connection: 503')
      },
      async () => exited(215),
      async () => undefined
    ])
    deps.contacted = () => false
    await runDetachedStep(deps, OPTIONS)
    expect(commands).toEqual(['LAUNCH', 'FOLLOW 0 0', 'LAUNCH'])
  })

  it('takes 215 as the exit code of a step that reached the server', async () => {
    const { deps, commands } = setup([
      async () => dropped(),
      async () => exited(215)
    ])
    await expect(runDetachedStep(deps, OPTIONS)).rejects.toThrow(
      'exit code 215'
    )
    expect(commands).toEqual(['LAUNCH', 'FOLLOW 0 0'])
  })

  it('takes an exit code from a plain error message, as the mocks and the kubelet word it', async () => {
    const { deps, commands } = setup([
      async () => {
        throw new Error(
          'command terminated with non-zero exit code: command terminated with exit code 2'
        )
      }
    ])
    await expect(runDetachedStep(deps, OPTIONS)).rejects.toThrow('exit code 2')
    expect(commands).toEqual(['LAUNCH'])
  })

  it("believes a signal's exit code when the step recorded it", async () => {
    const { deps, commands } = setup([
      async () => exited(143),
      async (_command, out) => {
        out.write('exit 143 SIGTERM\n')
      }
    ])
    await expect(runDetachedStep(deps, OPTIONS)).rejects.toThrow(
      'exit code 143'
    )
    expect(commands).toEqual(['LAUNCH', 'STATUS'])
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it('reads on when the reader was killed and the step still runs', async () => {
    const { deps, commands, heartbeats, stdout } = setup([
      async (_command, out) => {
        out.write('before\n')
        // What the kubelet reports for a reader that `pkill node` ended.
        exited(143)
      },
      async (_command, out) => {
        out.write('running\n')
      },
      async (_command, out) => {
        out.write('after\n')
      }
    ])
    await runDetachedStep(deps, OPTIONS)
    expect(commands).toEqual(['LAUNCH', 'STATUS', 'FOLLOW 7 0'])
    // Only the sessions that read the step carry the hook's heartbeat.
    expect(heartbeats).toEqual([true, undefined, true])
    expect(stdout.text).toBe('before\nafter\n')
    expect(infos()).toEqual([
      "[custom-hook] the session reading the step's output ended with exit code 143, " +
        'which the step has not recorded (something in the job killed the reader); ' +
        'reading on'
    ])
  })

  it('reads on when the step recorded another exit code than the reader died with', async () => {
    const failed = new ExecExitError('command terminated with exit code 2', 2)
    const { deps, commands } = setup([
      async () => exited(137),
      async (_command, out) => {
        out.write('exit 2\n')
      },
      async () => {
        throw failed
      }
    ])
    await expect(runDetachedStep(deps, OPTIONS)).rejects.toBe(failed)
    expect(commands).toEqual(['LAUNCH', 'STATUS', 'FOLLOW 0 0'])
  })

  it('stops reading on when the reader keeps getting killed', async () => {
    const attempts: Attempt[] = []
    for (let i = 0; i <= MAX_REREADS; i++) {
      attempts.push(
        async () => exited(137),
        async (_command, out) => {
          out.write('running\n')
        }
      )
    }
    const { deps } = setup(attempts)
    await expect(runDetachedStep(deps, OPTIONS)).rejects.toThrow(
      `the session reading the step's output ended ${MAX_REREADS + 1} times with a ` +
        "signal's exit code (last: 137) while the step had recorded none"
    )
  })

  it("treats a signal's exit code as a lost connection when the step cannot be asked", async () => {
    const { deps, commands } = setup([
      async () => exited(143),
      async () => dropped(),
      async () => undefined
    ])
    await runDetachedStep(deps, OPTIONS)
    expect(commands).toEqual(['LAUNCH', 'STATUS', 'FOLLOW 0 0'])
    expect(infos()[0]).toBe(
      '[custom-hook] lost the connection to the step (command terminated with exit ' +
        'code 143, and what the step recorded could not be read); the step keeps ' +
        'running, reconnecting for up to 300.0s'
    )
  })
})

describe('reconnectDelayMs', () => {
  it('doubles from 1s up to 5s', () => {
    expect([0, 1, 2, 3, 4, 10].map(reconnectDelayMs)).toEqual([
      1000, 2000, 4000, 5000, 5000, 5000
    ])
  })
})

describe('installStepCancel', () => {
  function setupCancel(): {
    source: EventEmitter
    cancel: CancelOrder
    signals: string[]
    timers: { ms: number; callback: () => void }[]
    exits: number[]
    cancelled: () => boolean
    finish: () => Promise<void>
  } {
    const source = new EventEmitter()
    const cancel: CancelOrder = {}
    const signals: string[] = []
    const timers: { ms: number; callback: () => void }[] = []
    const exits: number[] = []
    const { cancelled, finish } = installStepCancel(cancel, {
      process: source,
      signalStep: async signal => {
        signals.push(signal)
      },
      setTimer: (ms, callback) => timers.push({ ms, callback }),
      exit: code => exits.push(code)
    })
    return { source, cancel, signals, timers, exits, cancelled, finish }
  }

  beforeEach(() => jest.clearAllMocks())

  it('forwards SIGINT, then SIGKILL if the step is still running, then exits', () => {
    const { source, cancel, signals, timers, exits, cancelled } = setupCancel()
    expect(cancelled()).toBe(false)
    source.emit('SIGINT')
    expect(cancelled()).toBe(true)
    expect(cancel.signal).toBe('SIGINT')
    expect(signals).toEqual(['SIGINT'])
    expect(timers.map(t => t.ms)).toEqual([CANCEL_KILL_AFTER_MS])
    // The runner repeats nothing, but a second SIGINT must not restart the clock.
    source.emit('SIGINT')
    expect(signals).toEqual(['SIGINT'])

    timers[0].callback()
    expect(cancel.signal).toBe('SIGKILL')
    expect(signals).toEqual(['SIGINT', 'SIGKILL'])
    expect(timers.map(t => t.ms)).toEqual([
      CANCEL_KILL_AFTER_MS,
      CANCEL_EXIT_AFTER_MS
    ])
    expect(exits).toEqual([])
    timers[1].callback()
    expect(exits).toEqual([1])
    expect(mockInfo.mock.calls.map(([m]) => m)).toEqual([
      '[custom-hook] the step was cancelled: SIGINT to its processes',
      '[custom-hook] stopping the cancelled step: SIGKILL to its processes'
    ])
  })

  it('kills at once on SIGTERM, and only once', () => {
    const { source, cancel, signals, timers, cancelled } = setupCancel()
    source.emit('SIGTERM')
    source.emit('SIGTERM')
    source.emit('SIGINT')
    expect(cancelled()).toBe(true)
    expect(cancel.signal).toBe('SIGKILL')
    expect(signals).toEqual(['SIGKILL'])
    expect(timers.map(t => t.ms)).toEqual([CANCEL_EXIT_AFTER_MS])
  })

  it('kills a step the runner escalates on before the timer', () => {
    const { source, signals, timers } = setupCancel()
    source.emit('SIGINT')
    source.emit('SIGTERM')
    expect(signals).toEqual(['SIGINT', 'SIGKILL'])
    timers[0].callback()
    expect(signals).toEqual(['SIGINT', 'SIGKILL'])
  })

  it('stops listening once the step is over, and leaves a step that was not cancelled alone', async () => {
    const { source, signals, finish } = setupCancel()
    await finish()
    expect(source.listenerCount('SIGINT')).toBe(0)
    expect(source.listenerCount('SIGTERM')).toBe(0)
    expect(signals).toEqual([])
  })

  it("kills what is left of a cancelled step's group once it is over", async () => {
    const { source, signals, finish } = setupCancel()
    source.emit('SIGINT')
    await finish()
    expect(signals).toEqual(['SIGINT', 'SIGKILL'])
    expect(source.listenerCount('SIGINT')).toBe(0)
  })

  it('leaves the hook alone once the step is over, whatever timers are still set', async () => {
    const { source, cancel, signals, timers, exits, finish } = setupCancel()
    source.emit('SIGINT')
    await finish()
    timers[0].callback()
    expect(cancel.signal).toBe('SIGINT')
    expect(signals).toEqual(['SIGINT', 'SIGKILL'])
    expect(timers).toHaveLength(1)
    expect(exits).toEqual([])
    expect(mockInfo).toHaveBeenCalledTimes(1)
  })

  it('survives a signal exec that fails', async () => {
    const source = new EventEmitter()
    installStepCancel(
      {},
      {
        process: source,
        signalStep: async () => {
          throw new Error('API server unreachable')
        },
        setTimer: () => undefined,
        exit: () => undefined
      }
    )
    source.emit('SIGINT')
    await new Promise(resolve => setImmediate(resolve))
  })
})

describe('killAbandonedStep', () => {
  it('orders a SIGKILL and returns once the supervisor has fetched it', async () => {
    const cancel: CancelOrder = {}
    let sleeps = 0
    await killAbandonedStep(cancel, async () => {
      sleeps++
      expect(cancel.signal).toBe('SIGKILL')
      if (sleeps === 3) {
        cancel.delivered = 'SIGKILL'
      }
    })
    expect(sleeps).toBe(3)
  })

  it('does not wait long for a supervisor that never asks', async () => {
    const cancel: CancelOrder = { delivered: 'SIGINT' }
    let slept = 0
    await killAbandonedStep(cancel, async ms => {
      slept += ms
    })
    expect(slept).toBe(ABANDON_WAIT_MS)
  })
})

describe('positiveSetting', () => {
  it('reads a whole number', () => {
    expect(positiveSetting('HOOK_X', ' 30 ', 15, 'seconds')).toEqual({
      value: 30
    })
  })

  it('uses the fallback when unset or empty', () => {
    expect(positiveSetting('HOOK_X', undefined, 15, 'seconds')).toEqual({
      value: 15
    })
    expect(positiveSetting('HOOK_X', '', 15, 'seconds')).toEqual({ value: 15 })
  })

  it('warns about anything else', () => {
    for (const raw of ['0', '-5', '1.5', '10s', 'abc']) {
      expect(positiveSetting('HOOK_X', raw, 15, 'MiB')).toEqual({
        value: 15,
        warning: `HOOK_X is "${raw}", not a whole number of MiB above 0; using 15`
      })
    }
  })
})
