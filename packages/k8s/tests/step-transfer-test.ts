import { execFile } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}))

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn().mockReturnValue({}),
    getContexts: jest.fn().mockReturnValue([{ namespace: 'test-namespace' }])
  })),
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  CoreV1Api: class CoreV1Api {},
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  AuthorizationV1Api: class AuthorizationV1Api {}
}))

import { extractToPodCommand } from '../src/k8s'
import { mergeTempCommand } from '../src/k8s/utils'
import {
  formatStepTransfer,
  STEP_CLIENT_FAILED_EXIT,
  STEP_CLIENT_NO_NODE_EXIT,
  stepClient,
  stepClientProgram,
  stepCommand,
  StepServer,
  stepServerUrl,
  startStepServer
} from '../src/k8s/step-transfer'

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8')
}

interface Result {
  code: number
  stdout: string
  stderr: string
}

// Asynchronous on purpose: the server runs in this process. A child does not see
// process.env changes made in Jest's sandbox, so env is passed explicitly.
async function run(
  file: string,
  args: string[],
  env: Record<string, string>
): Promise<Result> {
  return new Promise(resolve => {
    execFile(
      file,
      args,
      { env: { PATH: process.env.PATH as string, ...env } },
      (error, stdout, stderr) => {
        const code = error ? Number((error as { code?: number }).code) : 0
        resolve({ code, stdout, stderr })
      }
    )
  })
}

async function request(
  url: string,
  headers: http.OutgoingHttpHeaders = {},
  method = 'GET'
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, response => {
      response.resume()
      resolve(response.statusCode as number)
    })
    req.on('error', reject)
    req.end()
  })
}

describe('stepClient source', () => {
  // It runs as text in the job container, so it must not lean on anything outside itself.
  it('uses no compiler helper or module-level name', () => {
    const source = stepClient.toString()
    // TypeScript's helpers, and the names it gives imported modules (`<module>_1`).
    expect(source).not.toMatch(
      /__awaiter|__generator|__assign|__spread|__read|__values|tslib|\b(?:http|crypto|shlex|tar_fs|hook_log|utils|work_transfer|promises|core)_1\b/
    )
  })

  it('is written as a program that calls it with node globals', () => {
    const program = stepClientProgram()
    expect(program).toContain(stepClient.toString())
    expect(program).toMatch(/\(require, process\.argv\[2\], process\.env, /)
  })
})

// The client and the whole step command run for real: node (this test's) for the client,
// the system's sh (dash in the builder image) and GNU tar, against the server in this
// process. Directories stand in for the runner's `_temp` and the job pod's `/__w`.
describe('per-step _temp sync', () => {
  let scratch: string
  let runnerTemp: string
  let jobWork: string
  let externals: string
  let clientFile: string
  let server: StepServer
  let url: string

  beforeEach(async () => {
    scratch = tempDir('step-transfer-')
    runnerTemp = path.join(scratch, 'runner/_work/_temp')
    jobWork = path.join(scratch, 'job/__w')
    externals = path.join(scratch, 'job/__e')
    clientFile = path.join(jobWork, '_custom_hook/step-client.js')
    write(path.join(runnerTemp, 'script.sh'), 'echo "hello from the step"\n')
    write(path.join(runnerTemp, '_github_home/.gitconfig'), '[user]\n')
    write(path.join(runnerTemp, '_runner_file_commands/set_env_1'), '')
    write(clientFile, stepClientProgram())
    // A file the job wrote in an earlier step: the merge keeps it.
    write(path.join(jobWork, '_temp/earlier.txt'), 'earlier\n')
    fs.mkdirSync(path.join(externals, 'node24/bin'), { recursive: true })
    fs.symlinkSync(process.execPath, path.join(externals, 'node24/bin/node'))
    server = await startStepServer(runnerTemp)
    url = stepServerUrl('127.0.0.1', server.port)
  })

  afterEach(async () => {
    await server.close()
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  function clientEnv(token = server.token): Record<string, string> {
    return {
      HOOK_STEP_URL: url,
      HOOK_STEP_TOKEN: token,
      HOOK_STEP_UNPACK: `mkdir -p ${jobWork}/_temp ${jobWork}/_temp_pre && ${extractToPodCommand(`${jobWork}/_temp_pre`)}`,
      HOOK_STEP_MERGE: mergeTempCommand(
        `${jobWork}/_temp_pre`,
        `${jobWork}/_temp`
      ),
      HOOK_STEP_PACK: `tar cf - -C ${jobWork}/_temp _runner_file_commands`
    }
  }

  function command(script: string): string {
    const env = clientEnv()
    return stepCommand({
      url,
      token: server.token,
      scriptPath: script,
      unpack: env.HOOK_STEP_UNPACK,
      merge: env.HOOK_STEP_MERGE,
      pack: env.HOOK_STEP_PACK,
      client: clientFile,
      externals
    })
  }

  it('down: unpacks and merges _temp, then reports the step started', async () => {
    const result = await run(
      process.execPath,
      [clientFile, 'down'],
      clientEnv()
    )
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(read(path.join(jobWork, '_temp/script.sh'))).toContain('hello')
    expect(read(path.join(jobWork, '_temp/_github_home/.gitconfig'))).toBe(
      '[user]\n'
    )
    expect(read(path.join(jobWork, '_temp/earlier.txt'))).toBe('earlier\n')
    expect(fs.existsSync(path.join(jobWork, '_temp_pre'))).toBe(false)
    expect(server.stats).toMatchObject({
      started: true,
      downFiles: 3
    })
  })

  it('up: sends _runner_file_commands to the runner and nothing else', async () => {
    write(
      path.join(jobWork, '_temp/_runner_file_commands/set_output_2'),
      'a=1\n'
    )
    write(path.join(jobWork, '_temp/other.txt'), 'not sent\n')
    const result = await run(process.execPath, [clientFile, 'up'], {
      ...clientEnv(),
      // A tar that also carries an entry outside _runner_file_commands.
      HOOK_STEP_PACK: `tar cf - -C ${jobWork}/_temp _runner_file_commands other.txt`
    })
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(
      read(path.join(runnerTemp, '_runner_file_commands/set_output_2'))
    ).toBe('a=1\n')
    expect(fs.existsSync(path.join(runnerTemp, 'other.txt'))).toBe(false)
    expect(server.stats).toMatchObject({ upCompleted: true, upFiles: 1 })
  })

  it('fails without the token, and the step is not started', async () => {
    const result = await run(
      process.execPath,
      [clientFile, 'down'],
      clientEnv('wrong')
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('/temp: HTTP 401\n')
    expect(server.stats.started).toBe(false)
    expect(await request(`${url}/started`)).toBe(401)
    expect(server.stats.started).toBe(false)
  })

  it('fails when the unpack command fails, with its stderr', async () => {
    const result = await run(process.execPath, [clientFile, 'down'], {
      ...clientEnv(),
      HOOK_STEP_UNPACK: 'echo "no space left" >&2; exit 2'
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('unpacking _temp: exit 2: no space left\n')
    expect(server.stats.started).toBe(false)
  })

  it('fails when the server is gone', async () => {
    await server.close()
    const result = await run(
      process.execPath,
      [clientFile, 'down'],
      clientEnv()
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^GET \/temp: .*ECONNREFUSED/)
    server = await startStepServer(runnerTemp)
  })

  it('answers 404 to anything else', async () => {
    const auth = { Authorization: `Bearer ${server.token}` }
    expect(await request(`${url}/work`, auth)).toBe(404)
    expect(await request(`${url}/temp`, auth, 'PUT')).toBe(404)
  })

  it('runs the step between the two transfers, keeping its output and exit code', async () => {
    write(
      path.join(runnerTemp, 'step.sh'),
      `echo "step out"\necho "step err" >&2\necho "ran" > ${jobWork}/_temp/_runner_file_commands/set_output_9\n`
    )
    const result = await run(
      'sh',
      ['-c', command(`${jobWork}/_temp/step.sh`)],
      {}
    )
    expect(result).toEqual({
      code: 0,
      stdout: 'step out\n',
      stderr: 'step err\n'
    })
    expect(
      read(path.join(runnerTemp, '_runner_file_commands/set_output_9'))
    ).toBe('ran\n')
    expect(server.stats).toMatchObject({ started: true, upCompleted: true })
    expect(server.stats.upRequestedAt).toBeGreaterThanOrEqual(
      server.stats.startedAt as number
    )
  })

  it('returns a failing step exit code and sends nothing back', async () => {
    write(path.join(runnerTemp, 'step.sh'), 'echo "about to fail"\nexit 3\n')
    const result = await run(
      'sh',
      ['-c', command(`${jobWork}/_temp/step.sh`)],
      {}
    )
    expect(result).toEqual({ code: 3, stdout: 'about to fail\n', stderr: '' })
    expect(server.stats).toMatchObject({ started: true, upCompleted: false })
  })

  it('stops before the step when the client cannot start it', async () => {
    write(path.join(runnerTemp, 'step.sh'), `touch ${scratch}/step-ran\n`)
    const env = clientEnv('wrong')
    const result = await run(
      'sh',
      [
        '-c',
        stepCommand({
          url,
          token: 'wrong',
          scriptPath: `${jobWork}/_temp/step.sh`,
          unpack: env.HOOK_STEP_UNPACK,
          merge: env.HOOK_STEP_MERGE,
          pack: env.HOOK_STEP_PACK,
          client: clientFile,
          externals
        })
      ],
      {}
    )
    expect(result.code).toBe(STEP_CLIENT_FAILED_EXIT)
    expect(result.stderr).toBe(
      '[custom-hook] _temp download failed: /temp: HTTP 401\n'
    )
    expect(fs.existsSync(`${scratch}/step-ran`)).toBe(false)
    expect(server.stats.started).toBe(false)
  })

  it('stops quietly before the client and the step when there is no node in the externals', async () => {
    fs.rmSync(path.join(externals, 'node24'), { recursive: true })
    write(path.join(runnerTemp, 'step.sh'), `touch ${scratch}/step-ran\n`)
    const result = await run(
      'sh',
      ['-c', command(`${jobWork}/_temp/step.sh`)],
      {}
    )
    expect(result.code).toBe(STEP_CLIENT_NO_NODE_EXIT)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(fs.existsSync(`${scratch}/step-ran`)).toBe(false)
    expect(server.stats.started).toBe(false)
  })

  it('treats a node that is not executable like a missing one', async () => {
    fs.rmSync(path.join(externals, 'node24'), { recursive: true })
    write(path.join(externals, 'node24/bin/node'), '#!/bin/sh\nexit 0\n')
    fs.chmodSync(path.join(externals, 'node24/bin/node'), 0o644)
    write(path.join(runnerTemp, 'step.sh'), `touch ${scratch}/step-ran\n`)
    const result = await run(
      'sh',
      ['-c', command(`${jobWork}/_temp/step.sh`)],
      {}
    )
    expect(result.code).toBe(STEP_CLIENT_NO_NODE_EXIT)
    expect(fs.existsSync(`${scratch}/step-ran`)).toBe(false)
  })

  it('reports an upload failure on stderr and keeps the step exit code', async () => {
    write(path.join(runnerTemp, 'step.sh'), 'echo "ok"\n')
    const env = clientEnv()
    const result = await run(
      'sh',
      [
        '-c',
        stepCommand({
          url,
          token: server.token,
          scriptPath: `${jobWork}/_temp/step.sh`,
          unpack: env.HOOK_STEP_UNPACK,
          merge: env.HOOK_STEP_MERGE,
          pack: 'echo "tar: cannot open" >&2; exit 2',
          client: clientFile,
          externals
        })
      ],
      {}
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('ok\n')
    expect(result.stderr).toMatch(
      /^\[custom-hook\] _runner_file_commands upload failed: packing exit 2: tar: cannot open\n/
    )
    expect(server.stats.upCompleted).toBe(false)
  })
})

describe('formatStepTransfer', () => {
  it('names both directions', () => {
    expect(
      formatStepTransfer({
        downFiles: 12,
        downBytes: 10240,
        downMs: 40,
        started: true,
        upCompleted: true,
        upFiles: 7,
        upBytes: 27,
        upMs: 10
      })
    ).toBe(
      'sync _temp over HTTP: 12 files, 10.0 KiB down in 0.0s; 7 files, 27 B up in 0.0s'
    )
  })
})
