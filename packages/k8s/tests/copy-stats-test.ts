import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Writable } from 'stream'

const mockExec = jest.fn()
const mockPack = jest.fn()
const mockExtract = jest.fn()
const mockWarning = jest.fn()
const mockInfo = jest.fn()

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: (message: string) => mockInfo(message),
  warning: (message: string) => mockWarning(message),
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
    pack: (...args: unknown[]) => mockPack(...args),
    extract: (...args: unknown[]) => mockExtract(...args)
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

import { execCpFromPod, execCpToPod, waitForFinish } from '../src/k8s'

type Header = { type: string; size: number }
const HEADERS: Header[] = [
  { type: 'directory', size: 0 },
  { type: 'file', size: 100 },
  { type: 'file', size: 23 },
  { type: 'symlink', size: 0 }
]

// Feeds the headers through the `map` option tar-fs was given, as tar-fs would while
// packing or extracting.
function tarWithHeaders(
  _dir: string,
  options?: { map?: (h: Header) => Header }
): Writable {
  for (const header of HEADERS) {
    options?.map?.(header)
  }
  return new Writable({ write: (_c, _e, cb) => cb() })
}

interface PodBehaviour {
  // stdout of the listing command used for the comparison
  listing?: string
  // exec status of the copy command, per attempt (the last one repeats)
  copyStatuses?: { status: string; message?: string }[]
  copyStderr?: string
  listingStatus?: { status: string; message?: string }
}

function isListing(command: string[]): boolean {
  return command.join(' ').includes("stat -c '%s %n'")
}

// Simulates the pod side of every exec.
function pod(behaviour: PodBehaviour) {
  let copies = 0
  return async (...args: unknown[]) => {
    const command = args[3] as string[]
    const stdout = args[4] as Writable | null
    const stderr = args[5] as Writable | null
    const callback = args[8] as (status: {
      status: string
      message?: string
    }) => void
    if (isListing(command)) {
      if (behaviour.listing) {
        stdout?.write(behaviour.listing)
      }
      callback(behaviour.listingStatus ?? { status: 'Success' })
      return undefined
    }
    const statuses = behaviour.copyStatuses ?? [{ status: 'Success' }]
    const status = statuses[Math.min(copies, statuses.length - 1)]
    copies++
    if (behaviour.copyStderr) {
      stderr?.write(behaviour.copyStderr)
    }
    // As @kubernetes/client-node does when the status arrives: end the caller's streams.
    stdout?.end()
    callback(status)
    return undefined
  }
}

describe('copy stats', () => {
  let emptyDir: string

  beforeEach(() => {
    jest.clearAllMocks()
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'test-namespace'
    // An empty directory lists as nothing on the runner side, which matches a pod
    // listing of nothing.
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-stats-'))
    mockPack.mockImplementation(tarWithHeaders)
    mockExtract.mockImplementation(tarWithHeaders)
  })

  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    fs.rmSync(emptyDir, { recursive: true, force: true })
  })

  it('execCpToPod counts files and bytes and reports a verified copy', async () => {
    mockExec.mockImplementation(pod({}))

    const stats = await execCpToPod('pod', emptyDir, '/__w')

    expect(stats).toMatchObject({
      files: 2,
      bytes: 123,
      transferAttempts: 1,
      verified: true,
      runnerFiles: 0,
      podFiles: 0
    })
    expect(stats.transferMs).toBeGreaterThanOrEqual(0)
    expect(stats.verifyMs).toBeGreaterThanOrEqual(0)
    expect(mockPack).toHaveBeenCalledWith(
      emptyDir,
      expect.objectContaining({ map: expect.any(Function) })
    )
    expect(mockWarning).not.toHaveBeenCalled()
  })

  it('execCpToPod unpacks with tar and best-effort batched chmod', async () => {
    mockExec.mockImplementation(pod({}))

    await execCpToPod('pod', emptyDir, '/__w')

    const script = (mockExec.mock.calls[0][3] as string[])[2]
    expect(script).toBe(
      'tar xf - --no-same-owner -C /__w; status=$?; ' +
        'find /__w -type f -exec chmod u+rw {} + 2>/dev/null; ' +
        'find /__w -type d -exec chmod u+rwx {} + 2>/dev/null; exit $status'
    )
  })

  it('execCpToPod compares once and warns with both file counts on a mismatch', async () => {
    mockExec.mockImplementation(
      pod({ listing: '5 ./only-in-pod\n7 ./also-only-in-pod\n' })
    )

    const stats = await execCpToPod('pod', emptyDir, '/__w')

    expect(stats).toMatchObject({
      verified: false,
      runnerFiles: 0,
      podFiles: 2
    })
    const listings = mockExec.mock.calls.filter(call =>
      isListing(call[3] as string[])
    )
    expect(listings).toHaveLength(1)
    expect(mockWarning).toHaveBeenCalledTimes(1)
    expect(mockWarning.mock.calls[0][0]).toBe(
      `[custom-hook] copy ${emptyDir} to job pod /__w: the files differ after the copy ` +
        '(runner: 0 files, job pod: 2 files). The job continues.'
    )
  })

  it('execCpToPod warns and carries on when the pod listing fails', async () => {
    mockExec.mockImplementation(
      pod({ listingStatus: { status: 'Failure', message: 'exec failed' } })
    )

    const stats = await execCpToPod('pod', emptyDir, '/__w')

    expect(stats.verified).toBe(false)
    expect(stats.verifyError).toBe('exec failed')
    expect(mockWarning.mock.calls[0][0]).toContain(
      'could not compare the files after the copy: exec failed'
    )
  })

  it('execCpToPod retries a copy whose command exited non-zero', async () => {
    mockExec.mockImplementation(
      pod({
        copyStatuses: [
          { status: 'Failure', message: 'command terminated with exit code 1' },
          { status: 'Success' }
        ]
      })
    )

    const stats = await execCpToPod('pod', emptyDir, '/__w')

    expect(stats.transferAttempts).toBe(2)
    expect(stats.files).toBe(2)
    expect(stats.bytes).toBe(123)
    expect(stats.verified).toBe(true)
  })

  it("execCpToPod fails with tar's stderr when every attempt exits non-zero", async () => {
    mockExec.mockImplementation(
      pod({
        copyStatuses: [
          { status: 'Failure', message: 'command terminated with exit code 1' }
        ],
        copyStderr: 'tar: invalid magic\n'
      })
    )

    await expect(execCpToPod('pod', emptyDir, '/__w')).rejects.toThrow(
      `cpToPod failed after 30 attempts: copy ${emptyDir} to job pod /__w failed: ` +
        'command terminated with exit code 1; stderr: tar: invalid magic'
    )
  })

  it("execCpToPod accepts GNU tar's directory metadata errors from a non-root user", async () => {
    mockExec.mockImplementation(
      pod({
        copyStatuses: [
          { status: 'Failure', message: 'command terminated with exit code 2' }
        ],
        // GNU tar 1.34, run as uid 101 into fs-init's directories (2026-11-06)
        copyStderr: [
          'tar: .: Cannot change mode to rwxrwxrwx: Operation not permitted',
          'tar: ./repo: Cannot utime: Operation not permitted',
          'tar: ./repo/repo: Cannot change mode to rwxrwxr-x: Operation not permitted',
          'tar: Exiting with failure status due to previous errors',
          ''
        ].join('\n')
      })
    )

    const stats = await execCpToPod('pod', emptyDir, '/__w')

    expect(stats.transferAttempts).toBe(1)
    expect(mockInfo).toHaveBeenCalledWith(
      `[custom-hook] copy ${emptyDir} to job pod /__w: tar could not set the mode or ` +
        'times of directories this user does not own; the files were copied'
    )
  })

  it('execCpToPod still fails when tar reports anything else as well', async () => {
    mockExec.mockImplementation(
      pod({
        copyStatuses: [
          { status: 'Failure', message: 'command terminated with exit code 2' }
        ],
        copyStderr: [
          'tar: ./repo: Cannot utime: Operation not permitted',
          'tar: ./repo/file: Cannot open: Permission denied',
          'tar: Exiting with failure status due to previous errors'
        ].join('\n')
      })
    )

    await expect(execCpToPod('pod', emptyDir, '/__w')).rejects.toThrow(
      'Cannot open: Permission denied'
    )
  })

  it('execCpToPod logs stderr from a copy that succeeded', async () => {
    mockExec.mockImplementation(
      pod({ copyStderr: 'tar: ./x: time stamp in the future\n' })
    )

    const stats = await execCpToPod('pod', emptyDir, '/__w')

    expect(stats.transferAttempts).toBe(1)
    expect(mockInfo).toHaveBeenCalledWith(
      `[custom-hook] copy ${emptyDir} to job pod /__w printed to stderr: ` +
        'tar: ./x: time stamp in the future'
    )
  })

  it('execCpFromPod counts what it extracts and reports a verified copy', async () => {
    mockExec.mockImplementation(pod({}))
    // The runner-side listing runs in <parent>/<basename of the pod path>.
    fs.mkdirSync(path.join(emptyDir, '_runner_file_commands'))

    const stats = await execCpFromPod(
      'pod',
      '/__w/_temp/_runner_file_commands',
      emptyDir
    )

    expect(stats).toMatchObject({
      files: 2,
      bytes: 123,
      transferAttempts: 1,
      verified: true
    })
    expect(mockExtract).toHaveBeenCalledWith(
      emptyDir,
      expect.objectContaining({ map: expect.any(Function) })
    )
  })

  it('execCpFromPod returns only after tar-fs has written everything', async () => {
    mockExec.mockImplementation(pod({}))
    fs.mkdirSync(path.join(emptyDir, '_runner_file_commands'))
    let written = false
    mockExtract.mockImplementation(
      (_dir: string, options?: { map?: (h: Header) => Header }) => {
        tarWithHeaders(_dir, options)
        // Finishes 50ms after end(), like tar-fs closing its last file.
        return new Writable({
          write: (_c, _e, cb) => cb(),
          final: cb =>
            setTimeout(() => {
              written = true
              cb()
            }, 50)
        })
      }
    )

    await execCpFromPod('pod', '/__w/_temp/_runner_file_commands', emptyDir)

    expect(written).toBe(true)
  })

  it('waitForFinish rejects when the stream errors or never finishes', async () => {
    const { EventEmitter } = await import('events')
    const erroring = new EventEmitter()
    const failed = waitForFinish(erroring, 1000)
    erroring.emit('error', new Error('disk full'))
    await expect(failed).rejects.toThrow('disk full')

    await expect(waitForFinish(new EventEmitter(), 20)).rejects.toThrow(
      'extracting did not finish in 0.02s'
    )
  })

  it('execCpFromPod retries a tar that exited non-zero', async () => {
    mockExec.mockImplementation(
      pod({
        copyStatuses: [
          { status: 'Failure', message: 'command terminated with exit code 2' },
          { status: 'Success' }
        ]
      })
    )
    fs.mkdirSync(path.join(emptyDir, '_runner_file_commands'))

    const stats = await execCpFromPod(
      'pod',
      '/__w/_temp/_runner_file_commands',
      emptyDir
    )

    expect(stats.transferAttempts).toBe(2)
  })
})
