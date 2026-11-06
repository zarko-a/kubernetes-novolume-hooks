const mockInfo = jest.fn()
jest.mock('@actions/core', () => ({
  info: (message: string) => mockInfo(message),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}))

import {
  CopyStats,
  formatBytes,
  formatCopyStats,
  formatSeconds,
  HOOK_LOG_PREFIX,
  hookInfo,
  Stopwatch,
  TarEntryCounter
} from '../src/k8s/hook-log'

describe('hook-log', () => {
  beforeEach(() => mockInfo.mockClear())

  it('prefixes every line', () => {
    hookInfo('hello')
    expect(mockInfo).toHaveBeenCalledWith(`${HOOK_LOG_PREFIX} hello`)
    expect(HOOK_LOG_PREFIX).toBe('[custom-hook]')
  })

  it.each([
    [0, '0.0s'],
    [49, '0.0s'],
    [1234, '1.2s'],
    [61000, '61.0s']
  ])('formatSeconds(%p) is %p', (ms, expected) => {
    expect(formatSeconds(ms)).toBe(expected)
  })

  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KiB'],
    [1536, '1.5 KiB'],
    [183 * 1024 * 1024, '183.0 MiB'],
    [3 * 1024 * 1024 * 1024, '3.0 GiB'],
    [5000 * 1024 * 1024 * 1024, '5000.0 GiB']
  ])('formatBytes(%p) is %p', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })

  it('measures elapsed time from construction', () => {
    let now = 1000
    const stopwatch = new Stopwatch(() => now)
    now = 3500
    expect(stopwatch.elapsedMs()).toBe(2500)
    now = 4000
    expect(stopwatch.elapsedMs()).toBe(3000)
  })

  describe('TarEntryCounter', () => {
    it('counts regular files and their bytes only', () => {
      const counter = new TarEntryCounter()
      const headers = [
        { name: 'a', type: 'file', size: 10 },
        { name: 'dir', type: 'directory', size: 0 },
        { name: 'link', type: 'symlink', size: 0 },
        { name: 'b', type: 'file', size: 5 },
        { name: 'empty', type: 'file', size: null },
        { name: 'nosize', type: 'file' }
      ]
      for (const header of headers) {
        expect(counter.map(header)).toBe(header)
      }
      expect(counter.files).toBe(4)
      expect(counter.bytes).toBe(15)
    })

    it('can be passed as a detached function', () => {
      const counter = new TarEntryCounter()
      const map = counter.map
      map({ type: 'file', size: 7 })
      expect(counter.files).toBe(1)
      expect(counter.bytes).toBe(7)
    })
  })

  describe('formatCopyStats', () => {
    const base: CopyStats = {
      files: 11500,
      bytes: 183 * 1024 * 1024,
      transferAttempts: 1,
      transferMs: 20400,
      verifyAttempts: 1,
      verified: true,
      verifyMs: 9800
    }

    it('formats a verified copy', () => {
      expect(formatCopyStats('copy _work to job pod', base)).toBe(
        'copy _work to job pod: 11500 files, 183.0 MiB in 20.4s; verified in 9.8s (1 attempt)'
      )
    })

    it('names transfer retries and verify attempts', () => {
      expect(
        formatCopyStats('copy', {
          ...base,
          transferAttempts: 3,
          verifyAttempts: 2
        })
      ).toBe(
        'copy: 11500 files, 183.0 MiB in 20.4s (3 attempts); verified in 9.8s (2 attempts)'
      )
    })

    it('says when the copy was never verified', () => {
      expect(
        formatCopyStats('copy', {
          ...base,
          verified: false,
          verifyAttempts: 15
        })
      ).toBe(
        'copy: 11500 files, 183.0 MiB in 20.4s; NOT verified after 15 attempts in 9.8s'
      )
    })
  })
})
