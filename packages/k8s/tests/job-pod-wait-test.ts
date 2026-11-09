const mockReadNamespacedPod = jest.fn()
const mockListNamespacedEvent = jest.fn()
const mockInfo = jest.fn()
const mockWarning = jest.fn()
const mockError = jest.fn()
let fakeNow = 0

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: (message: string) => mockInfo(message),
  warning: (message: string) => mockWarning(message),
  error: (message: string) => mockError(message)
}))

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn().mockReturnValue({
      readNamespacedPod: mockReadNamespacedPod,
      listNamespacedEvent: mockListNamespacedEvent
    }),
    getContexts: jest.fn().mockReturnValue([{ namespace: 'test-namespace' }])
  })),
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  CoreV1Api: class CoreV1Api {},
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  AuthorizationV1Api: class AuthorizationV1Api {}
}))

jest.mock('../src/k8s/utils', () => {
  const actual = jest.requireActual('../src/k8s/utils')
  return {
    ...actual,
    sleep: jest.fn().mockImplementation(async (ms: number) => {
      fakeNow += ms
    })
  }
})

import {
  reportPodTrouble,
  troubleWaitMs,
  waitForJobPodRunning
} from '../src/k8s'

const CREATED = Date.parse('2026-11-06T10:00:00Z')
const at = (seconds: number): Date => new Date(CREATED + seconds * 1000)

function jobPod(phase: string, jobState: object): object {
  return {
    metadata: { name: 'p', uid: 'uid-1', creationTimestamp: at(0) },
    spec: {
      containers: [{ name: 'job', resources: { limits: { memory: '5Gi' } } }]
    },
    status: {
      phase,
      containerStatuses: [
        {
          name: 'job',
          image: 'j',
          imageID: '',
          ready: false,
          restartCount: 0,
          state: jobState
        }
      ]
    }
  }
}

const hookLines = (): string[] =>
  mockInfo.mock.calls
    .map(call => call[0] as string)
    .map(line => line.replace('[custom-hook] ', ''))

describe('waitForJobPodRunning', () => {
  let nowSpy: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    fakeNow = at(1).getTime()
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'test-namespace'
    mockListNamespacedEvent.mockResolvedValue({ items: [] })
  })

  afterEach(() => {
    nowSpy.mockRestore()
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  })

  it('shows status and events until the pod is Running, then the ready line', async () => {
    const states = [
      jobPod('Pending', { waiting: { reason: 'ContainerCreating' } }),
      jobPod('Pending', { waiting: { reason: 'ContainerCreating' } }),
      {
        ...jobPod('Running', { running: { startedAt: at(4) } }),
        status: {
          phase: 'Running',
          conditions: [
            { type: 'Ready', status: 'True', lastTransitionTime: at(4) }
          ],
          containerStatuses: [
            {
              name: 'job',
              image: 'j',
              imageID: '',
              ready: true,
              restartCount: 0,
              state: { running: { startedAt: at(4) } }
            }
          ]
        }
      }
    ]
    mockReadNamespacedPod.mockImplementation(async () => states.shift())
    // No events at the first read; the kubelet's Pulled event by the next one, 2s later.
    mockListNamespacedEvent.mockResolvedValueOnce({ items: [] })
    mockListNamespacedEvent.mockResolvedValue({
      items: [
        {
          metadata: { name: 'e1', uid: 'e1' },
          involvedObject: { uid: 'uid-1' },
          type: 'Normal',
          reason: 'Pulled',
          source: { component: 'kubelet' },
          message: 'Container image "j" already present on machine',
          lastTimestamp: at(3)
        }
      ]
    })

    await waitForJobPodRunning('p', 600, { enabled: true, graceSeconds: 60 })

    expect(mockListNamespacedEvent).toHaveBeenCalledWith({
      namespace: 'test-namespace',
      fieldSelector: 'involvedObject.uid=uid-1'
    })
    expect(hookLines()).toEqual([
      '1s   status: Pending; job waiting ContainerCreating',
      '3s   Normal Pulled (kubelet): Container image "j" already present on machine',
      '3s   status: Running; Ready=True; job running',
      'pod Running after 3s: Ready +4s, job +4s'
    ])
  })

  it('fails fast with the kubelet message', async () => {
    mockReadNamespacedPod.mockResolvedValue(
      jobPod('Pending', {
        waiting: { reason: 'ErrImagePull', message: 'manifest unknown' }
      })
    )

    await expect(
      waitForJobPodRunning('p', 600, { enabled: true, graceSeconds: 10 })
    ).rejects.toThrow(
      /^Pod p is unhealthy with phase status Pending: failed fast: container job has been ErrImagePull for 1\ds: manifest unknown$/
    )
  })

  it('keeps waiting until the timeout when fail fast is off', async () => {
    mockReadNamespacedPod.mockResolvedValue(
      jobPod('Pending', { waiting: { reason: 'ImagePullBackOff' } })
    )

    await expect(
      waitForJobPodRunning('p', 30, { enabled: false, graceSeconds: 10 })
    ).rejects.toThrow('timed out after 30s')
  })

  it('warns once and carries on with status only when events are forbidden', async () => {
    const states = [
      jobPod('Pending', { waiting: { reason: 'ContainerCreating' } }),
      jobPod('Pending', { waiting: { reason: 'ContainerCreating' } }),
      jobPod('Pending', { waiting: { reason: 'ContainerCreating' } }),
      jobPod('Running', { running: { startedAt: at(6) } })
    ]
    mockReadNamespacedPod.mockImplementation(async () => states.shift())
    mockListNamespacedEvent.mockRejectedValue(
      Object.assign(new Error('forbidden'), { code: 403 })
    )

    await waitForJobPodRunning('p', 600, { enabled: true, graceSeconds: 60 })

    expect(mockListNamespacedEvent).toHaveBeenCalledTimes(1)
    expect(mockWarning).toHaveBeenCalledTimes(1)
    expect(mockWarning.mock.calls[0][0]).toContain('cannot list events')
  })
})

describe('reportPodTrouble', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'test-namespace'
    mockListNamespacedEvent.mockResolvedValue({ items: [] })
  })

  it('prints nothing after a plain step failure', async () => {
    mockReadNamespacedPod.mockResolvedValue({
      ...jobPod('Running', { running: {} }),
      status: {
        phase: 'Running',
        conditions: [{ type: 'Ready', status: 'True' }],
        containerStatuses: [
          {
            name: 'job',
            image: 'j',
            imageID: '',
            ready: true,
            restartCount: 0,
            state: { running: {} }
          }
        ]
      }
    })

    await reportPodTrouble('p', at(100).getTime())

    expect(mockError).not.toHaveBeenCalled()
  })

  it('names an OOM kill, the limit and the events since the step started', async () => {
    mockReadNamespacedPod.mockResolvedValue(
      jobPod('Failed', { terminated: { exitCode: 137, reason: 'OOMKilled' } })
    )
    mockListNamespacedEvent.mockResolvedValue({
      items: [
        {
          metadata: { name: 'old', uid: 'old' },
          involvedObject: { uid: 'uid-1' },
          type: 'Normal',
          reason: 'Started',
          source: { component: 'kubelet' },
          message: 'Started container job',
          lastTimestamp: at(5)
        }
      ]
    })

    await reportPodTrouble('p', at(100).getTime())

    expect(mockError.mock.calls.map(call => call[0])).toEqual([
      '[custom-hook] pod phase Failed',
      '[custom-hook] job terminated OOMKilled, exit 137 (memory limit 5Gi)'
    ])
  })

  it('re-reads the pod until the kubelet reports the OOM kill', async () => {
    let nowMs = at(100).getTime()
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const { sleep } = jest.requireMock('../src/k8s/utils')
    sleep.mockImplementation(async (ms: number) => {
      nowMs += ms
    })
    const healthy = {
      ...jobPod('Running', { running: {} }),
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'job',
            image: 'j',
            imageID: '',
            ready: true,
            restartCount: 0,
            state: { running: {} }
          }
        ]
      }
    }
    const reads = [
      healthy,
      healthy,
      jobPod('Failed', { terminated: { exitCode: 137, reason: 'OOMKilled' } })
    ]
    mockReadNamespacedPod.mockImplementation(async () => reads.shift())

    await reportPodTrouble('p', at(100).getTime(), 15000)

    expect(mockReadNamespacedPod).toHaveBeenCalledTimes(3)
    expect(mockError.mock.calls.map(call => call[0])).toContain(
      '[custom-hook] job terminated OOMKilled, exit 137 (memory limit 5Gi)'
    )
    nowSpy.mockRestore()
  })

  it('stops re-reading after the wait when nothing happened to the pod', async () => {
    let nowMs = at(100).getTime()
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const { sleep } = jest.requireMock('../src/k8s/utils')
    sleep.mockImplementation(async (ms: number) => {
      nowMs += ms
    })
    mockReadNamespacedPod.mockResolvedValue({
      ...jobPod('Running', { running: {} }),
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'job',
            image: 'j',
            imageID: '',
            ready: true,
            restartCount: 0,
            state: { running: {} }
          }
        ]
      }
    })

    await reportPodTrouble('p', at(100).getTime(), 15000)

    expect(mockReadNamespacedPod).toHaveBeenCalledTimes(16)
    expect(mockError).not.toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it('says when the pod is gone', async () => {
    mockReadNamespacedPod.mockRejectedValue(
      Object.assign(new Error('not found'), { code: 404 })
    )

    await reportPodTrouble('p', at(100).getTime())

    expect(mockError).toHaveBeenCalledWith(
      '[custom-hook] job pod p no longer exists'
    )
  })

  it('never throws', async () => {
    mockReadNamespacedPod.mockRejectedValue(new Error('boom'))
    await expect(reportPodTrouble('p', 0)).resolves.toBeUndefined()
  })
})

describe('troubleWaitMs', () => {
  it.each([
    [
      'command terminated with non-zero exit code: command terminated with exit code 1',
      0
    ],
    [
      'command terminated with non-zero exit code: command terminated with exit code 2',
      0
    ],
    [
      'command terminated with non-zero exit code: command terminated with exit code 137',
      15000
    ],
    [
      'Internal error occurred: unable to upgrade connection: container not found ("job")',
      15000
    ],
    ['WebSocket heartbeat timeout', 15000]
  ])('%s -> %p', (message, expected) => {
    expect(troubleWaitMs(new Error(message))).toBe(expected)
  })
})
