/* eslint-disable @typescript-eslint/no-unused-vars */
import * as fs from 'fs'
import * as core from '@actions/core'
import { RunScriptStepArgs } from 'hooklib'
import {
  execCpFromPod,
  execCpToPod,
  execPodStep,
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
  hookInfo,
  Stopwatch
} from '../k8s/hook-log'

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
