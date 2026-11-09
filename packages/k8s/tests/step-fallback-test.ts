import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockExecPodStep = jest.fn()
const mockExecCpToPod = jest.fn()
const mockExecCpFromPod = jest.fn()
const mockStartStepServer = jest.fn()
const mockRunnerPodIp = jest.fn()
const mockInfo = jest.fn()
const mockWarning = jest.fn()

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: (message: string) => mockInfo(message),
  warning: (message: string) => mockWarning(message),
  error: jest.fn()
}))

jest.mock('../src/k8s', () => ({
  execPodStep: (...args: unknown[]) => mockExecPodStep(...args),
  execCpToPod: (...args: unknown[]) => mockExecCpToPod(...args),
  execCpFromPod: (...args: unknown[]) => mockExecCpFromPod(...args),
  extractToPodCommand: (dir: string) => `UNPACK ${dir}`,
  reportPodTrouble: jest.fn(),
  troubleWaitMs: () => 0
}))

jest.mock('../src/k8s/step-transfer', () => ({
  ...jest.requireActual('../src/k8s/step-transfer'),
  startStepServer: (...args: unknown[]) => mockStartStepServer(...args)
}))

jest.mock('../src/k8s/work-transfer', () => ({
  ...jest.requireActual('../src/k8s/work-transfer'),
  runnerPodIp: (...args: unknown[]) => mockRunnerPodIp(...args)
}))

import { runScriptStep } from '../src/hooks/run-script-step'
import { StepServeStats } from '../src/k8s/step-transfer'

const COPY_STATS = {
  files: 3,
  bytes: 30,
  transferAttempts: 1,
  transferMs: 100,
  verified: true,
  verifyMs: 100
}

const ARGS = {
  entryPoint: 'bash',
  entryPointArgs: ['-e', '{0}'],
  environmentVariables: {},
  prependPath: [],
  workingDirectory: '/__w/repo/repo'
}

// What the fake server reports once the step's exec session ends.
let serverStats: StepServeStats
const closeServer = jest.fn()

function stats(overrides: Partial<StepServeStats> = {}): StepServeStats {
  return {
    downFiles: 12,
    downBytes: 10240,
    downMs: 40,
    started: true,
    startedAt: 1000,
    upCompleted: true,
    upRequestedAt: 1300,
    upFiles: 7,
    upBytes: 27,
    upMs: 10,
    ...overrides
  }
}

function isHttpStep(command: string[]): boolean {
  return command[0] === 'sh' && command[2]?.includes('HOOK_STEP_URL')
}

describe('runScriptStep with the per-step HTTP sync', () => {
  let work: string
  let savedEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    jest.clearAllMocks()
    savedEnv = { ...process.env }
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'step-fallback-'))
    fs.mkdirSync(path.join(work, '_temp'))
    fs.mkdirSync(path.join(work, '_custom_hook'))
    process.env.RUNNER_WORKSPACE = path.join(work, 'repo')
    process.env.RUNNER_TEMP = path.join(work, '_temp')
    mockRunnerPodIp.mockReturnValue('10.0.0.7')
    serverStats = stats()
    mockStartStepServer.mockImplementation(async () => ({
      port: 4567,
      token: 'secret-token',
      stats: serverStats,
      close: closeServer
    }))
    mockExecPodStep.mockResolvedValue(0)
    mockExecCpToPod.mockResolvedValue(COPY_STATS)
    mockExecCpFromPod.mockResolvedValue(COPY_STATS)
  })

  afterEach(() => {
    process.env = savedEnv
    fs.rmSync(work, { recursive: true, force: true })
  })

  function execPathRan(): boolean {
    return mockExecCpToPod.mock.calls.length > 0
  }

  it('runs the step in one exec session when the state says http', async () => {
    await runScriptStep(ARGS, { jobPod: 'pod', stepTransfer: 'http' })

    expect(mockExecPodStep).toHaveBeenCalledTimes(1)
    const [command, pod, container] = mockExecPodStep.mock.calls[0]
    expect(isHttpStep(command)).toBe(true)
    expect(command[2]).toContain('http://10.0.0.7:4567')
    expect(command[2]).toMatch(/sh -e \/__w\/_temp\/[0-9a-f-]+\.sh/)
    expect([pod, container]).toEqual(['pod', 'job'])
    expect(execPathRan()).toBe(false)
    expect(mockExecCpFromPod).not.toHaveBeenCalled()
    expect(closeServer).toHaveBeenCalled()
    expect(mockWarning).not.toHaveBeenCalled()
    expect(mockInfo).toHaveBeenCalledWith(
      '[custom-hook] sync _temp over HTTP: 12 files, 10.0 KiB down in 0.0s; ' +
        '7 files, 27 B up in 0.0s'
    )
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[custom-hook\] run_script_step overhead -?\d+\.\ds \(script 0\.3s, total \d+\.\ds\)$/
      )
    )
    // The token never reaches the job log.
    for (const [message] of [
      ...mockInfo.mock.calls,
      ...mockWarning.mock.calls
    ]) {
      expect(message).not.toContain('secret-token')
    }
  })

  it('uses the exec path when prepare_job did not set http', async () => {
    await runScriptStep(ARGS, { jobPod: 'pod' })

    expect(mockStartStepServer).not.toHaveBeenCalled()
    expect(execPathRan()).toBe(true)
    expect(mockExecCpFromPod).toHaveBeenCalled()
    expect(mockExecPodStep.mock.calls.some(([c]) => isHttpStep(c))).toBe(false)
  })

  it('falls back to the exec path, and stays there, when the step did not start', async () => {
    serverStats = stats({ started: false, upCompleted: false })
    mockExecPodStep.mockImplementation(async (command: string[]) => {
      if (isHttpStep(command)) {
        throw new Error('command terminated with exit code 213')
      }
      return 0
    })

    await runScriptStep(ARGS, { jobPod: 'pod', stepTransfer: 'http' })

    expect(mockWarning).toHaveBeenCalledWith(
      '[custom-hook] could not start the step with _temp over HTTP ' +
        '(command terminated with exit code 213); copying _temp through the API ' +
        'server for this and the later steps'
    )
    expect(execPathRan()).toBe(true)
    expect(mockExecCpFromPod).toHaveBeenCalled()
    // The step's script ran once, on the exec path.
    const scripts = mockExecPodStep.mock.calls.filter(
      ([c]) => c[0] === 'sh' && c[1] === '-e'
    )
    expect(scripts).toHaveLength(1)
    expect(fs.existsSync(path.join(work, '_custom_hook/step-http-off'))).toBe(
      true
    )

    jest.clearAllMocks()
    await runScriptStep(ARGS, { jobPod: 'pod', stepTransfer: 'http' })
    expect(mockStartStepServer).not.toHaveBeenCalled()
    expect(execPathRan()).toBe(true)
  })

  it('falls back without a warning, and stays there, when the container has no node for the client', async () => {
    serverStats = stats({ started: false, upCompleted: false })
    mockExecPodStep.mockImplementation(async (command: string[]) => {
      if (isHttpStep(command)) {
        throw new Error(
          'command terminated with non-zero exit code: command terminated with exit code 214'
        )
      }
      return 0
    })

    await runScriptStep(ARGS, { jobPod: 'pod', stepTransfer: 'http' })

    expect(mockWarning).not.toHaveBeenCalled()
    expect(mockInfo).toHaveBeenCalledWith(
      "[custom-hook] _temp goes through the API server in this job: the runner's " +
        "externals have no Node.js for this container's C library and architecture " +
        '(the runner ships a musl build for x64 only)'
    )
    expect(execPathRan()).toBe(true)
    expect(mockExecCpFromPod).toHaveBeenCalled()
    const scripts = mockExecPodStep.mock.calls.filter(
      ([c]) => c[0] === 'sh' && c[1] === '-e'
    )
    expect(scripts).toHaveLength(1)
    expect(fs.existsSync(path.join(work, '_custom_hook/step-http-off'))).toBe(
      true
    )

    jest.clearAllMocks()
    await runScriptStep(ARGS, { jobPod: 'pod', stepTransfer: 'http' })
    expect(mockStartStepServer).not.toHaveBeenCalled()
    expect(mockInfo).not.toHaveBeenCalledWith(
      expect.stringContaining('have no Node.js')
    )
    expect(execPathRan()).toBe(true)
  })

  it('fails a started step that exits 214 itself, without the exec path', async () => {
    serverStats = stats({ upCompleted: false, upRequestedAt: undefined })
    mockExecPodStep.mockRejectedValue(
      new Error('command terminated with exit code 214')
    )

    await expect(
      runScriptStep(ARGS, { jobPod: 'pod', stepTransfer: 'http' })
    ).rejects.toThrow(
      'failed to run script step: command terminated with exit code 214'
    )
    expect(execPathRan()).toBe(false)
    expect(mockInfo).not.toHaveBeenCalledWith(
      expect.stringContaining('have no Node.js')
    )
  })

  it('still warns for an exit code that only starts with 214', async () => {
    serverStats = stats({ started: false, upCompleted: false })
    mockExecPodStep.mockImplementation(async (command: string[]) => {
      if (isHttpStep(command)) {
        throw new Error('command terminated with exit code 2140')
      }
      return 0
    })

    await runScriptStep(ARGS, { jobPod: 'pod', stepTransfer: 'http' })

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('could not start the step with _temp over HTTP')
    )
  })

  it('falls back when the runner pod IP is unknown', async () => {
    mockRunnerPodIp.mockReturnValue(undefined)

    await runScriptStep(ARGS, { jobPod: 'pod', stepTransfer: 'http' })

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining("cannot tell this runner pod's IP")
    )
    expect(mockStartStepServer).not.toHaveBeenCalled()
    expect(execPathRan()).toBe(true)
  })

  it('fails the step, without the exec path, when the started step failed', async () => {
    serverStats = stats({ upCompleted: false, upRequestedAt: undefined })
    mockExecPodStep.mockRejectedValue(
      new Error('command terminated with exit code 3')
    )

    await expect(
      runScriptStep(ARGS, { jobPod: 'pod', stepTransfer: 'http' })
    ).rejects.toThrow(
      'failed to run script step: command terminated with exit code 3'
    )
    expect(mockExecPodStep).toHaveBeenCalledTimes(1)
    expect(execPathRan()).toBe(false)
    expect(mockExecCpFromPod).not.toHaveBeenCalled()
    expect(closeServer).toHaveBeenCalled()
  })

  it('copies the file commands back over exec when the upload did not arrive', async () => {
    serverStats = stats({
      upCompleted: false,
      upRequestedAt: undefined,
      error: 'receiving _runner_file_commands: aborted'
    })

    await runScriptStep(ARGS, { jobPod: 'pod', stepTransfer: 'http' })

    expect(mockWarning).toHaveBeenCalledWith(
      '[custom-hook] _runner_file_commands did not arrive over HTTP ' +
        '(receiving _runner_file_commands: aborted); copying it through the API server instead'
    )
    expect(mockExecCpFromPod).toHaveBeenCalledWith(
      'pod',
      '/__w/_temp/_runner_file_commands',
      path.join(work, '_temp')
    )
    expect(execPathRan()).toBe(false)
  })
})
