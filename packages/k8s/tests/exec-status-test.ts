import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Writable } from 'stream'

const mockExec = jest.fn()

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}))

jest.mock('@kubernetes/client-node', () => {
  return {
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({}),
      getContexts: jest.fn().mockReturnValue([{ namespace: 'test-namespace' }])
    })),
    Exec: jest.fn().mockImplementation(() => ({ exec: mockExec })),
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    CoreV1Api: class CoreV1Api {},
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    AuthorizationV1Api: class AuthorizationV1Api {}
  }
})

jest.mock('tar-fs', () => ({
  default: {
    pack: () => new Writable({ write: (_c, _e, cb) => cb() }),
    extract: () => new Writable({ write: (_c, _e, cb) => cb() })
  },
  __esModule: true
}))

jest.mock('../src/k8s/utils', () => {
  const actual = jest.requireActual('../src/k8s/utils')
  return {
    ...actual,
    sleep: jest.fn().mockResolvedValue(undefined)
  }
})

import { execCpToPod, execListing, execPodStep } from '../src/k8s'
import {
  ExecExitError,
  execExitCode,
  rejectIfClosedWithoutStatus,
  statusExitCode,
  trackStatus
} from '../src/k8s/exec-status'

// The parts of a `ws` WebSocket the hook uses. close() emits `close` on the next tick, as
// the real socket does after the closing handshake.
class FakeSocket extends EventEmitter {
  readyState = 1
  ping = jest.fn()
  close = jest.fn(() => {
    this.readyState = 3
    setImmediate(() => this.emit('close'))
  })

  dropped(): void {
    this.readyState = 3
    this.emit('close')
  }
}

type StatusCallback = (status: { status: string; message?: string }) => void

// An exec whose stream the server drops before sending a status frame.
function droppedExec(): (...args: unknown[]) => Promise<FakeSocket> {
  return async () => {
    const ws = new FakeSocket()
    setImmediate(() => ws.dropped())
    return ws
  }
}

// An exec that reports `status`, then closes, as Kubernetes does.
function completedExec(status: {
  status: string
  message?: string
}): (...args: unknown[]) => Promise<FakeSocket> {
  return async (...args: unknown[]) => {
    const ws = new FakeSocket()
    const callback = args[8] as StatusCallback
    setImmediate(() => {
      // As @kubernetes/client-node does on the status frame: it ends the caller's stream,
      // but never process.stdout, which execPodStep passes. Ending that would break every
      // later test in this Jest worker that writes to stdout.
      const stdout = args[4] as Writable | null
      if (stdout && stdout !== process.stdout) {
        stdout.end()
      }
      callback(status)
      ws.dropped()
    })
    return ws
  }
}

describe('rejectIfClosedWithoutStatus', () => {
  it('rejects when the socket closes before a status arrives', () => {
    const ws = new FakeSocket()
    const reject = jest.fn()
    rejectIfClosedWithoutStatus(ws, () => false, reject, 'step')
    ws.dropped()
    expect(reject).toHaveBeenCalledWith(
      new Error(
        'step: the exec stream closed before the command reported an exit status'
      )
    )
  })

  it('does nothing when the status arrived before the close', () => {
    const ws = new FakeSocket()
    const reject = jest.fn()
    const status = trackStatus(jest.fn())
    rejectIfClosedWithoutStatus(ws, status.received, reject, 'step')
    status.callback({ status: 'Success' })
    ws.dropped()
    expect(reject).not.toHaveBeenCalled()
  })

  it('rejects at once when the socket is already closed without a status', () => {
    const ws = new FakeSocket()
    ws.readyState = 3
    const reject = jest.fn()
    rejectIfClosedWithoutStatus(ws, () => false, reject, 'step')
    expect(reject).toHaveBeenCalledTimes(1)
  })

  it('ignores a missing socket', () => {
    const reject = jest.fn()
    rejectIfClosedWithoutStatus(null, () => false, reject, 'step')
    rejectIfClosedWithoutStatus(undefined, () => false, reject, 'step')
    expect(reject).not.toHaveBeenCalled()
  })
})

describe('trackStatus', () => {
  it('passes the status through and records that it arrived', () => {
    const inner = jest.fn()
    const status = trackStatus(inner)
    expect(status.received()).toBe(false)
    status.callback({ status: 'Failure' })
    expect(inner).toHaveBeenCalledWith({ status: 'Failure' })
    expect(status.received()).toBe(true)
  })
})

describe('execs whose stream closes without a status', () => {
  let dir: string

  beforeEach(() => {
    jest.clearAllMocks()
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'test-namespace'
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-status-'))
  })

  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('execPodStep fails the step instead of leaving it pending', async () => {
    mockExec.mockImplementation(droppedExec())
    await expect(
      execPodStep(['sh', '-e', '/__w/_temp/step.sh'], 'pod', 'job')
    ).rejects.toThrow(
      'command sh in pod: the exec stream closed before the command reported an exit status'
    )
  })

  it('execPodStep still returns the exit code when the status arrives', async () => {
    mockExec.mockImplementation(completedExec({ status: 'Success' }))
    await expect(execPodStep(['true'], 'pod', 'job')).resolves.toBe(0)
  })

  it('execPodStep still rejects with the failure message from the status', async () => {
    mockExec.mockImplementation(
      completedExec({ status: 'Failure', message: 'command terminated' })
    )
    await expect(execPodStep(['false'], 'pod', 'job')).rejects.toThrow(
      'command terminated'
    )
  })

  it('execListing fails instead of returning a partial listing', async () => {
    mockExec.mockImplementation(droppedExec())
    await expect(
      execListing('pod', 'job', ['sh', '-c', 'find .'])
    ).rejects.toThrow(
      'listing in the job pod: the exec stream closed before the command reported an exit status'
    )
  })

  it('a copy to the job pod treats a dropped stream as a failed attempt and retries', async () => {
    const dropped = droppedExec()
    const completed = completedExec({ status: 'Success' })
    let copies = 0
    mockExec.mockImplementation(async (...args: unknown[]) => {
      const command = (args[3] as string[]).join(' ')
      if (command.includes("stat -c '%s %n'")) {
        return completed(...args)
      }
      copies++
      return copies === 1 ? dropped(...args) : completed(...args)
    })

    const stats = await execCpToPod('pod', dir, '/__w')

    expect(copies).toBe(2)
    expect(stats.transferAttempts).toBe(2)
  })
})

describe('exit codes of failed execs', () => {
  const nonZero = {
    status: 'Failure',
    reason: 'NonZeroExitCode',
    message:
      'command terminated with non-zero exit code: command terminated with exit code 3',
    details: { causes: [{ reason: 'ExitCode', message: '3' }] }
  }

  it('reads the code from the Status the kubelet sends', () => {
    expect(statusExitCode(nonZero)).toBe(3)
    expect(
      statusExitCode({ status: 'Failure', message: 'container not found' })
    ).toBe(undefined)
    expect(statusExitCode(undefined)).toBe(undefined)
  })

  it('reads the code from an ExecExitError or a message that states it', () => {
    expect(execExitCode(new ExecExitError('anything', 7))).toBe(7)
    expect(
      execExitCode(new Error('command terminated with exit code 213'))
    ).toBe(213)
    expect(
      execExitCode(
        new Error(
          'command sh in pod: the exec stream closed before the command reported an exit status'
        )
      )
    ).toBe(undefined)
    expect(execExitCode(new Error('exit code 2140 of something'))).toBe(
      undefined
    )
  })

  it('execPodStep rejects with the exit code and writes to the given streams', async () => {
    jest.clearAllMocks()
    let written = ''
    const out = new Writable({
      write: (chunk, _encoding, callback) => {
        written += chunk.toString()
        callback()
      }
    })
    mockExec.mockImplementation(async (...args: unknown[]) => {
      const ws = new FakeSocket()
      const callback = args[8] as (status: unknown) => void
      setImmediate(() => {
        ;(args[4] as Writable).write('from the step\n')
        callback(nonZero)
        ws.dropped()
      })
      return ws
    })
    const failure = execPodStep(
      ['sh', '-c', 'exit 3'],
      'pod',
      'job',
      undefined,
      {
        stdout: out
      }
    )
    await expect(failure).rejects.toBeInstanceOf(ExecExitError)
    await expect(failure).rejects.toMatchObject({ exitCode: 3 })
    expect(written).toBe('from the step\n')
  })

  it('execPodStep cuts the connection after dropAfterMs, as a restarted API server would', async () => {
    jest.clearAllMocks()
    const socket = new FakeSocket() as FakeSocket & { terminate: jest.Mock }
    socket.terminate = jest.fn(() => socket.dropped())
    mockExec.mockImplementation(async () => socket)
    await expect(
      execPodStep(['sleep', '60'], 'pod', 'job', undefined, { dropAfterMs: 10 })
    ).rejects.toThrow(
      'the exec stream closed before the command reported an exit status'
    )
    expect(socket.terminate).toHaveBeenCalled()
  })
})
