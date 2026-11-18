/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from 'fs'
import { randomBytes } from 'crypto'
import * as stream from 'stream'
import * as core from '@actions/core'
import { RunScriptStepArgs } from 'hooklib'
import {
  execCpFromPod,
  execCpToPod,
  execPodStep,
  extractToPodCommand,
  jobContainerEnded,
  reportPodTrouble,
  troubleWaitMs
} from '../k8s'
import { execExitCode } from '../k8s/exec-status'
import {
  ExecSession,
  installStepCancel,
  JobContainerEndedError,
  killAbandonedStep,
  positiveSetting,
  runDetachedStep
} from '../k8s/step-follow'
import {
  STEP_DIR_ROOT,
  stepFollowCommand,
  stepLaunchCommand,
  stepSignalCommand,
  stepStatusCommand
} from '../k8s/step-supervisor'
import {
  formatError,
  writeRunScript,
  sleep,
  listDirAllCommand,
  mergeTempCommand
} from '../k8s/utils'
import { JOB_CONTAINER_NAME } from './constants'
import { dirname } from 'path'
import * as shlex from 'shlex'
import {
  formatCopyStats,
  formatSeconds,
  HOOK_LOG_PREFIX,
  hookInfo,
  Stopwatch
} from '../k8s/hook-log'
import {
  formatStepTransfer,
  JOB_STEP_CLIENT,
  STEP_CLIENT_DIR,
  STEP_CLIENT_NO_NODE_EXIT,
  StepServer,
  stepCommand,
  startStepServer,
  stepServerUrl
} from '../k8s/step-transfer'
import { runnerPodIp } from '../k8s/work-transfer'

// Written on the runner when a step could not start over HTTP, so the job's later steps go
// straight to the exec path instead of failing the same way first.
const STEP_HTTP_OFF = 'step-http-off'

// Runner settings for detached steps (see step-supervisor.ts), read from the runner's env
// only, so a workflow cannot change them.
const RECONNECT_SETTING = 'HOOK_STEP_RECONNECT_SECONDS'
const RECONNECT_DEFAULT_SECONDS = 300
const ORPHAN_SETTING = 'HOOK_STEP_ORPHAN_SECONDS'
const ORPHAN_DEFAULT_SECONDS = 15
const OUTPUT_LIMIT_SETTING = 'HOOK_STEP_OUTPUT_LIMIT_MB'
const OUTPUT_LIMIT_DEFAULT_MB = 2048
// How often the hook writes to the stdin of the session that reads a step's output.
const HEARTBEAT_MS = 1000

// Test only, from the step's env: drop each of the step's exec sessions after this many
// seconds.
// A workflow could cut its own steps with it, so it works only on a runner whose env sets
// DROP_ALLOWED_SETTING to `true`: the test scale set, never a production one.
const DROP_SETTING = 'HOOK_TEST_DROP_STEP_EXEC_SECONDS'
const DROP_ALLOWED_SETTING = 'HOOK_TEST_ALLOW_STEP_EXEC_DROP'

// Any failure, in the step itself or in the copies around it (a step after an OOM kill fails
// in its first exec with "container not found"), also prints what happened to the job pod.
export async function runScriptStep(
  args: RunScriptStepArgs,
  state
): Promise<void> {
  const startedMs = Date.now()
  try {
    await runScriptStepInPod(args, state)
  } catch (error) {
    await reportPodTrouble(state.jobPod, startedMs, troubleWaitMs(error))
    throw error
  }
}

async function runScriptStepInPod(
  args: RunScriptStepArgs,
  state
): Promise<void> {
  const totalTimer = new Stopwatch()
  // Write the entrypoint first. This will be later coppied to the workflow pod
  const { entryPoint, entryPointArgs, environmentVariables } = args
  const { containerPath, runnerPath } = writeRunScript(
    args.workingDirectory,
    entryPoint,
    entryPointArgs,
    args.prependPath,
    environmentVariables
  )

  const workdir = dirname(process.env.RUNNER_WORKSPACE as string)
  const runnerTemp = `${workdir}/_temp`
  const containerTemp = '/__w/_temp'
  const containerTempSrc = '/__w/_temp_pre'

  if (
    state?.stepTransfer === 'http' &&
    !fs.existsSync(`${workdir}/${STEP_CLIENT_DIR}/${STEP_HTTP_OFF}`)
  ) {
    const done = await runStepOverHttp(
      state.jobPod,
      workdir,
      containerPath,
      runnerPath,
      totalTimer,
      environmentVariables?.[DROP_SETTING]
    )
    if (done) {
      return
    }
  }
  // Ensure base and staging dirs exist before copying
  await execPodStep(
    [
      'sh',
      '-c',
      'mkdir -p /__w && mkdir -p /__w/_temp && mkdir -p /__w/_temp_pre'
    ],
    state.jobPod,
    JOB_CONTAINER_NAME
  )
  const tempStats = await execCpToPod(
    state.jobPod,
    runnerTemp,
    containerTempSrc
  )
  hookInfo(formatCopyStats('copy _temp to job pod', tempStats))

  const mergeTimer = new Stopwatch()
  try {
    await execPodStep(
      ['sh', '-c', mergeTempCommand(containerTempSrc, containerTemp)],
      state.jobPod,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    const message = formatError(err)
    core.debug(`Failed to merge temp directories: ${message}`)
    throw new Error(`failed to merge temp dirs: ${message}`)
  }
  hookInfo(`merge _temp in job pod: ${formatSeconds(mergeTimer.elapsedMs())}`)

  // Execute the entrypoint script
  args.entryPoint = 'sh'
  args.entryPointArgs = ['-e', containerPath]
  const stepTimer = new Stopwatch()
  let stepMs = 0
  try {
    await execPodStep(
      [args.entryPoint, ...args.entryPointArgs],
      state.jobPod,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    const message = formatError(err)
    core.debug(`execPodStep failed: ${message}`)
    throw new Error(`failed to run script step: ${message}`)
  } finally {
    stepMs = stepTimer.elapsedMs()
    try {
      fs.rmSync(runnerPath, { force: true })
    } catch (removeErr) {
      core.debug(`Failed to remove file ${runnerPath}: ${removeErr}`)
    }
  }

  try {
    core.debug(
      `Copying from job pod '${state.jobPod}' ${containerTemp} to ${runnerTemp}`
    )
    const commandStats = await execCpFromPod(
      state.jobPod,
      `${containerTemp}/_runner_file_commands`,
      `${workdir}/_temp`
    )
    hookInfo(
      formatCopyStats('copy _runner_file_commands from job pod', commandStats)
    )
  } catch (error) {
    core.warning('Failed to copy _temp from pod')
  }
  const totalMs = totalTimer.elapsedMs()
  hookInfo(
    `run_script_step overhead ${formatSeconds(totalMs - stepMs)} ` +
      `(script ${formatSeconds(stepMs)}, total ${formatSeconds(totalMs)})`
  )
}

// Runs the step detached (see step-supervisor.ts) with `_temp` synced over HTTP (see
// step-transfer.ts), in one exec session unless the connection drops. Returns false, having
// changed nothing the exec path depends on, when the step could not start that way; the
// caller then runs it on the exec path.
async function runStepOverHttp(
  jobPod: string,
  workdir: string,
  containerPath: string,
  runnerPath: string,
  totalTimer: Stopwatch,
  dropSetting: string | undefined
): Promise<boolean> {
  const runnerTemp = `${workdir}/_temp`
  const ip = runnerPodIp(process.env)
  if (!ip) {
    return fallBack(workdir, "cannot tell this runner pod's IP")
  }
  let server: StepServer
  try {
    server = await startStepServer(runnerTemp)
  } catch (error) {
    return fallBack(workdir, `cannot start the server: ${formatError(error)}`)
  }
  const command = stepCommand({
    url: stepServerUrl(ip, server.port),
    token: server.token,
    scriptPath: containerPath,
    unpack: `mkdir -p /__w/_temp /__w/_temp_pre && ${extractToPodCommand('/__w/_temp_pre')}`,
    merge: mergeTempCommand('/__w/_temp_pre', '/__w/_temp'),
    pack: 'tar cf - -C /__w/_temp _runner_file_commands'
  })
  const reconnect = setting(RECONNECT_SETTING, RECONNECT_DEFAULT_SECONDS)
  const orphan = setting(ORPHAN_SETTING, ORPHAN_DEFAULT_SECONDS)
  const outputLimit = setting(
    OUTPUT_LIMIT_SETTING,
    OUTPUT_LIMIT_DEFAULT_MB,
    'MiB'
  )
  const dropSeconds = testDropSeconds(dropSetting)
  const runner = {
    externals: '/__e',
    missingNodeExit: STEP_CLIENT_NO_NODE_EXIT,
    client: JOB_STEP_CLIENT,
    dir: `${STEP_DIR_ROOT}/${randomBytes(8).toString('hex')}`
  }
  const exec = async (
    shellCommand: string,
    stdout: stream.Writable,
    stderr: stream.Writable,
    session: ExecSession = {}
  ): Promise<void> => {
    const { heartbeat, ...io } = session
    // The heartbeat: a byte a second on the command's stdin (see step-supervisor.ts).
    const stdin = heartbeat ? new stream.PassThrough() : undefined
    const beat = stdin
      ? setInterval(() => stdin.write('\n'), HEARTBEAT_MS)
      : undefined
    try {
      await execPodStep(
        ['sh', '-c', shellCommand],
        jobPod,
        JOB_CONTAINER_NAME,
        stdin,
        { stdout, stderr, ...io }
      )
    } finally {
      clearInterval(beat)
      stdin?.end()
    }
  }
  const cancel = installStepCancel(server.cancel, {
    process,
    signalStep: async signal =>
      exec(stepSignalCommand(runner, signal), discard(), discard()),
    setTimer: (ms, callback) => setTimeout(callback, ms).unref(),
    exit: code => process.exit(code)
  })
  try {
    await runDetachedStep(
      {
        exec,
        jobContainerEnded: async () =>
          jobContainerEnded(jobPod, JOB_CONTAINER_NAME),
        contacted: () => server.stats.contacted,
        sleep,
        now: Date.now,
        setTimer: (ms, callback) => {
          const timer = setTimeout(callback, ms)
          return () => clearTimeout(timer)
        },
        stdout: process.stdout,
        stderr: process.stderr
      },
      {
        launch: stepLaunchCommand({
          ...runner,
          command,
          url: stepServerUrl(ip, server.port),
          token: server.token,
          orphanSeconds: orphan,
          outputLimitMb: outputLimit
        }),
        follow: (stdoutOffset, stderrOffset) =>
          stepFollowCommand(runner, stdoutOffset, stderrOffset),
        status: stepStatusCommand(runner),
        reconnectMs: reconnect * 1000,
        dropAfterMs: dropSeconds ? dropSeconds * 1000 : undefined
      }
    )
  } catch (err) {
    // Only an exit code before the script started is safe to retry on the exec path: the
    // step command has ended without running the script. After a lost connection the
    // supervisor may still run it, so the step fails instead, and is killed first. A
    // cancelled step is not retried either: its exit code is the cancel's doing.
    const exitCode = execExitCode(err)
    if (exitCode === undefined && !(err instanceof JobContainerEndedError)) {
      await killAbandonedStep(server.cancel, sleep)
    }
    if (
      !server.stats.started &&
      exitCode !== undefined &&
      !cancel.cancelled()
    ) {
      const message = formatError(err)
      if (exitCode === STEP_CLIENT_NO_NODE_EXIT) {
        return fallBack(workdir, message, false)
      }
      return fallBack(workdir, message)
    }
    removeRunScript(runnerPath)
    const message = formatError(err)
    core.debug(`execPodStep failed: ${message}`)
    throw new Error(`failed to run script step: ${message}`)
  } finally {
    await cancel.finish()
    await server.close()
  }
  removeRunScript(runnerPath)

  const { stats } = server
  if (!stats.upCompleted) {
    core.warning(
      `${HOOK_LOG_PREFIX} _runner_file_commands did not arrive over HTTP` +
        `${stats.error ? ` (${stats.error})` : ''}; copying it through the API server instead`
    )
    try {
      hookInfo(
        formatCopyStats(
          'copy _runner_file_commands from job pod',
          await execCpFromPod(
            jobPod,
            '/__w/_temp/_runner_file_commands',
            runnerTemp
          )
        )
      )
    } catch (error) {
      core.warning('Failed to copy _temp from pod')
    }
  } else {
    hookInfo(formatStepTransfer(stats))
  }
  const totalMs = totalTimer.elapsedMs()
  if (stats.startedAt !== undefined && stats.upRequestedAt !== undefined) {
    const scriptMs = stats.upRequestedAt - stats.startedAt
    hookInfo(
      `run_script_step overhead ${formatSeconds(totalMs - scriptMs)} ` +
        `(script ${formatSeconds(scriptMs)}, total ${formatSeconds(totalMs)})`
    )
  } else {
    hookInfo(`run_script_step total ${formatSeconds(totalMs)}`)
  }
  return true
}

// `warn` is false for the one expected case, a job container the runner has no Node.js for
// (musl on arm64): the job is fine, so an info line says why its steps take the exec path.
function fallBack(workdir: string, reason: string, warn = true): false {
  if (warn) {
    core.warning(
      `${HOOK_LOG_PREFIX} could not start the step with _temp over HTTP (${reason}); ` +
        'copying _temp through the API server for this and the later steps. They run ' +
        'attached: a dropped connection to the job pod fails them'
    )
  } else {
    hookInfo(
      "_temp goes through the API server in this job: the runner's externals have no " +
        "Node.js for this container's C library and architecture (the runner ships a musl " +
        'build for x64 only). Its steps run attached: a dropped connection to the job ' +
        'pod fails them'
    )
  }
  try {
    fs.writeFileSync(`${workdir}/${STEP_CLIENT_DIR}/${STEP_HTTP_OFF}`, reason)
  } catch (error) {
    core.debug(`cannot record the HTTP fallback: ${formatError(error)}`)
  }
  return false
}

function setting(name: string, fallback: number, unit = 'seconds'): number {
  const { value, warning } = positiveSetting(
    name,
    process.env[name],
    fallback,
    unit
  )
  if (warning) {
    core.warning(`${HOOK_LOG_PREFIX} ${warning}`)
  }
  return value
}

// The step's DROP_SETTING, in seconds, or undefined when it is unset or not allowed here.
function testDropSeconds(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined
  }
  if (process.env[DROP_ALLOWED_SETTING] !== 'true') {
    hookInfo(
      `${DROP_SETTING} is ignored: this runner does not set ${DROP_ALLOWED_SETTING}=true`
    )
    return undefined
  }
  const { value, warning } = positiveSetting(DROP_SETTING, raw, 0, 'seconds')
  if (warning) {
    core.warning(`${HOOK_LOG_PREFIX} ${warning}`)
  }
  return value || undefined
}

function discard(): stream.Writable {
  return new stream.Writable({
    write: (_chunk, _encoding, callback) => callback()
  })
}

function removeRunScript(runnerPath: string): void {
  try {
    fs.rmSync(runnerPath, { force: true })
  } catch (removeErr) {
    core.debug(`Failed to remove file ${runnerPath}: ${removeErr}`)
  }
}
