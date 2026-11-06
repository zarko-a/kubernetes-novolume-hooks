import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Writable } from 'stream'

const mockExec = jest.fn()
const mockPack = jest.fn()
const mockExtract = jest.fn()

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
    BatchV1Api: class BatchV1Api {},
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    AuthorizationV1Api: class AuthorizationV1Api {},
    Log: jest.fn()
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

import { execCpFromPod, execCpToPod } from '../src/k8s'

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
) {
  for (const header of HEADERS) {
    options?.map?.(header)
  }
  return new Writable({ write: (_c, _e, cb) => cb() })
}

// Simulates the pod side of every exec: the copy itself succeeds, and the listing used
// for the hash check prints `podListing`.
function execSucceeding(podListing: string) {
  return async (...args: unknown[]) => {
    const stdout = args[4] as Writable | null
    const callback = args[8] as (status: { status: string }) => void
    if (stdout && typeof stdout.write === 'function' && podListing) {
      stdout.write(podListing)
    }
    callback({ status: 'Success' })
    return undefined
  }
}

describe('copy stats', () => {
  let emptyDir: string

  beforeEach(() => {
    jest.clearAllMocks()
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'test-namespace'
    // An empty directory lists as nothing on the runner side, which matches a pod
    // listing of nothing, so the hash check passes on the first attempt.
    emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-stats-'))
    mockPack.mockImplementation(tarWithHeaders)
    mockExtract.mockImplementation(tarWithHeaders)
  })

  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    fs.rmSync(emptyDir, { recursive: true, force: true })
  })

  it('execCpToPod counts files and bytes and reports a verified copy', async () => {
    mockExec.mockImplementation(execSucceeding(''))

    const stats = await execCpToPod('pod', emptyDir, '/__w')

    expect(stats).toMatchObject({
      files: 2,
      bytes: 123,
      transferAttempts: 1,
      verifyAttempts: 1,
      verified: true
    })
    expect(stats.transferMs).toBeGreaterThanOrEqual(0)
    expect(stats.verifyMs).toBeGreaterThanOrEqual(0)
    expect(mockPack).toHaveBeenCalledWith(
      emptyDir,
      expect.objectContaining({ map: expect.any(Function) })
    )
  })

  it('execCpToPod reports a copy whose hash never matched', async () => {
    mockExec.mockImplementation(execSucceeding('5 ./only-in-pod\n'))

    const stats = await execCpToPod('pod', emptyDir, '/__w')

    expect(stats.verified).toBe(false)
    expect(stats.verifyAttempts).toBe(15)
  })

  it('execCpToPod counts only the last transfer attempt', async () => {
    let calls = 0
    const succeed = execSucceeding('')
    mockExec.mockImplementation(async (...args: unknown[]) => {
      calls++
      if (calls === 1) {
        throw new Error('connection reset')
      }
      return succeed(...args)
    })

    const stats = await execCpToPod('pod', emptyDir, '/__w')

    expect(stats.transferAttempts).toBe(2)
    expect(stats.files).toBe(2)
    expect(stats.bytes).toBe(123)
  })

  it('execCpFromPod counts what it extracts and reports a verified copy', async () => {
    mockExec.mockImplementation(execSucceeding(''))
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
      verifyAttempts: 1,
      verified: true
    })
    expect(mockExtract).toHaveBeenCalledWith(
      emptyDir,
      expect.objectContaining({ map: expect.any(Function) })
    )
  })
})
