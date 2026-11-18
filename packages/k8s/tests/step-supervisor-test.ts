import { ChildProcess, execFile, spawn } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import type { AddressInfo } from 'net'
import * as os from 'os'
import * as path from 'path'
import * as shlex from 'shlex'

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

import {
  STEP_DIR_ROOT,
  STEP_NOT_LAUNCHED_EXIT,
  stepFollowCommand,
  stepLaunchCommand,
  stepRunner,
  stepSignalCommand,
  stepStatusCommand
} from '../src/k8s/step-supervisor'
import {
  STEP_CLIENT_FAILED_EXIT,
  StepServer,
  stepClientProgram,
  stepServerUrl,
  startStepServer
} from '../src/k8s/step-transfer'
import { HOOK_LOG_PREFIX } from '../src/k8s/hook-log'

// The detached-step modes run for real: this test's node runs the client program, the
// system's sh runs the steps, against a step server in this process. A directory stands in
// for the job pod's `/__w/_custom_hook/steps`.

interface Result {
  code: number
  stdout: string
  stderr: string
}

const SECOND = 1000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function until(
  condition: () => boolean,
  timeoutMs = 10 * SECOND
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for a condition')
    }
    await sleep(20)
  }
}

function processState(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
  } catch {
    return undefined
  }
}

function running(pid: number): boolean {
  const state = processState(pid)
  return state !== undefined && state !== 'Z' && state !== 'X'
}

function startTime(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
}

function recordedPid(dir: string, name: string): number {
  return Number(fs.readFileSync(path.join(dir, name), 'utf8').split(' ')[0])
}

describe('stepRunner source', () => {
  it('uses no compiler helper or module-level name', () => {
    expect(stepRunner.toString()).not.toMatch(
      /__awaiter|__generator|__assign|__spread|__read|__values|tslib|\b(?:http|fs|os|shlex|hook_log|utils|step_transfer)_1\b/
    )
  })

  it('uses the same exit codes and log prefix as the hook', () => {
    const source = stepRunner.toString()
    expect(source).toMatch(
      new RegExp(`CLIENT_FAILED_EXIT = ${STEP_CLIENT_FAILED_EXIT}\\b`)
    )
    expect(source).toMatch(
      new RegExp(`NOT_LAUNCHED_EXIT = ${STEP_NOT_LAUNCHED_EXIT}\\b`)
    )
    expect(source).toContain(`'${HOOK_LOG_PREFIX} '`)
  })
})

describe('detached step commands', () => {
  const runner = {
    externals: '/__e',
    missingNodeExit: 214,
    client: '/__w/_custom_hook/step-client.js',
    dir: `${STEP_DIR_ROOT}/abc123`
  }

  it('launches the supervisor with its settings in the env, after the node check', () => {
    const command = stepLaunchCommand({
      ...runner,
      command: "echo 'hi'",
      url: 'http://10.0.0.7:4567',
      token: 'secret',
      orphanSeconds: 15,
      outputLimitMb: 2048
    })
    expect(command).toContain('[ -x "$hook_node" ] || exit 214')
    // As the shell will read it.
    expect(shlex.split(command.split('\n').pop() as string)).toEqual([
      "HOOK_RUN_COMMAND=echo 'hi'",
      'HOOK_RUN_URL=http://10.0.0.7:4567',
      'HOOK_RUN_TOKEN=secret',
      'HOOK_RUN_ORPHAN_SECONDS=15',
      'HOOK_RUN_OUTPUT_LIMIT_MB=2048',
      'exec',
      '$hook_node',
      '/__w/_custom_hook/step-client.js',
      'start',
      '/__w/_custom_hook/steps/abc123'
    ])
  })

  it('follows from the given offsets', () => {
    expect(stepFollowCommand(runner, 12, 3).split('\n').pop()).toBe(
      'exec "$hook_node" /__w/_custom_hook/step-client.js follow /__w/_custom_hook/steps/abc123 12 3'
    )
  })

  it('signals the step', () => {
    expect(stepSignalCommand(runner, 'SIGINT').split('\n').pop()).toBe(
      'exec "$hook_node" /__w/_custom_hook/step-client.js signal /__w/_custom_hook/steps/abc123 SIGINT'
    )
  })

  it('asks what the step recorded', () => {
    expect(stepStatusCommand(runner).split('\n').pop()).toBe(
      'exec "$hook_node" /__w/_custom_hook/step-client.js status /__w/_custom_hook/steps/abc123'
    )
  })
})

describe('detached steps', () => {
  let scratch: string
  let clientFile: string
  let stepsRoot: string
  let server: StepServer
  let extraServer: http.Server | undefined
  const spawned: ChildProcess[] = []

  beforeEach(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'step-supervisor-'))
    clientFile = path.join(scratch, 'step-client.js')
    fs.writeFileSync(clientFile, stepClientProgram())
    stepsRoot = path.join(scratch, 'steps')
    server = await startStepServer(path.join(scratch, 'runner-temp'))
    extraServer = undefined
  })

  afterEach(async () => {
    // Nothing a test started may outlive it: kill every recorded supervisor and group.
    const isDirectory =
      fs.existsSync(stepsRoot) && fs.statSync(stepsRoot).isDirectory()
    for (const name of isDirectory ? fs.readdirSync(stepsRoot) : []) {
      for (const file of ['pgid', 'pid']) {
        try {
          const pid = recordedPid(path.join(stepsRoot, name), file)
          // One test records this process as a stand-in.
          if (pid > 0 && pid !== process.pid) {
            process.kill(file === 'pgid' ? -pid : pid, 'SIGKILL')
          }
        } catch {
          // gone already
        }
      }
    }
    for (const child of spawned.splice(0)) {
      child.kill('SIGKILL')
    }
    await server.close()
    if (extraServer) {
      extraServer.closeAllConnections()
      await new Promise(resolve => extraServer?.close(resolve))
    }
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  function stepDir(id = 'step1'): string {
    return path.join(stepsRoot, id)
  }

  function runEnv(
    command: string,
    overrides: Record<string, string> = {}
  ): Record<string, string> {
    return {
      PATH: process.env.PATH as string,
      HOOK_RUN_COMMAND: command,
      HOOK_RUN_URL: stepServerUrl('127.0.0.1', server.port),
      HOOK_RUN_TOKEN: server.token,
      HOOK_RUN_ORPHAN_SECONDS: '15',
      ...overrides
    }
  }

  async function client(
    args: string[],
    env: Record<string, string> = { PATH: process.env.PATH as string }
  ): Promise<Result> {
    return new Promise(resolve => {
      execFile(
        process.execPath,
        [clientFile, ...args],
        { env },
        (error, stdout, stderr) => {
          const code = error ? Number((error as { code?: number }).code) : 0
          resolve({ code, stdout, stderr })
        }
      )
    })
  }

  function stepFile(name: string, id = 'step1'): string {
    try {
      return fs.readFileSync(path.join(stepDir(id), name), 'utf8')
    } catch {
      return ''
    }
  }

  // Starts a step and ends its reader, as containerd does when the hook's exec session
  // ends: from here on only the supervisor runs it.
  async function startUnread(
    command: string,
    overrides: Record<string, string> = {}
  ): Promise<void> {
    const started = startAttached(stepDir(), runEnv(command, overrides))
    spawned.push(started.child)
    await until(() => fs.existsSync(path.join(stepDir(), 'pgid')))
    started.child.kill('SIGKILL')
    await started.exited
  }

  // Starts `start` with pipes, counting what arrives, like the hook does. With `heartbeat`,
  // it also writes to the reader's stdin as the hook does through its exec session;
  // without, the reader is one whose hook has gone quiet.
  function startAttached(
    dir: string,
    env: Record<string, string>,
    heartbeat = false
  ): {
    child: ChildProcess
    out: () => string
    err: () => string
    exited: Promise<number | null>
  } {
    let out = Buffer.alloc(0)
    let err = Buffer.alloc(0)
    const child = spawn(process.execPath, [clientFile, 'start', dir], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdin?.on('error', () => undefined)
    if (heartbeat) {
      const beat = setInterval(() => child.stdin?.write('\n'), 500)
      child.on('exit', () => clearInterval(beat))
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      out = Buffer.concat([out, chunk])
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err = Buffer.concat([err, chunk])
    })
    const exited = new Promise<number | null>(resolve =>
      child.on('exit', code => resolve(code))
    )
    return {
      child,
      out: () => out.toString(),
      err: () => err.toString(),
      exited
    }
  }

  it('runs the step and returns its output and exit code, without the HOOK_RUN_ env', async () => {
    const result = await client(
      ['start', stepDir()],
      runEnv('echo out; echo err >&2; env | grep -c HOOK_RUN_ || true; exit 3')
    )
    expect(result).toEqual({ code: 3, stdout: 'out\n0\n', stderr: 'err\n' })
    expect(fs.readFileSync(path.join(stepDir(), 'exit'), 'utf8')).toBe('3')
    expect(fs.existsSync(path.join(stepDir(), 'exit.tmp'))).toBe(false)
    // The supervisor was reaped by `start`, not left behind.
    expect(running(recordedPid(stepDir(), 'pid'))).toBe(false)
  }, 20000)

  it('follows from byte offsets, mid-line, on both streams', async () => {
    await client(
      ['start', stepDir()],
      runEnv("printf 'first line\\nsecond line\\n'; printf 'e1\\ne2\\n' >&2")
    )
    const result = await client(['follow', stepDir(), '5', '1'])
    expect(result).toEqual({
      code: 0,
      stdout: ' line\nsecond line\n',
      stderr: '1\ne2\n'
    })
  }, 20000)

  it('keeps the step running when its exec session is killed, and resumes the output', async () => {
    const count =
      'i=0; while [ $i -lt 30 ]; do echo "out $i"; echo "err $i" >&2; i=$((i+1)); sleep 0.05; done; exit 4'
    const started = startAttached(stepDir(), runEnv(count))
    spawned.push(started.child)
    await until(() => started.out().includes('out 3'))
    // What containerd does to the exec's process when the connection drops.
    started.child.kill('SIGKILL')
    await started.exited
    const seenOut = Buffer.byteLength(started.out())
    const seenErr = Buffer.byteLength(started.err())
    const resumed = await client([
      'follow',
      stepDir(),
      String(seenOut),
      String(seenErr)
    ])
    const lines = (prefix: string): string =>
      Array.from({ length: 30 }, (_, i) => `${prefix} ${i}\n`).join('')
    expect(started.out() + resumed.stdout).toBe(lines('out'))
    expect(started.err() + resumed.stderr).toBe(lines('err'))
    expect(resumed.code).toBe(4)
  }, 30000)

  it('reports a step ended by a signal as 128+n and names the signal', async () => {
    const result = await client(
      ['start', stepDir()],
      runEnv('kill -TERM $$; sleep 5')
    )
    expect(result.code).toBe(143)
    expect(result.stderr).toBe('[custom-hook] the step was ended by SIGTERM\n')
    expect(fs.readFileSync(path.join(stepDir(), 'exit'), 'utf8')).toBe(
      '143 SIGTERM'
    )
  }, 20000)

  it('exits 215, printing nothing, when the step was never launched', async () => {
    const result = await client(['follow', stepDir(), '0', '0'])
    expect(result).toEqual({
      code: STEP_NOT_LAUNCHED_EXIT,
      stdout: '',
      stderr: ''
    })
  })

  it('fails at once, and stops the step, when the supervisor dies without an exit code', async () => {
    const started = startAttached(stepDir(), runEnv('sleep 30'))
    spawned.push(started.child)
    await until(() => fs.existsSync(path.join(stepDir(), 'pgid')))
    const leader = recordedPid(stepDir(), 'pgid')
    process.kill(recordedPid(stepDir(), 'pid'), 'SIGKILL')
    const startedAt = Date.now()
    expect(await started.exited).toBe(1)
    expect(Date.now() - startedAt).toBeLessThan(5 * SECOND)
    expect(started.err()).toBe(
      '[custom-hook] the step supervisor exited without recording an exit code; the step was stopped\n'
    )
    await until(() => !running(leader))
  }, 20000)

  it('treats a recorded PID with another start time as a dead supervisor', async () => {
    fs.mkdirSync(stepDir(), { recursive: true })
    fs.writeFileSync(path.join(stepDir(), 'stdout'), 'partial\n')
    fs.writeFileSync(path.join(stepDir(), 'stderr'), '')
    // This process runs, but it is not the supervisor that wrote the record.
    fs.writeFileSync(path.join(stepDir(), 'pid'), `${process.pid} 1`)
    const result = await client(['follow', stepDir(), '0', '0'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('partial\n')
    expect(result.stderr).toContain('exited without recording an exit code')
  }, 20000)

  it("stops an unfinished earlier step's processes, and leaves a finished step's background process alone", async () => {
    const spawnSleep = (): ChildProcess => {
      const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' })
      spawned.push(child)
      return child
    }
    // An earlier step whose hook was killed: no exit file, its group still running.
    const unfinished = spawnSleep()
    const unfinishedDir = stepDir('earlier-unfinished')
    fs.mkdirSync(unfinishedDir, { recursive: true })
    fs.writeFileSync(
      path.join(unfinishedDir, 'pgid'),
      `${unfinished.pid} ${startTime(unfinished.pid as number)}`
    )
    // A finished step that left `nohup server &` running on purpose.
    const background = spawnSleep()
    const finishedDir = stepDir('earlier-finished')
    fs.mkdirSync(finishedDir, { recursive: true })
    fs.writeFileSync(
      path.join(finishedDir, 'pgid'),
      `${background.pid} ${startTime(background.pid as number)}`
    )
    fs.writeFileSync(path.join(finishedDir, 'exit'), '0')

    const result = await client(['start', stepDir()], runEnv('echo next'))

    expect(result).toEqual({
      code: 0,
      stdout: 'next\n',
      stderr:
        '[custom-hook] stopped the processes of an earlier step that did not finish (its hook was interrupted)\n'
    })
    await until(() => !running(unfinished.pid as number))
    expect(running(background.pid as number)).toBe(true)
    expect(fs.readdirSync(stepsRoot)).toEqual(['step1'])
  }, 20000)

  const ORPHANED =
    '[custom-hook] the runner has not answered 2 liveness checks in a row and its hook ' +
    'has stopped reading the output of the step (the hook process or the runner pod is ' +
    'gone); stopping the step'

  it('stops the step when the hook does not answer and nothing reads its output', async () => {
    await server.close()
    const startedAt = Date.now()
    await startUnread('sleep 30', { HOOK_RUN_ORPHAN_SECONDS: '2' })
    await until(() => stepFile('exit') !== '')
    // Two failed polls, then SIGTERM and the grace period before the exit code.
    expect(Date.now() - startedAt).toBeLessThan(
      2 * SECOND + 3 * SECOND + 2 * SECOND
    )
    expect(stepFile('exit')).toBe('143 SIGTERM')
    expect(stepFile('stderr')).toBe(
      `${ORPHANED}\n[custom-hook] the step was ended by SIGTERM\n`
    )
  }, 20000)

  it('stops the step when the hook is gone and only its reader was left behind', async () => {
    // What a killed hook leaves in the job pod: the process of its exec session, which
    // nothing ends, and no more bytes on its stdin.
    await server.close()
    const startedAt = Date.now()
    const started = startAttached(
      stepDir(),
      runEnv('sleep 30', { HOOK_RUN_ORPHAN_SECONDS: '2' })
    )
    spawned.push(started.child)
    expect(await started.exited).toBe(143)
    // The reader's last sign of the hook is its own start; 5s later it no longer counts.
    expect(Date.now() - startedAt).toBeGreaterThan(5 * SECOND)
    expect(Date.now() - startedAt).toBeLessThan(
      5 * SECOND + 3 * SECOND + 3 * SECOND
    )
    // The polls failed all along, so more than the two that were needed.
    expect(started.err()).toMatch(
      /^\[custom-hook\] the runner has not answered \d+ liveness checks in a row and its hook has stopped reading the output of the step \(the hook process or the runner pod is gone\); stopping the step\n\[custom-hook\] the step was ended by SIGTERM\n$/
    )
  }, 30000)

  it('keeps the step while the hook reads its output, though it does not answer', async () => {
    // A pod network blip: the polls fail, the exec session is fine and carries the hook's
    // heartbeat. Longer than a reader stays fresh without one.
    await server.close()
    const started = startAttached(
      stepDir(),
      runEnv('sleep 7; echo done', { HOOK_RUN_ORPHAN_SECONDS: '1' }),
      true
    )
    spawned.push(started.child)
    expect(await started.exited).toBe(0)
    expect(started.out()).toBe('done\n')
    expect(started.err()).toBe('')
  }, 20000)

  it('keeps the step while the hook answers, though nothing reads its output', async () => {
    // An API server restart: the reader is gone, the polls are fine.
    await startUnread('sleep 3; echo done', { HOOK_RUN_ORPHAN_SECONDS: '1' })
    await until(() => stepFile('exit') !== '')
    expect(stepFile('exit')).toBe('0')
    expect(stepFile('stdout')).toBe('done\n')
    expect(stepFile('stderr')).toBe('')
  }, 20000)

  it("kills what ignores the dead-man switch's SIGTERM, though the step's shell has exited", async () => {
    await server.close()
    // As a real step runs: a shell that dies at SIGTERM, and under it something that does
    // not.
    const stubbornFile = path.join(scratch, 'stubborn.pid')
    await startUnread(
      `sh -c 'trap "" TERM; echo $$ > ${stubbornFile}; sleep 60'\nexit $?`,
      { HOOK_RUN_ORPHAN_SECONDS: '1' }
    )
    await until(() => fs.existsSync(stubbornFile))
    const stubborn = Number(fs.readFileSync(stubbornFile, 'utf8'))
    const leader = recordedPid(stepDir(), 'pgid')
    await until(() => !running(leader))
    // The shell is gone, but the exit code waits for the SIGKILL: a recorded exit code
    // tells the next step's barrier that nothing of this step needs stopping.
    expect(running(stubborn)).toBe(true)
    expect(stepFile('exit')).toBe('')
    await until(() => stepFile('exit') !== '')
    await until(() => !running(stubborn), SECOND)
    expect(stepFile('exit')).toBe('143 SIGTERM')
  }, 20000)

  it('leaves the step alone when the hook answers again within the window', async () => {
    const startedAt = Date.now()
    extraServer = http.createServer((request, response) => {
      if (Date.now() - startedAt < 1500) {
        request.socket.destroy()
        return
      }
      response.writeHead(204).end()
    })
    await new Promise<void>(resolve => extraServer?.listen(0, resolve))
    const port = (extraServer.address() as AddressInfo).port
    await startUnread('sleep 4; echo done', {
      HOOK_RUN_ORPHAN_SECONDS: '3',
      HOOK_RUN_URL: stepServerUrl('127.0.0.1', port)
    })
    await until(() => stepFile('exit') !== '')
    expect(stepFile('exit')).toBe('0')
    expect(stepFile('stdout')).toBe('done\n')
    expect(stepFile('stderr')).toBe('')
  }, 20000)

  it('does not take a pause of its own for a hook that is gone', async () => {
    // A starved or frozen container: the supervisor did not run, so it has no failed
    // polls to show, however much time has passed.
    await startUnread('sleep 5; echo done', { HOOK_RUN_ORPHAN_SECONDS: '1' })
    const supervisor = recordedPid(stepDir(), 'pid')
    process.kill(supervisor, 'SIGSTOP')
    await sleep(2500)
    process.kill(supervisor, 'SIGCONT')
    await until(() => stepFile('exit') !== '')
    expect(stepFile('exit')).toBe('0')
    expect(stepFile('stderr')).toBe('')
  }, 20000)

  it('stops a step whose output passes the limit', async () => {
    const started = startAttached(
      stepDir(),
      runEnv("head -c 1500000 /dev/zero | tr '\\0' x; echo; sleep 30", {
        HOOK_RUN_OUTPUT_LIMIT_MB: '1'
      })
    )
    spawned.push(started.child)
    expect(await started.exited).toBe(143)
    expect(started.out()).toHaveLength(1500001)
    expect(started.err()).toBe(
      '[custom-hook] the step wrote more than 1 MiB of output ' +
        '(HOOK_STEP_OUTPUT_LIMIT_MB on the runner); stopping the step\n' +
        '[custom-hook] the step was ended by SIGTERM\n'
    )
  }, 20000)

  const trapInterrupt =
    "trap 'echo interrupted; exit 9' INT; while :; do sleep 0.1; done"

  it("forwards the hook's cancel from the liveness reply, once", async () => {
    const started = startAttached(stepDir(), runEnv(trapInterrupt))
    spawned.push(started.child)
    await until(() => fs.existsSync(path.join(stepDir(), 'pgid')))
    server.cancel.signal = 'SIGINT'
    expect(await started.exited).toBe(9)
    expect(started.out()).toBe('interrupted\n')
  }, 20000)

  it("kills a cancelled step's background children when the step exits", async () => {
    // A non-interactive shell starts `&` children with SIGINT ignored: the trap exits, the
    // child would run on.
    const childFile = path.join(scratch, 'child.pid')
    const started = startAttached(
      stepDir(),
      runEnv(
        `trap 'echo interrupted; exit 9' INT; sleep 3600 & echo $! > ${childFile}; ` +
          'while :; do sleep 0.1; done'
      )
    )
    spawned.push(started.child)
    await until(() => fs.existsSync(path.join(stepDir(), 'pgid')))
    await until(() => fs.existsSync(childFile))
    const child = Number(fs.readFileSync(childFile, 'utf8'))
    server.cancel.signal = 'SIGINT'
    expect(await started.exited).toBe(9)
    await until(() => !running(child))
  }, 20000)

  it('gives the step one SIGINT when the cancel arrives both ways', async () => {
    const stopFile = path.join(scratch, 'stop')
    const started = startAttached(
      stepDir(),
      runEnv(
        `n=0; trap 'n=$((n+1)); echo "interrupt $n"' INT; ` +
          `while [ ! -e ${stopFile} ]; do sleep 0.1; done; echo "total $n"`
      )
    )
    spawned.push(started.child)
    await until(() => fs.existsSync(path.join(stepDir(), 'pgid')))
    // What the hook does on the runner's SIGINT: the liveness reply and an exec session.
    server.cancel.signal = 'SIGINT'
    expect((await client(['signal', stepDir(), 'SIGINT'])).code).toBe(0)
    await until(() => server.cancel.delivered === 'SIGINT')
    // Time for a second SIGINT to arrive, if one were sent, and again through `signal`.
    await sleep(1500)
    expect((await client(['signal', stepDir(), 'SIGINT'])).code).toBe(0)
    fs.writeFileSync(stopFile, '')
    await started.exited
    expect(started.out()).toBe('interrupt 1\ntotal 1\n')
  }, 20000)

  it('leaves the SIGINT to the supervisor while the step has no process group yet', async () => {
    fs.mkdirSync(stepDir(), { recursive: true })
    expect((await client(['signal', stepDir(), 'SIGINT'])).code).toBe(1)
    expect(fs.existsSync(path.join(stepDir(), 'interrupted'))).toBe(false)
  })

  it('sends a signal to the step through `signal`', async () => {
    const started = startAttached(stepDir(), runEnv(trapInterrupt))
    spawned.push(started.child)
    await until(() => fs.existsSync(path.join(stepDir(), 'pgid')))
    expect((await client(['signal', stepDir(), 'SIGINT'])).code).toBe(0)
    expect(await started.exited).toBe(9)
    expect(started.out()).toBe('interrupted\n')
  }, 20000)

  it('keeps reading when the reader gets SIGTERM, as from a step that runs `pkill node`', async () => {
    const started = startAttached(stepDir(), runEnv('sleep 1; echo done'))
    spawned.push(started.child)
    await until(() => fs.existsSync(path.join(stepDir(), 'pgid')))
    started.child.kill('SIGTERM')
    started.child.kill('SIGINT')
    expect(await started.exited).toBe(0)
    expect(started.out()).toBe('done\n')
  }, 20000)

  it("resumes the step's stderr after the barrier's message and a dropped session", async () => {
    const unfinished = spawn('sleep', ['60'], {
      detached: true,
      stdio: 'ignore'
    })
    spawned.push(unfinished)
    const unfinishedDir = stepDir('earlier-unfinished')
    fs.mkdirSync(unfinishedDir, { recursive: true })
    fs.writeFileSync(
      path.join(unfinishedDir, 'pgid'),
      `${unfinished.pid} ${startTime(unfinished.pid as number)}`
    )
    const started = startAttached(
      stepDir(),
      runEnv(
        'echo "err 1" >&2; sleep 1; for i in 2 3 4 5 6 7 8; do echo "err $i" >&2; done'
      )
    )
    spawned.push(started.child)
    await until(() => started.err().includes('err 1'))
    started.child.kill('SIGKILL')
    await started.exited
    const resumed = await client([
      'follow',
      stepDir(),
      '0',
      String(Buffer.byteLength(started.err()))
    ])
    expect(started.err() + resumed.stderr).toBe(
      '[custom-hook] stopped the processes of an earlier step that did not finish (its hook was interrupted)\n' +
        Array.from({ length: 8 }, (_, i) => `err ${i + 1}\n`).join('')
    )
  }, 20000)

  it('runs the step once when it is launched twice', async () => {
    const ranFile = path.join(scratch, 'ran')
    const env = runEnv(`echo ran >> ${ranFile}; sleep 0.5; echo done`)
    const results = await Promise.all([
      client(['start', stepDir()], env),
      client(['start', stepDir()], env)
    ])
    expect(fs.readFileSync(ranFile, 'utf8')).toBe('ran\n')
    // The later reader ends the earlier one; it reads the one step to its end.
    expect(results.some(r => r.code === 0 && r.stdout === 'done\n')).toBe(true)
  }, 20000)

  it('ends the reader an earlier session left behind', async () => {
    const started = startAttached(stepDir(), runEnv('sleep 2; echo done'))
    spawned.push(started.child)
    await until(() => fs.existsSync(path.join(stepDir(), 'follower')))
    const resumed = await client(['follow', stepDir(), '0', '0'])
    expect(resumed).toEqual({ code: 0, stdout: 'done\n', stderr: '' })
    // Killed, not finished: the hook reads the new session.
    expect(await started.exited).toBeNull()
    expect(started.out()).toBe('')
  }, 20000)

  it('does not run a step whose launch was given up', async () => {
    // The directory without a supervisor: what a launch leaves when its session is killed
    // in between. `follow` waits for a supervisor, then closes the step for good.
    fs.mkdirSync(stepDir(), { recursive: true })
    const result = await client(['follow', stepDir(), '0', '0'])
    expect(result).toEqual({
      code: STEP_CLIENT_FAILED_EXIT,
      stdout: '',
      stderr:
        '[custom-hook] the step was never started: its launch was interrupted\n'
    })
    // A supervisor that turns up late finds the step closed.
    const ranFile = path.join(scratch, 'ran')
    const late = await client(
      ['supervise', stepDir()],
      runEnv(`echo ran >> ${ranFile}`)
    )
    expect(late.code).toBe(0)
    expect(fs.existsSync(ranFile)).toBe(false)
  }, 30000)

  it('says what the step has recorded', async () => {
    expect((await client(['status', stepDir()])).stdout).toBe('gone\n')
    const started = startAttached(stepDir(), runEnv('sleep 1; kill -TERM $$'))
    spawned.push(started.child)
    await until(() => fs.existsSync(path.join(stepDir(), 'pgid')))
    expect((await client(['status', stepDir()])).stdout).toBe('running\n')
    await started.exited
    expect((await client(['status', stepDir()])).stdout).toBe(
      'exit 143 SIGTERM\n'
    )
  }, 20000)

  it('exits 213 when the supervisor cannot start', async () => {
    // A file where the steps directory should be: mkdir fails in the supervisor's place.
    fs.writeFileSync(stepsRoot, '')
    const result = await client(['start', stepDir()], runEnv('echo never'))
    expect(result.code).toBe(STEP_CLIENT_FAILED_EXIT)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(
      /^\[custom-hook\] cannot start the step: ENOTDIR/
    )
  }, 20000)
})
