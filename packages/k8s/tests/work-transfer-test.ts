import { execFile, execFileSync } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import type { AddressInfo } from 'net'
import * as os from 'os'
import * as path from 'path'
import { Readable } from 'stream'
import { promisify } from 'util'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}))

import {
  formatWorkTransfer,
  groupAccessible,
  parseWorkStatus,
  resolveWorkTransfer,
  runnerPodIp,
  startWorkServer,
  streamTo,
  WorkServer,
  workDownloadScript,
  workUrl
} from '../src/k8s/work-transfer'

const execFileAsync = promisify(execFile)

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// A `_work`-like tree: nested directories, a plain file, an executable, an empty file and a
// symlink, with the modes a runner's umask 0022 leaves.
function makeTree(): string {
  const root = tempDir('work-src-')
  fs.mkdirSync(path.join(root, '_temp/_github_home'), { recursive: true })
  fs.mkdirSync(path.join(root, '_actions/owner/action/v1'), { recursive: true })
  fs.mkdirSync(path.join(root, 'repo/repo'), { recursive: true })
  fs.writeFileSync(path.join(root, '_temp/_github_home/.gitconfig'), 'x\n')
  fs.writeFileSync(path.join(root, '_actions/owner/action/v1/action.yml'), 'a')
  fs.writeFileSync(
    path.join(root, '_actions/owner/action/v1/run.sh'),
    '#!/bin/sh\n'
  )
  fs.writeFileSync(path.join(root, '_temp/empty'), '')
  fs.symlinkSync('action.yml', path.join(root, '_actions/owner/action/v1/link'))
  for (const dir of [
    '_temp',
    '_temp/_github_home',
    '_actions',
    'repo',
    'repo/repo'
  ]) {
    fs.chmodSync(path.join(root, dir), 0o755)
  }
  fs.chmodSync(path.join(root, '_temp/_github_home/.gitconfig'), 0o644)
  fs.chmodSync(path.join(root, '_actions/owner/action/v1/action.yml'), 0o644)
  fs.chmodSync(path.join(root, '_actions/owner/action/v1/run.sh'), 0o755)
  return root
}

function mode(file: string): string {
  return (fs.lstatSync(file).mode & 0o777).toString(8)
}

async function get(
  url: string,
  headers: http.OutgoingHttpHeaders = {},
  method = 'GET'
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks)
        })
      )
      response.on('error', reject)
    })
    request.on('error', reject)
    request.end()
  })
}

describe('groupAccessible', () => {
  it('gives the group read and write on files', () => {
    expect(groupAccessible({ type: 'file', mode: 0o644 }).mode).toBe(0o664)
  })

  it('gives the group execute where the owner has it, and on directories', () => {
    expect(groupAccessible({ type: 'file', mode: 0o755 }).mode).toBe(0o775)
    expect(groupAccessible({ type: 'directory', mode: 0o755 }).mode).toBe(0o775)
    expect(groupAccessible({ type: 'directory', mode: 0o700 }).mode).toBe(0o770)
  })

  it('leaves other bits and a header without a mode alone', () => {
    expect(groupAccessible({ type: 'file', mode: 0o4600 }).mode).toBe(0o4660)
    expect(groupAccessible({ type: 'file' })).toEqual({ type: 'file' })
  })
})

describe('resolveWorkTransfer', () => {
  it('defaults to http', () => {
    expect(resolveWorkTransfer(undefined, {})).toEqual({
      mode: 'http',
      source: 'default'
    })
    expect(resolveWorkTransfer({ HOOK_WORK_TRANSFER: '' }, {})).toEqual({
      mode: 'http',
      source: 'default'
    })
  })

  it('takes the job container env first, then the runner env, in any case', () => {
    expect(
      resolveWorkTransfer(
        { HOOK_WORK_TRANSFER: 'EXEC' },
        { HOOK_WORK_TRANSFER: 'http' }
      )
    ).toEqual({ mode: 'exec', source: 'job container env' })
    expect(resolveWorkTransfer({}, { HOOK_WORK_TRANSFER: ' exec ' })).toEqual({
      mode: 'exec',
      source: 'runner env'
    })
  })

  it('warns and uses http for any other value', () => {
    expect(resolveWorkTransfer({ HOOK_WORK_TRANSFER: 'ftp' }, {})).toEqual({
      mode: 'http',
      source: 'default',
      warning:
        'HOOK_WORK_TRANSFER from job container env is "ftp", not http or exec; using http'
    })
  })
})

describe('runnerPodIp', () => {
  const interfaces = {
    lo: [
      { family: 'IPv4', address: '127.0.0.1', internal: true }
    ] as os.NetworkInterfaceInfo[],
    eth0: [
      { family: 'IPv6', address: 'fe80::1', internal: false },
      { family: 'IPv4', address: '10.0.0.7', internal: false }
    ] as os.NetworkInterfaceInfo[]
  }

  it('prefers ACTIONS_RUNNER_POD_IP', () => {
    expect(
      runnerPodIp({ ACTIONS_RUNNER_POD_IP: ' 10.1.2.3 ' }, interfaces)
    ).toBe('10.1.2.3')
  })

  it('falls back to the first non-internal IPv4 address', () => {
    expect(runnerPodIp({}, interfaces)).toBe('10.0.0.7')
    expect(runnerPodIp({ ACTIONS_RUNNER_POD_IP: '' }, interfaces)).toBe(
      '10.0.0.7'
    )
  })

  it('returns undefined when there is no such address', () => {
    expect(runnerPodIp({}, { lo: interfaces.lo })).toBeUndefined()
  })
})

describe('workUrl', () => {
  it('builds the URL, with brackets around an IPv6 address', () => {
    expect(workUrl('10.0.0.7', 4567)).toBe('http://10.0.0.7:4567/work')
    expect(workUrl('fd00::7', 4567)).toBe('http://[fd00::7]:4567/work')
  })
})

describe('parseWorkStatus', () => {
  it('reads a success with its duration', () => {
    expect(parseWorkStatus('ok 3120\n')).toEqual({ ok: true, downloadMs: 3120 })
  })

  it('reports a missing status', () => {
    expect(parseWorkStatus('')).toEqual({
      ok: false,
      reason: 'fs-init left no status'
    })
  })

  it('reports a failure on one line', () => {
    expect(
      parseWorkStatus(
        'failed: curl exit 7, tar exit 0\ncurl: (7) Failed to connect\n'
      )
    ).toEqual({
      ok: false,
      reason: 'failed: curl exit 7, tar exit 0; curl: (7) Failed to connect'
    })
  })

  it('does not take a line that only starts like a success', () => {
    expect(parseWorkStatus('ok soon').ok).toBe(false)
  })
})

describe('formatWorkTransfer', () => {
  it('names files, bytes, both durations and extra requests', () => {
    const stats = {
      requests: 1,
      completed: true,
      files: 11607,
      bytes: 193776844,
      serveMs: 3060,
      receiverMs: 2510
    }
    expect(formatWorkTransfer(stats, 3420)).toBe(
      'copy _work to job pod over HTTP: 11607 files, 184.8 MiB served in 3.1s ' +
        '(2.5s of it waiting on the job pod); fs-init download and unpack 3.4s'
    )
    expect(formatWorkTransfer({ ...stats, requests: 2 }, 3420)).toContain(
      'waiting on the job pod) (2 requests);'
    )
  })
})

describe('streamTo', () => {
  // Serves one request with streamTo(source()), and has the client read the response after
  // waiting clientDelayMs. Returns the measured receiver time and the bytes received.
  async function serve(
    source: () => Readable,
    clientDelayMs: number
  ): Promise<{ receiverMs: number; received: number }> {
    let measured: Promise<{ receiverMs: number }> | undefined
    const server = http.createServer((_request, response) => {
      response.writeHead(200)
      measured = streamTo(source(), response)
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const received = await new Promise<number>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/`, response => {
            response.pause()
            let bytes = 0
            setTimeout(() => {
              response.on('data', chunk => (bytes += chunk.length))
              response.on('end', () => resolve(bytes))
              response.resume()
            }, clientDelayMs)
          })
          .on('error', reject)
      })
      const { receiverMs } = await (measured as Promise<{ receiverMs: number }>)
      return { receiverMs, received }
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  }

  it('counts the time a slow receiver holds the stream up', async () => {
    const data = Buffer.alloc(32 * 1024 * 1024, 1)
    const result = await serve(() => Readable.from([data]), 400)
    expect(result.received).toBe(data.length)
    expect(result.receiverMs).toBeGreaterThanOrEqual(300)
  })

  it('does not count the time spent waiting for a slow source', async () => {
    async function* slow(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 4; i++) {
        await new Promise(resolve => setTimeout(resolve, 100))
        yield Buffer.alloc(1024, 1)
      }
    }
    const result = await serve(() => Readable.from(slow()), 0)
    expect(result.received).toBe(4096)
    expect(result.receiverMs).toBeLessThan(100)
  })

  it('rejects when the source fails', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200)
      const failing = new Readable({
        read() {
          this.destroy(new Error('disk read failed'))
        }
      })
      streamTo(failing, response).catch(error => {
        server.emit('streamError', error)
      })
    })
    const failed = new Promise<Error>(resolve =>
      server.once('streamError', resolve)
    )
    await new Promise<void>(resolve => server.listen(0, resolve))
    try {
      const port = (server.address() as AddressInfo).port
      http.get(`http://127.0.0.1:${port}/`).on('error', () => undefined)
      expect((await failed).message).toBe('disk read failed')
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
})

describe('work server', () => {
  let root: string
  let server: WorkServer
  let url: string
  const cleanup: string[] = []

  beforeEach(async () => {
    root = makeTree()
    cleanup.push(root)
    server = await startWorkServer(root)
    url = workUrl('127.0.0.1', server.port)
  })

  afterEach(async () => {
    await server.close()
    for (const dir of cleanup.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses a fresh 32-byte token each time', async () => {
    const other = await startWorkServer(root)
    try {
      expect(server.token).toMatch(/^[0-9a-f]{64}$/)
      expect(other.token).not.toBe(server.token)
    } finally {
      await other.close()
    }
  })

  it('refuses a request without the token, or with a wrong one', async () => {
    expect((await get(url)).status).toBe(401)
    expect(
      (await get(url, { Authorization: `Bearer ${'0'.repeat(64)}` })).status
    ).toBe(401)
    expect((await get(url, { Authorization: server.token })).status).toBe(401)
    expect(server.stats.completed).toBe(false)
  })

  it('answers 404 to any other path or method', async () => {
    const auth = { Authorization: `Bearer ${server.token}` }
    expect((await get(url.replace('/work', '/other'), auth)).status).toBe(404)
    expect((await get(`${url}/../etc`, auth)).status).toBe(404)
    expect((await get(url, auth, 'POST')).status).toBe(404)
  })

  it('streams the tree as tar, without a root entry, group-accessible', async () => {
    const response = await get(url, { Authorization: `Bearer ${server.token}` })
    expect(response.status).toBe(200)

    const listing = execFileSync('tar', ['tf', '-'], { input: response.body })
      .toString()
      .split('\n')
      .filter(line => line.length > 0)
    expect(listing).not.toContain('.')
    expect(listing).not.toContain('./')
    expect(listing).toContain('_temp/_github_home/.gitconfig')

    const dest = tempDir('work-dest-')
    cleanup.push(dest)
    execFileSync('sh', ['-c', `umask 0002 && tar xf - -C ${dest}`], {
      input: response.body
    })
    expect(
      fs.readFileSync(path.join(dest, '_temp/_github_home/.gitconfig'), 'utf8')
    ).toBe('x\n')
    expect(mode(path.join(dest, '_temp/_github_home/.gitconfig'))).toBe('664')
    expect(mode(path.join(dest, '_actions/owner/action/v1/run.sh'))).toBe('775')
    expect(mode(path.join(dest, '_temp'))).toBe('775')
    expect(mode(path.join(dest, 'repo/repo'))).toBe('775')
    expect(
      fs.readlinkSync(path.join(dest, '_actions/owner/action/v1/link'))
    ).toBe('action.yml')
    expect(fs.statSync(path.join(dest, '_temp/empty')).size).toBe(0)

    // The server records the transfer once the response has been sent.
    await new Promise(resolve => setImmediate(resolve))
    expect(server.stats).toMatchObject({
      completed: true,
      files: 4,
      bytes: 'x\n'.length + 'a'.length + '#!/bin/sh\n'.length,
      requests: 1
    })
  })

  it('stops answering once closed', async () => {
    await server.close()
    await expect(get(url)).rejects.toThrow(/ECONNREFUSED/)
    server = await startWorkServer(root)
  })
})

// The fs-init script, run by the system's sh (dash, as in the runner image) against the real
// server. The builder image has no curl, so a small Node stand-in handles what the script
// passes it: -H, the URL, -f (exit 22 on an HTTP error) and connection errors (exit 7). The
// curl flags themselves are proven on the cluster.
describe('fs-init download script', () => {
  const CURL_STUB = `#!/usr/bin/env node
const http = require('http')
const args = process.argv.slice(2)
const header = args[args.indexOf('-H') + 1]
const [name, ...value] = header.split(': ')
const request = http.get(args[args.length - 1], { headers: { [name]: value.join(': ') } }, response => {
  if (response.statusCode >= 400) {
    process.stderr.write('curl: (22) The requested URL returned error: ' + response.statusCode + '\\n')
    process.exit(22)
  }
  response.on('aborted', () => {
    process.stderr.write('curl: (18) transfer closed with outstanding read data remaining\\n')
    process.exit(18)
  })
  response.pipe(process.stdout)
})
request.on('error', error => {
  process.stderr.write('curl: (7) ' + error.message + '\\n')
  process.exit(7)
})
`
  let scratch: string
  let bin: string
  let work: string
  let status: string

  beforeEach(() => {
    scratch = tempDir('fs-init-')
    bin = path.join(scratch, 'bin')
    work = path.join(scratch, 'work')
    status = path.join(scratch, 'externals/.hook-work')
    fs.mkdirSync(bin)
    fs.mkdirSync(work)
    fs.mkdirSync(path.dirname(status))
    fs.writeFileSync(path.join(bin, 'curl'), CURL_STUB, { mode: 0o755 })
  })

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  async function runScript(
    url: string,
    token: string
  ): Promise<{ status: string; leftovers: string[] }> {
    // Asynchronous on purpose: the server runs in this process.
    await execFileAsync(
      'sh',
      ['-c', `umask 0002 && ${workDownloadScript(work, status)}`],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          HOOK_WORK_URL: url,
          HOOK_WORK_TOKEN: token
        }
      }
    )
    return {
      status: fs.readFileSync(status, 'utf8'),
      leftovers: fs
        .readdirSync(path.dirname(status))
        .filter(file => file !== path.basename(status))
    }
  }

  it('downloads and unpacks the tree and reports ok with the duration', async () => {
    const root = makeTree()
    const server = await startWorkServer(root)
    try {
      const result = await runScript(
        workUrl('127.0.0.1', server.port),
        server.token
      )
      expect(result.status).toMatch(/^ok \d+\n$/)
      expect(parseWorkStatus(result.status).ok).toBe(true)
      expect(result.leftovers).toEqual([])
      expect(
        fs.readFileSync(
          path.join(work, '_actions/owner/action/v1/action.yml'),
          'utf8'
        )
      ).toBe('a')
      expect(mode(path.join(work, '_temp/_github_home/.gitconfig'))).toBe('664')
      expect(mode(path.join(work, '_temp'))).toBe('775')
    } finally {
      await server.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports curl failing on a wrong token, and exits 0', async () => {
    const root = makeTree()
    const server = await startWorkServer(root)
    try {
      const result = await runScript(workUrl('127.0.0.1', server.port), 'wrong')
      const parsed = parseWorkStatus(result.status)
      expect(parsed.ok).toBe(false)
      expect(result.status).toMatch(/^failed: curl exit 22, tar exit \d+\n/)
      expect(result.status).toContain('returned error: 401')
      expect(result.leftovers).toEqual([])
    } finally {
      await server.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a server that is gone, and exits 0', async () => {
    const root = makeTree()
    const server = await startWorkServer(root)
    const url = workUrl('127.0.0.1', server.port)
    await server.close()
    fs.rmSync(root, { recursive: true, force: true })

    const result = await runScript(url, server.token)
    expect(result.status).toMatch(/^failed: curl exit 7, /)
  })

  it('reports a stream cut short as a failure', async () => {
    const root = makeTree()
    const full = execFileSync('tar', ['cf', '-', '-C', root, '.'])
    fs.rmSync(root, { recursive: true, force: true })
    const truncating = http.createServer((_request, response) => {
      response.writeHead(200)
      response.write(full.subarray(0, 700))
      setTimeout(() => response.socket?.destroy(), 50)
    })
    await new Promise<void>(resolve => truncating.listen(0, resolve))
    try {
      const port = (truncating.address() as AddressInfo).port
      const result = await runScript(workUrl('127.0.0.1', port), 'any')
      expect(result.status).toMatch(/^failed: curl exit \d+, tar exit \d+\n/)
      expect(result.status).not.toMatch(/curl exit 0, tar exit 0/)
    } finally {
      truncating.closeAllConnections()
      await new Promise(resolve => truncating.close(resolve))
    }
  })
})
