/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from 'fs'
import * as core from '@actions/core'
import { RunScriptStepArgs } from 'hooklib'
import {
  execCpFromPod,
  execCpToPod,
  execPodStep,
  extractToPodCommand,
  reportPodTrouble,
  troubleWaitMs
} from '../k8s'
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
  STEP_CLIENT_DIR,
  StepServer,
  stepCommand,
  startStepServer,
  stepServerUrl
} from '../k8s/step-transfer'
import { runnerPodIp } from '../k8s/work-transfer'

// Written on the runner when a step could not start over HTTP, so the job's later steps go
// straight to the exec path instead of failing the same way first.
const STEP_HTTP_OFF = 'step-http-off'

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
      totalTimer
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

// Runs the step in one exec session that syncs `_temp` over HTTP (see step-transfer.ts).
// Returns false, having changed nothing the exec path depends on, when the step could not
// start that way; the caller then runs it on the exec path.
async function runStepOverHttp(
  jobPod: string,
  workdir: string,
  containerPath: string,
  runnerPath: string,
  totalTimer: Stopwatch
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
  try {
    await execPodStep(['sh', '-c', command], jobPod, JOB_CONTAINER_NAME)
  } catch (err) {
    if (!server.stats.started) {
      return fallBack(workdir, formatError(err))
    }
    removeRunScript(runnerPath)
    const message = formatError(err)
    core.debug(`execPodStep failed: ${message}`)
    throw new Error(`failed to run script step: ${message}`)
  } finally {
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

function fallBack(workdir: string, reason: string): false {
  core.warning(
    `${HOOK_LOG_PREFIX} could not start the step with _temp over HTTP (${reason}); ` +
      'copying _temp through the API server for this and the later steps'
  )
  try {
    fs.writeFileSync(`${workdir}/${STEP_CLIENT_DIR}/${STEP_HTTP_OFF}`, reason)
  } catch (error) {
    core.debug(`cannot record the HTTP fallback: ${formatError(error)}`)
  }
  return false
}

function removeRunScript(runnerPath: string): void {
  try {
    fs.rmSync(runnerPath, { force: true })
  } catch (removeErr) {
    core.debug(`Failed to remove file ${runnerPath}: ${removeErr}`)
  }
}
