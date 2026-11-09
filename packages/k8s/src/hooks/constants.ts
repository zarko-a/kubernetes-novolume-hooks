import { randomUUID } from 'crypto'

export function getRunnerPodName(): string {
  const name = process.env.ACTIONS_RUNNER_POD_NAME
  if (!name) {
    throw new Error(
      "'ACTIONS_RUNNER_POD_NAME' env is required, please contact your self hosted runner administrator"
    )
  }
  return name
}

// ARC names a runner pod `<scale set>-runner-<5 random characters>`, and that random tail is
// all that tells two runners of one set apart. Cutting a long name from the end, as upstream
// did, dropped the tail first: with a scale set name over 41 characters, concurrent jobs got
// the same job pod name and failed with 409 AlreadyExists. A name that does not fit loses
// characters from the middle instead, and keeps its last RUNNER_NAME_TAIL_LENGTH.
export const RUNNER_NAME_TAIL_LENGTH = '-runner-'.length + 5

export function shortenRunnerName(name: string, maxLength: number): string {
  if (name.length <= maxLength) {
    return name
  }
  const tail = name.slice(-RUNNER_NAME_TAIL_LENGTH)
  // A pod name's DNS labels must not end in `-` or `.` where the cut falls.
  const head = name.substring(0, maxLength - tail.length).replace(/[-.]+$/, '')
  return `${head}${tail}`
}

export function getJobPodName(): string {
  return `${shortenRunnerName(
    getRunnerPodName(),
    MAX_POD_NAME_LENGTH - '-workflow'.length
  )}-workflow`
}

export function getStepPodName(): string {
  return `${shortenRunnerName(
    getRunnerPodName(),
    MAX_POD_NAME_LENGTH - ('-step-'.length + STEP_POD_NAME_SUFFIX_LENGTH)
  )}-step-${randomUUID().substring(0, STEP_POD_NAME_SUFFIX_LENGTH)}`
}

export function getSecretName(): string {
  return `${shortenRunnerName(
    getRunnerPodName(),
    MAX_POD_NAME_LENGTH - ('-secret-'.length + STEP_POD_NAME_SUFFIX_LENGTH)
  )}-secret-${randomUUID().substring(0, STEP_POD_NAME_SUFFIX_LENGTH)}`
}

export const MAX_POD_NAME_LENGTH = 63
export const STEP_POD_NAME_SUFFIX_LENGTH = 8
export const CONTAINER_EXTENSION_PREFIX = '$'
export const JOB_CONTAINER_NAME = 'job'
export const JOB_CONTAINER_EXTENSION_NAME = '$job'

export class RunnerInstanceLabel {
  private podName: string
  constructor() {
    this.podName = getRunnerPodName()
  }

  get key(): string {
    return 'runner-pod'
  }

  get value(): string {
    return this.podName
  }

  toString(): string {
    return `runner-pod=${this.podName}`
  }
}
