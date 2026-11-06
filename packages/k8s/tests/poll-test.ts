const mockReadNamespacedPod = jest.fn()
const mockReadNamespacedJob = jest.fn()
const sleeps: number[] = []
let fakeNow = 0

jest.mock('@kubernetes/client-node', () => {
  return {
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockImplementation(ApiClass => {
        const name = ApiClass?.name || ''
        if (name.includes('Batch')) {
          return { readNamespacedJob: mockReadNamespacedJob }
        }
        return { readNamespacedPod: mockReadNamespacedPod }
      }),
      getContexts: jest.fn().mockReturnValue([{ namespace: 'test-namespace' }])
    })),
    Exec: jest.fn(),
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    CoreV1Api: class CoreV1Api {},
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    BatchV1Api: class BatchV1Api {},
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    AuthorizationV1Api: class AuthorizationV1Api {},
    Log: jest.fn()
  }
})

// sleep() records each delay and advances the fake clock instead of waiting.
jest.mock('../src/k8s/utils', () => {
  const actual = jest.requireActual('../src/k8s/utils')
  return {
    ...actual,
    sleep: jest.fn().mockImplementation(async (ms: number) => {
      sleeps.push(ms)
      fakeNow += ms
    })
  }
})

import { waitForJobToComplete, waitForPodPhases } from '../src/k8s'
import { PodPhase } from '../src/k8s/utils'
import { PollSchedule } from '../src/k8s/poll'

const EXPECTED_DELAYS = [
  1000, 1150, 1323, 1521, 1749, 2011, 2313, 2660, 3000, 3000, 3000
]

describe('PollSchedule', () => {
  it('starts at 1s, grows 15% per poll and caps at 3s', () => {
    const schedule = new PollSchedule()
    const delays = EXPECTED_DELAYS.map(() => schedule.next())
    expect(delays).toEqual(EXPECTED_DELAYS)
  })

  it('polls a pod that is Running at 16s by 16.7s, not at 31s as upstream did', () => {
    const schedule = new PollSchedule()
    let at = 0
    while (at < 16000) {
      at += schedule.next()
    }
    expect(at).toBeLessThanOrEqual(16000 + 3000)
    expect(at).toBe(16727)
  })
})

describe('wait loops', () => {
  let nowSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    sleeps.length = 0
    fakeNow = 1_000_000
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'test-namespace'
  })

  afterEach(() => {
    nowSpy.mockRestore()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('waitForPodPhases follows the schedule until the pod is Running', async () => {
    const phases = ['Pending', 'Pending', 'Pending', 'Pending', 'Running']
    mockReadNamespacedPod.mockImplementation(async () => ({
      status: { phase: phases.shift() }
    }))

    await waitForPodPhases(
      'pod',
      new Set([PodPhase.RUNNING]),
      new Set([PodPhase.PENDING]),
      600
    )

    expect(sleeps).toEqual(EXPECTED_DELAYS.slice(0, 4))
    expect(mockReadNamespacedPod).toHaveBeenCalledTimes(5)
  })

  it('waitForPodPhases does not sleep when the pod is already Running', async () => {
    mockReadNamespacedPod.mockResolvedValue({ status: { phase: 'Running' } })

    await waitForPodPhases(
      'pod',
      new Set([PodPhase.RUNNING]),
      new Set([PodPhase.PENDING]),
      600
    )

    expect(sleeps).toEqual([])
  })

  it('waitForPodPhases times out on wall-clock time', async () => {
    mockReadNamespacedPod.mockResolvedValue({ status: { phase: 'Pending' } })

    await expect(
      waitForPodPhases(
        'pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING]),
        10
      )
    ).rejects.toThrow(
      'Pod pod is unhealthy with phase status Pending: timed out after 10s'
    )
    // It stops at the first poll at or after 10s.
    const waited = sleeps.reduce((sum, ms) => sum + ms, 0)
    expect(waited).toBeGreaterThanOrEqual(10000)
    expect(waited - sleeps[sleeps.length - 1]).toBeLessThan(10000)
  })

  it('waitForPodPhases counts slow API calls toward the timeout', async () => {
    mockReadNamespacedPod.mockImplementation(async () => {
      fakeNow += 4000
      return { status: { phase: 'Pending' } }
    })

    await expect(
      waitForPodPhases(
        'pod',
        new Set([PodPhase.RUNNING]),
        new Set([PodPhase.PENDING]),
        10
      )
    ).rejects.toThrow('timed out after 10s')
    expect(mockReadNamespacedPod).toHaveBeenCalledTimes(3)
  })

  it('waitForPodPhases with no timeout keeps waiting', async () => {
    let polls = 0
    mockReadNamespacedPod.mockImplementation(async () => ({
      status: { phase: ++polls > 400 ? 'Running' : 'Pending' }
    }))

    await waitForPodPhases(
      'pod',
      new Set([PodPhase.RUNNING]),
      new Set([PodPhase.PENDING]),
      0
    )

    expect(polls).toBe(401)
  })

  it('waitForJobToComplete follows the schedule until the Job succeeds', async () => {
    const statuses = [{}, {}, {}, { succeeded: 1 }]
    mockReadNamespacedJob.mockImplementation(async () => ({
      status: statuses.shift()
    }))

    await waitForJobToComplete('job')

    expect(sleeps).toEqual(EXPECTED_DELAYS.slice(0, 3))
  })
})
