import * as core from '@actions/core'
import { ChildProcess, spawn } from 'child_process'
import * as shlex from 'shlex'
import { Stopwatch } from './hook-log'

// Files the runner has just written to `_work` (the action downloads in "Set up job") are
// often not in the runner pod's page cache by the time prepare_job copies them, so packing
// them reads every file from the node's root volume, one at a time. On gp3 that is ~1 ms
// per file: 11.6k files took 11-13s, while the same pack from page cache took 1.4s (measured
// on the runner pod, 2026-11-06). Reading the files with many readers at once keeps the
// volume's queue full; the packer that follows finds them in the cache.

export const READ_AHEAD_PARALLEL = 32

// `cat` per batch of files, READ_AHEAD_PARALLEL batches at a time. Errors are ignored: a
// file that cannot be read now fails the copy itself, with a better message.
export function readAheadCommand(
  root: string,
  parallel = READ_AHEAD_PARALLEL
): string {
  return (
    `find ${shlex.quote(root)} -type f -print0 2>/dev/null | ` +
    `xargs -0 -r -P ${parallel} -n 64 cat >/dev/null 2>&1; exit 0`
  )
}

export interface ReadAhead {
  // Milliseconds the read-ahead took, or undefined if it was stopped first.
  finished: Promise<number | undefined>
  stop: () => void
}

// Starts reading root into the page cache in the background. Never throws and never fails
// the job: it only makes the copy that follows faster.
export function startReadAhead(
  root: string,
  env: Record<string, string | undefined> = process.env
): ReadAhead {
  const timer = new Stopwatch()
  let child: ChildProcess | undefined
  const finished = new Promise<number | undefined>(resolve => {
    try {
      child = spawn('sh', ['-c', readAheadCommand(root)], {
        env,
        stdio: 'ignore',
        // Its own process group, so stop() can end find, xargs and every cat at once.
        detached: true
      })
    } catch (error) {
      core.debug(`read-ahead did not start: ${error}`)
      resolve(undefined)
      return
    }
    child.on('error', error => {
      core.debug(`read-ahead failed: ${error}`)
      resolve(undefined)
    })
    child.on('exit', (_code, signal) =>
      resolve(signal ? undefined : timer.elapsedMs())
    )
  })
  return {
    finished,
    stop: () => {
      if (child?.pid !== undefined && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    }
  }
}
