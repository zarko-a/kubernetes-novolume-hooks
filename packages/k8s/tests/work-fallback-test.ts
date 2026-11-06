const mockExecListing = jest.fn()
const mockExecCpToPod = jest.fn()
const mockInfo = jest.fn()
const mockWarning = jest.fn()

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: (message: string) => mockInfo(message),
  warning: (message: string) => mockWarning(message),
  error: jest.fn()
}))

jest.mock('../src/k8s', () => ({
  execListing: (...args: unknown[]) => mockExecListing(...args),
  execCpToPod: (...args: unknown[]) => mockExecCpToPod(...args)
}))

import { copyWorkToPod, ServedWork } from '../src/hooks/prepare-job'

const COPY_STATS = {
  files: 3,
  bytes: 30,
  transferAttempts: 1,
  transferMs: 1200,
  verified: true,
  verifyMs: 400
}

function served(): ServedWork {
  return {
    url: 'http://10.0.0.7:4567/work',
    server: {
      port: 4567,
      token: 't',
      stats: {
        requests: 1,
        completed: true,
        files: 11607,
        bytes: 193776844,
        serveMs: 3060,
        receiverMs: 2510
      },
      close: jest.fn()
    }
  }
}

describe('copyWorkToPod', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExecCpToPod.mockResolvedValue(COPY_STATS)
  })

  it('skips the exec copy when fs-init reports ok', async () => {
    mockExecListing.mockResolvedValue('ok 3420\n')
    await copyWorkToPod('pod', '/home/runner/_work', served())

    expect(mockExecListing).toHaveBeenCalledWith('pod', 'job', [
      'sh',
      '-c',
      'cat /github/.hook-work 2>/dev/null || true'
    ])
    expect(mockExecCpToPod).not.toHaveBeenCalled()
    expect(mockWarning).not.toHaveBeenCalled()
    expect(mockInfo).toHaveBeenCalledWith(
      '[custom-hook] copy _work to job pod over HTTP: 11607 files, 184.8 MiB served in ' +
        '3.1s (2.5s of it waiting on the job pod); fs-init download and unpack 3.4s'
    )
  })

  it.each([
    [
      'a failed download',
      'failed: curl exit 7, tar exit 0\ncurl: (7) refused\n',
      'failed: curl exit 7, tar exit 0; curl: (7) refused'
    ],
    ['no status file', '', 'fs-init left no status']
  ])(
    'falls back to the exec copy, with a warning, on %s',
    async (_case, output, reason) => {
      mockExecListing.mockResolvedValue(output)
      await copyWorkToPod('pod', '/home/runner/_work', served())

      expect(mockWarning).toHaveBeenCalledWith(
        `[custom-hook] fs-init did not download _work over HTTP (${reason}); ` +
          'copying it through the API server instead.'
      )
      expect(mockExecCpToPod).toHaveBeenCalledWith(
        'pod',
        '/home/runner/_work',
        '/__w'
      )
      expect(mockInfo).toHaveBeenCalledWith(
        expect.stringContaining('[custom-hook] copy _work to job pod: 3 files')
      )
    }
  )

  it('falls back when the status cannot be read', async () => {
    mockExecListing.mockRejectedValue(new Error('exec broke'))
    await copyWorkToPod('pod', '/home/runner/_work', served())

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('(reading the status failed: exec broke)')
    )
    expect(mockExecCpToPod).toHaveBeenCalledTimes(1)
  })

  it('uses the exec copy without a warning when nothing was served', async () => {
    await copyWorkToPod('pod', '/home/runner/_work', undefined)

    expect(mockExecListing).not.toHaveBeenCalled()
    expect(mockWarning).not.toHaveBeenCalled()
    expect(mockExecCpToPod).toHaveBeenCalledTimes(1)
  })
})
