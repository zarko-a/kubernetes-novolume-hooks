import * as core from '@actions/core'

// Every line this fork adds to the job log starts with this prefix, so the lines can be
// found with one search. Log wording is not an API; the prefix is the stable part.
export const HOOK_LOG_PREFIX = '[custom-hook]'

export function hookInfo(message: string): void {
  core.info(`${HOOK_LOG_PREFIX} ${message}`)
}

export function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`
}

export class Stopwatch {
  private readonly startedAt: number

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now()
  }

  elapsedMs(): number {
    return this.now() - this.startedAt
  }
}

// Minimal view of a tar-fs entry header: only what the counter reads.
export interface TarHeader {
  type?: string | null
  size?: number | null
}

// Counts the regular files and their bytes as tar-fs packs or extracts them. Pass `map`
// as tar-fs's `map` option; it returns each header unchanged.
export class TarEntryCounter {
  files = 0
  bytes = 0

  map = <T extends TarHeader>(header: T): T => {
    if (header.type === 'file') {
      this.files++
      this.bytes += header.size ?? 0
    }
    return header
  }
}

export interface CopyStats {
  // Counted on the last transfer attempt.
  files: number
  bytes: number
  transferAttempts: number
  transferMs: number
  // One comparison of both sides' file listings after the transfer.
  verified: boolean
  runnerFiles?: number
  podFiles?: number
  verifyError?: string
  verifyMs: number
}

export function formatCopyStats(label: string, stats: CopyStats): string {
  const retries =
    stats.transferAttempts > 1 ? ` (${stats.transferAttempts} attempts)` : ''
  const checked = formatSeconds(stats.verifyMs)
  let verify: string
  if (stats.verified) {
    verify = `verified in ${checked}`
  } else if (stats.verifyError !== undefined) {
    verify = `NOT verified, the comparison failed in ${checked}`
  } else {
    verify =
      `NOT verified, runner has ${stats.runnerFiles} files and job pod ` +
      `${stats.podFiles} (checked in ${checked})`
  }
  return (
    `${label}: ${stats.files} files, ${formatBytes(stats.bytes)} in ` +
    `${formatSeconds(stats.transferMs)}${retries}; ${verify}`
  )
}
