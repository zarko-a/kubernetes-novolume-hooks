import * as core from '@actions/core'
import { randomBytes, timingSafeEqual } from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import type { AddressInfo } from 'net'
import * as os from 'os'
import tar from 'tar-fs'
import {
  formatBytes,
  formatSeconds,
  Stopwatch,
  TarEntryCounter,
  TarHeader
} from './hook-log'
import { formatError } from './utils'
import { Env, resolveEnvChoice } from './settings'

// The job pod's fs-init container downloads the runner's `_work` straight from the hook
// process over HTTP, instead of the hook streaming it through the API server and the kubelet
// on an exec session after the pod is Running. The exec copy stays as the fallback.

export const WORK_PATH = '/work'

// fs-init's view of the status file, and the job container's (the github volume). It is
// outside `/__w`, so it is never copied back to the runner, and not in the externals volume,
// which is read-only when it is an image volume.
export const FS_INIT_WORK_STATUS = '/mnt/github/.hook-work'
export const JOB_WORK_STATUS = '/github/.hook-work'

export const WORK_URL_ENV = 'HOOK_WORK_URL'
export const WORK_TOKEN_ENV = 'HOOK_WORK_TOKEN'

export const WORK_TRANSFER_ENV = 'HOOK_WORK_TRANSFER'

export type WorkTransferMode = 'http' | 'exec'

export interface WorkTransferSetting {
  mode: WorkTransferMode
  source: string
  warning?: string
}

// HOOK_WORK_TRANSFER: `http` (default) or `exec`. `exec` skips the HTTP attempt, for clusters
// where the job pod cannot reach the runner pod (a NetworkPolicy, a firewall): there every
// job would otherwise wait for curl's connect timeouts and retries before falling back.
export function resolveWorkTransfer(
  jobEnv: Env | undefined,
  runnerEnv: Env
): WorkTransferSetting {
  const { value, source, warning } = resolveEnvChoice<WorkTransferMode>(
    WORK_TRANSFER_ENV,
    ['http', 'exec'],
    'http',
    jobEnv,
    runnerEnv
  )
  return warning ? { mode: value, source, warning } : { mode: value, source }
}

export interface WorkDownload {
  url: string
  // Visible in the pod spec to anyone who can read pods in the namespace. It is only good
  // while the hook's server runs, which is the length of one prepare_job.
  token: string
}

export interface WorkServeStats {
  requests: number
  // The last request that streamed the whole archive.
  completed: boolean
  files: number
  bytes: number
  serveMs: number
  // Part of serveMs spent waiting for the job pod to take more data (the network and
  // fs-init's tar). The rest was spent waiting for the packer (disk reads on the runner).
  receiverMs: number
  error?: string
}

interface PackStream {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  once(event: 'end', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  pause(): unknown
  resume(): unknown
  destroy(): unknown
}

// Streams source into response like pipeline(), and measures how long writes waited for the
// response to drain: that is the receiver's share of the transfer time.
export async function streamTo(
  source: PackStream,
  response: http.ServerResponse
): Promise<{ receiverMs: number }> {
  return new Promise((resolve, reject) => {
    let receiverMs = 0
    source.on('data', chunk => {
      if (!response.write(chunk)) {
        source.pause()
        const waitTimer = new Stopwatch()
        response.once('drain', () => {
          receiverMs += waitTimer.elapsedMs()
          source.resume()
        })
      }
    })
    source.once('end', () => {
      const endTimer = new Stopwatch()
      response.end(() =>
        resolve({ receiverMs: receiverMs + endTimer.elapsedMs() })
      )
    })
    source.once('error', error => {
      response.destroy(error)
      reject(error)
    })
    response.once('close', () => {
      if (!response.writableFinished) {
        source.destroy()
        reject(new Error('the job pod closed the connection'))
      }
    })
  })
}

// tar-fs packs each file with the runner's mode masked by the runner's umask, and fs-init
// unpacks it as uid 1001, so the files arrive owned by 1001. A job container running as
// another non-root uid writes them through group 1001 (fsGroup), so give the group what the
// owner has.
export function groupAccessible<T extends TarHeader & { mode?: number }>(
  header: T
): T {
  if (typeof header.mode !== 'number') {
    return header
  }
  let mode = header.mode | 0o060
  if (header.type === 'directory' || header.mode & 0o100) {
    mode |= 0o010
  }
  return { ...header, mode }
}

// tar-fs packs the root itself as `.`. Unpacking that entry makes tar set the mode and times
// of fs-init's `/mnt/work`, which uid 1001 does not own, and tar then exits 2. Packing the
// root's children leaves the root alone.
function rootEntries(root: string): string[] {
  return fs.readdirSync(root)
}

// Whether an Authorization header carries `Bearer <token>`, compared in constant time.
export function bearerMatches(
  header: string | undefined,
  token: string
): boolean {
  const presented = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  )
}

export interface WorkServer {
  port: number
  token: string
  stats: WorkServeStats
  close: () => Promise<void>
}

// Serves `GET /work` with `Authorization: Bearer <token>` as a tar stream of `root`, until
// close(). Any other request gets 404 or 401.
export async function startWorkServer(root: string): Promise<WorkServer> {
  const token = randomBytes(32).toString('hex')
  const stats: WorkServeStats = {
    requests: 0,
    completed: false,
    files: 0,
    bytes: 0,
    serveMs: 0,
    receiverMs: 0
  }

  const server = http.createServer((request, response) => {
    stats.requests++
    if (request.method !== 'GET' || request.url !== WORK_PATH) {
      response.writeHead(404).end()
      return
    }
    if (!bearerMatches(request.headers.authorization, token)) {
      response.writeHead(401).end()
      return
    }

    const timer = new Stopwatch()
    const counter = new TarEntryCounter()
    let pack: PackStream
    try {
      pack = tar.pack(root, {
        entries: rootEntries(root),
        umask: 0,
        map: header => counter.map(groupAccessible(header))
      })
    } catch (error) {
      stats.error = formatError(error)
      response.writeHead(500).end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/x-tar' })
    streamTo(pack, response).then(
      ({ receiverMs }) => {
        stats.completed = true
        stats.files = counter.files
        stats.bytes = counter.bytes
        stats.serveMs = timer.elapsedMs()
        stats.receiverMs = receiverMs
        stats.error = undefined
      },
      error => {
        stats.error = formatError(error)
        core.debug(`serving _work failed: ${stats.error}`)
      }
    )
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    port: (server.address() as AddressInfo).port,
    token,
    stats,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

// The runner pod's IP: ACTIONS_RUNNER_POD_IP (downward API, status.podIP) if set, otherwise
// the first non-internal IPv4 address of this container.
export function runnerPodIp(
  env: Record<string, string | undefined>,
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()
): string | undefined {
  const fromEnv = env.ACTIONS_RUNNER_POD_IP?.trim()
  if (fromEnv) {
    return fromEnv
  }
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address
      }
    }
  }
  return undefined
}

export function workUrl(ip: string, port: number): string {
  const host = ip.includes(':') ? `[${ip}]` : ip
  return `http://${host}:${port}${WORK_PATH}`
}

// Shell script for fs-init (the runner image: dash, GNU tar and date, curl). Downloads the
// archive into workDir and writes one status line to statusPath: `ok <milliseconds>`, or
// `failed: ...` with curl's and tar's exit codes and stderr. It always exits 0: a failed
// download must not fail the pod, because the hook falls back to the exec copy.
//
// curl's exit code is kept in a file because POSIX sh has no pipefail. `--retry` cannot mix
// two archives in tar's input: a retry after a partial body corrupts the stream, tar fails,
// and the fallback runs.
export function workDownloadScript(
  workDir = '/mnt/work',
  statusPath = FS_INIT_WORK_STATUS
): string {
  return [
    '(',
    `W=${statusPath}`,
    'start=$(date +%s%3N)',
    `{ curl -fsS --retry 2 --retry-connrefused --retry-delay 1 --connect-timeout 3 --speed-limit 1024 --speed-time 30 -H "Authorization: Bearer $${WORK_TOKEN_ENV}" "$${WORK_URL_ENV}" 2>"$W.curl-err"; echo $? >"$W.curl-rc"; } | tar xf - -C ${workDir} 2>"$W.tar-err"`,
    'tar_rc=$?',
    'curl_rc=$(cat "$W.curl-rc")',
    'if [ "$curl_rc" = 0 ] && [ "$tar_rc" = 0 ]; then',
    '  echo "ok $(($(date +%s%3N) - start))" >"$W"',
    'else',
    '  { echo "failed: curl exit $curl_rc, tar exit $tar_rc"; cat "$W.curl-err" "$W.tar-err" | head -c 1000; } >"$W"',
    'fi',
    'rm -f "$W.curl-rc" "$W.curl-err" "$W.tar-err"',
    ') || true'
  ].join('\n')
}

export type WorkStatus =
  | { ok: true; downloadMs: number }
  | { ok: false; reason: string }

// Reads what the job container saw in the status file (`cat` output, empty if missing).
export function parseWorkStatus(output: string): WorkStatus {
  const text = output.trim()
  const ok = /^ok (\d+)$/.exec(text)
  if (ok) {
    return { ok: true, downloadMs: Number(ok[1]) }
  }
  if (!text) {
    return { ok: false, reason: 'fs-init left no status' }
  }
  return { ok: false, reason: text.split('\n').join('; ') }
}

export function formatWorkTransfer(
  stats: WorkServeStats,
  downloadMs: number
): string {
  const requests = stats.requests > 1 ? ` (${stats.requests} requests)` : ''
  return (
    `copy _work to job pod over HTTP: ${stats.files} files, ${formatBytes(stats.bytes)} ` +
    `served in ${formatSeconds(stats.serveMs)} (${formatSeconds(stats.receiverMs)} of it ` +
    `waiting on the job pod)${requests}; fs-init download and unpack ` +
    `${formatSeconds(downloadMs)}`
  )
}
