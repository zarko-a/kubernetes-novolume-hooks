import * as core from '@actions/core'
import { randomBytes } from 'crypto'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { pipeline } from 'stream/promises'
import * as shlex from 'shlex'
import tar from 'tar-fs'
import {
  formatBytes,
  formatSeconds,
  HOOK_LOG_PREFIX,
  Stopwatch,
  TarEntryCounter
} from './hook-log'
import { formatError } from './utils'
import { bearerMatches, streamTo } from './work-transfer'

// Per-step `_temp` sync over HTTP. Each `run:` step used six exec sessions through the API
// server and the kubelet, ~0.1s each: mkdir, the copy of `_temp` in, its check, the merge,
// the copy of `_runner_file_commands` back, and its check. With this, one exec session runs
// the step: a small client (stepClient below, run with the node from the runner's externals
// in `/__e`) downloads `_temp` from a server in this hook process and merges it, the step's
// script runs as before, and the client uploads `_runner_file_commands`. The exec path stays
// as the fallback, used when the client cannot start the step.

// Where prepare_job writes the client on the runner (inside `_work`, so it reaches the job
// pod with `_work`), and where the job container sees it.
export const STEP_CLIENT_DIR = '_custom_hook'
export const STEP_CLIENT_FILE = 'step-client.js'
export const JOB_STEP_CLIENT = `/__w/${STEP_CLIENT_DIR}/${STEP_CLIENT_FILE}`

// The combined command exits with this when the client could not start the step, so the
// hook falls back to the exec path. The server's `started` flag, not this code, is what the
// hook trusts: a step's own script may exit 213 too.
export const STEP_CLIENT_FAILED_EXIT = 213

// The combined command exits with this, before the client and the script, when the runner's
// externals have no Node.js for the job container: the runner ships a musl build
// (`node24_alpine`) for x64 only, so a musl image on arm64 has none. That is expected, not a
// failure, so the hook says so once and uses the exec path. As with 213, the hook believes
// this code only while the server's `started` flag is false.
export const STEP_CLIENT_NO_NODE_EXIT = 214

const COMMANDS_DIR = '_runner_file_commands'

export interface StepServeStats {
  downFiles: number
  downBytes: number
  downMs: number
  // The client unpacked and merged `_temp` and is about to run the step's script.
  started: boolean
  // When the script started and when the client began the upload after it (Date.now()), so
  // the hook can tell the script's time from its own.
  startedAt?: number
  upRequestedAt?: number
  upCompleted: boolean
  upFiles: number
  upBytes: number
  upMs: number
  error?: string
}

export interface StepServer {
  port: number
  token: string
  stats: StepServeStats
  close: () => Promise<void>
}

// Serves, to requests carrying `Authorization: Bearer <token>`:
// - `GET /temp`: a tar of tempDir (the runner's `_temp`), packed as the exec copy packs it;
// - `GET /started`: records that the step's script is about to run;
// - `PUT /commands`: a tar of `_runner_file_commands`, unpacked into tempDir. Entries
//   outside `_runner_file_commands/` are ignored.
// The token is in the exec session's command line, which the API server's audit log and the
// job pod's own processes can see. It grants nothing the job does not already have: reading
// its own `_temp` and writing its own file commands. The server lives for one step.
export async function startStepServer(tempDir: string): Promise<StepServer> {
  const token = randomBytes(32).toString('hex')
  const stats: StepServeStats = {
    downFiles: 0,
    downBytes: 0,
    downMs: 0,
    started: false,
    upCompleted: false,
    upFiles: 0,
    upBytes: 0,
    upMs: 0
  }

  const server = http.createServer((request, response) => {
    if (!bearerMatches(request.headers.authorization, token)) {
      response.writeHead(401).end()
      return
    }
    if (request.method === 'GET' && request.url === '/temp') {
      const timer = new Stopwatch()
      const counter = new TarEntryCounter()
      response.writeHead(200, { 'Content-Type': 'application/x-tar' })
      streamTo(tar.pack(tempDir, { map: counter.map }), response).then(
        () => {
          stats.downFiles = counter.files
          stats.downBytes = counter.bytes
          stats.downMs = timer.elapsedMs()
        },
        error => {
          stats.error = `serving _temp: ${formatError(error)}`
        }
      )
      return
    }
    if (request.method === 'GET' && request.url === '/started') {
      stats.started = true
      stats.startedAt = Date.now()
      response.writeHead(204).end()
      return
    }
    if (request.method === 'PUT' && request.url === '/commands') {
      stats.upRequestedAt = Date.now()
      const timer = new Stopwatch()
      const counter = new TarEntryCounter()
      const isCommands = (name: string | undefined): boolean =>
        name === COMMANDS_DIR || !!name?.startsWith(`${COMMANDS_DIR}/`)
      const extract = tar.extract(tempDir, {
        ignore: (_name, header) => !isCommands(header?.name),
        // Counts only what is written: tar-fs maps an entry before it checks `ignore`.
        map: header => (isCommands(header.name) ? counter.map(header) : header)
      })
      // pipeline resolves once tar-fs has written every file, so the step's outputs are
      // complete before the client's request, and so the exec session, ends.
      pipeline(request, extract).then(
        () => {
          stats.upCompleted = true
          stats.upFiles = counter.files
          stats.upBytes = counter.bytes
          stats.upMs = timer.elapsedMs()
          response.writeHead(204).end()
        },
        error => {
          stats.error = `receiving ${COMMANDS_DIR}: ${formatError(error)}`
          core.debug(stats.error)
          if (!response.headersSent) {
            response.writeHead(500).end()
          }
        }
      )
      return
    }
    response.writeHead(404).end()
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

export function stepServerUrl(ip: string, port: number): string {
  const host = ip.includes(':') ? `[${ip}]` : ip
  return `http://${host}:${port}`
}

// Types only, so erased at compile time: the client stays self-contained.
type Loose = any
type ClientRequire = (id: string) => Loose

// The client, run in the job container as `node step-client.js down|up`. It is serialized
// with toString() (see stepClientProgram), so it must stay self-contained: no imports, no
// module-level helpers, and nothing TypeScript compiles into a helper for the ES5 target
// (async/await, object spread, for-of over iterables). Its settings come from the env:
// HOOK_STEP_URL and HOOK_STEP_TOKEN, plus HOOK_STEP_UNPACK and HOOK_STEP_MERGE (shell
// commands) for `down`, and HOOK_STEP_PACK for `up`.
// - down: `GET /temp` piped into the unpack command, then the merge command, then
//   `GET /started`;
// - up: the pack command's output sent as `PUT /commands`.
// Exits 0 on success; otherwise prints why to stderr and exits 1 at once, whatever is still
// running.
export function stepClient(
  load: ClientRequire,
  mode: string | undefined,
  env: Record<string, string | undefined>,
  exit: (code: number) => void
): void {
  const httpModule = load('http')
  const childProcess = load('child_process')
  const base = env.HOOK_STEP_URL
  const headers = { Authorization: 'Bearer ' + env.HOOK_STEP_TOKEN }

  function fail(message: string): void {
    process.stderr.write(message + '\n')
    exit(1)
  }

  // Runs a shell command; stdin is piped in if given. Calls done(error message or null).
  function shell(
    command: string | undefined,
    stdin: boolean,
    done: (error: string | null) => void
  ): Loose {
    let stderr = ''
    const child = childProcess.spawn('sh', ['-c', command || 'false'], {
      stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'pipe']
    })
    if (stdin) {
      // A command that exits before reading everything closes the pipe; its exit code
      // reports the failure.
      child.stdin.on('error', () => undefined)
    }
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (error: Error) => done(error.message))
    child.on('close', (code: number) => {
      done(
        code === 0
          ? null
          : 'exit ' + code + (stderr ? ': ' + stderr.trim().slice(0, 500) : '')
      )
    })
    return child
  }

  function request(
    method: string,
    path: string,
    onResponse: (response: Loose) => void
  ): Loose {
    const req = httpModule.request(base + path, { method, headers }, onResponse)
    req.on('error', (error: Error) =>
      fail(method + ' ' + path + ': ' + error.message)
    )
    return req
  }

  function expectStatus(
    response: Loose,
    path: string,
    status: number
  ): boolean {
    if (response.statusCode === status) {
      return true
    }
    response.resume()
    fail(path + ': HTTP ' + response.statusCode)
    return false
  }

  if (mode === 'down') {
    request('GET', '/temp', response => {
      if (!expectStatus(response, '/temp', 200)) {
        return
      }
      const unpack = shell(env.HOOK_STEP_UNPACK, true, unpackError => {
        if (unpackError) {
          fail('unpacking _temp: ' + unpackError)
          return
        }
        shell(env.HOOK_STEP_MERGE, false, mergeError => {
          if (mergeError) {
            fail('merging _temp: ' + mergeError)
            return
          }
          request('GET', '/started', started => {
            if (expectStatus(started, '/started', 204)) {
              started.resume()
              exit(0)
            }
          }).end()
        })
      })
      response.on('error', (error: Error) =>
        fail('GET /temp: ' + error.message)
      )
      response.pipe(unpack.stdin)
    }).end()
  } else if (mode === 'up') {
    const upload = request('PUT', '/commands', response => {
      if (expectStatus(response, '/commands', 204)) {
        response.resume()
        exit(0)
      }
    })
    const pack = childProcess.spawn(
      'sh',
      ['-c', env.HOOK_STEP_PACK || 'false'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stderr = ''
    pack.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    pack.on('error', (error: Error) => fail('packing: ' + error.message))
    // The request ends only once the pack command succeeded: an archive cut short by a
    // failure must not reach the server as a complete (possibly empty) one.
    pack.stdout.pipe(upload, { end: false })
    pack.on('close', (code: number) => {
      if (code === 0) {
        upload.end()
        return
      }
      fail('packing exit ' + code + ': ' + stderr.trim().slice(0, 500))
    })
  } else {
    fail('usage: step-client.js down|up')
  }
}

// The client as a file for the job pod: the function's compiled source and a call to it.
export function stepClientProgram(): string {
  return (
    '// Written by the container hook (step-transfer.ts); runs in the job container.\n' +
    `'use strict';\n(${stepClient.toString()})(require, process.argv[2], process.env, ` +
    'function (code) { process.exit(code); });\n'
  )
}

export interface StepCommandOptions {
  url: string
  token: string
  // The step's script, as the job container sees it.
  scriptPath: string
  unpack: string
  merge: string
  pack: string
  client?: string
  // The runner's externals as the job container sees them.
  externals?: string
}

// The one shell command an exec session runs for a step: the client's `down`, the step's
// script (`sh -e <script>`, as the exec path runs it), and on success the client's `up`.
// The client runs with the runner's node24 from `/__e`, the Alpine build when the image uses
// musl. Exits with the script's exit code, or before the script runs with
// STEP_CLIENT_NO_NODE_EXIT (silently) if that node is missing, or STEP_CLIENT_FAILED_EXIT if
// the client failed. Client errors go to the step's stderr, prefixed like the hook's lines.
export function stepCommand(options: StepCommandOptions): string {
  const q = shlex.quote
  const client = q(options.client ?? JOB_STEP_CLIENT)
  const auth = `HOOK_STEP_URL=${q(options.url)} HOOK_STEP_TOKEN=${q(options.token)}`
  return [
    'hook_musl=',
    'for f in /lib/ld-musl-*; do [ -e "$f" ] && hook_musl=_alpine; done',
    `hook_node=${q(options.externals ?? '/__e')}/node24$hook_musl/bin/node`,
    `[ -x "$hook_node" ] || exit ${STEP_CLIENT_NO_NODE_EXIT}`,
    `if ! hook_err=$(${auth} HOOK_STEP_UNPACK=${q(options.unpack)} HOOK_STEP_MERGE=${q(options.merge)} "$hook_node" ${client} down 2>&1 >/dev/null); then`,
    `  echo "${HOOK_LOG_PREFIX} _temp download failed: $hook_err" >&2`,
    `  exit ${STEP_CLIENT_FAILED_EXIT}`,
    'fi',
    `sh -e ${q(options.scriptPath)}`,
    'hook_rc=$?',
    'if [ "$hook_rc" = 0 ]; then',
    `  if ! hook_err=$(${auth} HOOK_STEP_PACK=${q(options.pack)} "$hook_node" ${client} up 2>&1 >/dev/null); then`,
    `    echo "${HOOK_LOG_PREFIX} ${COMMANDS_DIR} upload failed: $hook_err" >&2`,
    '  fi',
    'fi',
    'exit $hook_rc'
  ].join('\n')
}

export function formatStepTransfer(stats: StepServeStats): string {
  return (
    `sync _temp over HTTP: ${stats.downFiles} files, ${formatBytes(stats.downBytes)} ` +
    `down in ${formatSeconds(stats.downMs)}; ${stats.upFiles} files, ` +
    `${formatBytes(stats.upBytes)} up in ${formatSeconds(stats.upMs)}`
  )
}
