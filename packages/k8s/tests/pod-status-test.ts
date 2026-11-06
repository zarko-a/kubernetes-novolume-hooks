import type * as k8s from '@kubernetes/client-node'
import {
  elapsedSeconds,
  EventTracker,
  eventsSince,
  FailFastTracker,
  PodStatusReporter,
  renderEvent,
  renderPodTrouble,
  renderReadyLine,
  renderSettings,
  renderStatus,
  resolveFailFastSettings
} from '../src/k8s/pod-status'

const CREATED = Date.parse('2026-11-06T10:00:00Z')
const at = (seconds: number): Date => new Date(CREATED + seconds * 1000)

function pod(
  status: k8s.V1PodStatus,
  spec?: Partial<k8s.V1PodSpec>
): k8s.V1Pod {
  return {
    metadata: {
      name: 'runner-x-workflow',
      uid: 'uid-1',
      creationTimestamp: at(0)
    },
    spec: { containers: [], ...spec } as k8s.V1PodSpec,
    status
  }
}

function waiting(
  name: string,
  reason: string,
  message?: string
): k8s.V1ContainerStatus {
  return {
    name,
    image: 'img',
    imageID: '',
    ready: false,
    restartCount: 0,
    state: { waiting: { reason, message } }
  }
}

function event(
  fields: Partial<k8s.CoreV1Event> & { name: string }
): k8s.CoreV1Event {
  const { name, ...rest } = fields
  return {
    metadata: { name, uid: `uid-${name}` },
    involvedObject: { uid: 'uid-1' },
    ...rest
  }
}

describe('renderEvent', () => {
  it('renders a core event with its source and repeat count', () => {
    expect(
      renderEvent(
        event({
          name: 'a',
          type: 'Warning',
          reason: 'FailedScheduling',
          source: { component: 'default-scheduler' },
          message: '0/14 nodes are available: 14 Insufficient memory.\n',
          count: 3
        })
      )
    ).toBe(
      'Warning FailedScheduling (default-scheduler): 0/14 nodes are available: 14 Insufficient memory. (x3)'
    )
  })

  it('renders an events.k8s.io event that has only a reporting component', () => {
    expect(
      renderEvent(
        event({
          name: 'k',
          type: 'Normal',
          reason: 'Nominated',
          reportingComponent: 'karpenter',
          message: 'Pod should schedule on: nodeclaim/linux-default-7xk2p',
          eventTime: at(2) as unknown as k8s.V1MicroTime
        })
      )
    ).toBe(
      'Normal Nominated (karpenter): Pod should schedule on: nodeclaim/linux-default-7xk2p'
    )
  })
})

describe('EventTracker', () => {
  it('returns each event once, oldest first, and again when it repeats', () => {
    const tracker = new EventTracker()
    const scheduled = event({
      name: 's',
      reason: 'Scheduled',
      lastTimestamp: at(41)
    })
    const nominated = event({
      name: 'n',
      reason: 'Nominated',
      eventTime: at(2) as unknown as k8s.V1MicroTime
    })
    const backoff = event({
      name: 'b',
      reason: 'BackOff',
      lastTimestamp: at(50),
      count: 1
    })

    expect(tracker.fresh([scheduled, nominated]).map(e => e.reason)).toEqual([
      'Nominated',
      'Scheduled'
    ])
    expect(tracker.fresh([scheduled, nominated])).toEqual([])
    expect(tracker.fresh([scheduled, backoff]).map(e => e.reason)).toEqual([
      'BackOff'
    ])
    const repeated = { ...backoff, count: 4, lastTimestamp: at(70) }
    expect(tracker.fresh([repeated])).toEqual([repeated])
    expect(tracker.fresh([repeated])).toEqual([])
  })

  it('counts series repeats of events.k8s.io events', () => {
    const tracker = new EventTracker()
    const first = event({
      name: 'e',
      reason: 'X',
      eventTime: at(1) as unknown as k8s.V1MicroTime
    })
    tracker.fresh([first])
    const again = {
      ...first,
      series: {
        count: 2,
        lastObservedTime: at(9) as unknown as k8s.V1MicroTime
      }
    }
    expect(tracker.fresh([again])).toHaveLength(1)
  })
})

describe('renderStatus', () => {
  const pending = pod({
    phase: 'Pending',
    conditions: [
      {
        type: 'PodScheduled',
        status: 'False',
        reason: 'Unschedulable',
        message: '0/14 nodes are available'
      }
    ]
  })

  it('renders phase and conditions with their messages', () => {
    expect(renderStatus(pending)).toBe(
      'status: Pending; PodScheduled=False (Unschedulable: 0/14 nodes are available)'
    )
  })

  it('drops the messages for the heartbeat line', () => {
    expect(renderStatus(pending, false)).toBe(
      'status: Pending; PodScheduled=False (Unschedulable)'
    )
  })

  it('renders init containers first, then the others, in every state', () => {
    const p = pod({
      phase: 'Pending',
      initContainerStatuses: [
        {
          name: 'fs-init',
          image: 'i',
          imageID: '',
          ready: false,
          restartCount: 0,
          state: { terminated: { exitCode: 0, reason: 'Completed' } }
        }
      ],
      containerStatuses: [
        waiting('job', 'ImagePullBackOff', 'Back-off pulling image "x"'),
        {
          name: 'redis',
          image: 'r',
          imageID: '',
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: at(5) } }
        }
      ]
    })
    expect(renderStatus(p)).toBe(
      'status: Pending; fs-init terminated Completed, exit 0, ' +
        'job waiting ImagePullBackOff: Back-off pulling image "x", redis running'
    )
  })
})

describe('renderReadyLine', () => {
  it('lists when each condition turned true and each container ran, relative to creation', () => {
    const p = pod({
      phase: 'Running',
      conditions: [
        { type: 'PodScheduled', status: 'True', lastTransitionTime: at(41) },
        { type: 'Initialized', status: 'True', lastTransitionTime: at(50) },
        { type: 'Ready', status: 'True', lastTransitionTime: at(51) }
      ],
      initContainerStatuses: [
        {
          name: 'fs-init',
          image: 'i',
          imageID: '',
          ready: false,
          restartCount: 0,
          state: {
            terminated: { exitCode: 0, startedAt: at(44), finishedAt: at(50) }
          }
        }
      ],
      containerStatuses: [
        {
          name: 'job',
          image: 'j',
          imageID: '',
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: at(51) } }
        }
      ]
    })
    expect(renderReadyLine(p, at(51.4).getTime())).toBe(
      'pod Running after 51s: PodScheduled +41s, fs-init +44s..+50s, Initialized +50s, Ready +51s, job +51s'
    )
  })
})

describe('PodStatusReporter', () => {
  it('prints changes, a heartbeat after 5 quiet seconds, and events at their own time', () => {
    const lines: string[] = []
    let now = at(1).getTime()
    const reporter = new PodStatusReporter(
      line => lines.push(line),
      () => now
    )
    const p = pod({
      phase: 'Pending',
      conditions: [
        {
          type: 'PodScheduled',
          status: 'False',
          reason: 'Unschedulable',
          message: 'm'
        }
      ]
    })

    reporter.observe(p)
    now = at(3).getTime()
    reporter.observe(p)
    reporter.addEvents(p, [
      event({
        name: 'n',
        type: 'Normal',
        reason: 'Nominated',
        reportingComponent: 'karpenter',
        message: 'Pod should schedule on: nodeclaim/x',
        eventTime: at(2) as unknown as k8s.V1MicroTime
      })
    ])
    now = at(7).getTime()
    reporter.observe(p)
    now = at(9).getTime()
    reporter.observe(p)

    expect(lines).toEqual([
      '1s   status: Pending; PodScheduled=False (Unschedulable: m)',
      '2s   Normal Nominated (karpenter): Pod should schedule on: nodeclaim/x',
      // nothing printed between 3s and 8s: a heartbeat at the first poll after 5s
      '9s   status: Pending; PodScheduled=False (Unschedulable)'
    ])
  })
})

describe('FailFastTracker', () => {
  const settings = { enabled: true, graceSeconds: 60 }

  it('fails once a container has been pulling unsuccessfully for the grace period', () => {
    let now = at(0).getTime()
    const tracker = new FailFastTracker(settings, () => now)
    const pull = (reason: string, message: string): k8s.V1Pod =>
      pod({
        phase: 'Pending',
        containerStatuses: [waiting('job', reason, message)]
      })

    expect(
      tracker.check(pull('ErrImagePull', 'manifest unknown: tag not found'))
    ).toBeUndefined()
    now = at(30).getTime()
    // The kubelet alternates the two reasons: one period, not two.
    expect(
      tracker.check(pull('ImagePullBackOff', 'Back-off pulling image'))
    ).toBeUndefined()
    now = at(60).getTime()
    expect(
      tracker.check(pull('ImagePullBackOff', 'Back-off pulling image'))
    ).toBe(
      'container job has been ImagePullBackOff for 60s: manifest unknown: tag not found'
    )
  })

  it('starts the period over when the container stops waiting with that reason', () => {
    let now = at(0).getTime()
    const tracker = new FailFastTracker(settings, () => now)
    tracker.check(
      pod({
        phase: 'Pending',
        containerStatuses: [waiting('job', 'ErrImagePull')]
      })
    )
    now = at(50).getTime()
    tracker.check(
      pod({
        phase: 'Pending',
        containerStatuses: [waiting('job', 'ContainerCreating')]
      })
    )
    now = at(70).getTime()
    expect(
      tracker.check(
        pod({
          phase: 'Pending',
          containerStatuses: [waiting('job', 'ErrImagePull')]
        })
      )
    ).toBeUndefined()
  })

  it('fails at once on an invalid image name', () => {
    const tracker = new FailFastTracker(settings, () => at(0).getTime())
    expect(
      tracker.check(
        pod({
          phase: 'Pending',
          containerStatuses: [
            waiting('job', 'InvalidImageName', 'invalid reference format')
          ]
        })
      )
    ).toBe('container job has been InvalidImageName: invalid reference format')
  })

  it('watches init and service containers and missing config too', () => {
    let now = at(0).getTime()
    const tracker = new FailFastTracker(
      { enabled: true, graceSeconds: 10 },
      () => now
    )
    const p = pod({
      phase: 'Pending',
      initContainerStatuses: [waiting('fs-init', 'PodInitializing')],
      containerStatuses: [
        waiting('job', 'PodInitializing'),
        waiting('redis', 'CreateContainerConfigError', 'secret "x" not found')
      ]
    })
    expect(tracker.check(p)).toBeUndefined()
    now = at(10).getTime()
    expect(tracker.check(p)).toBe(
      'container redis has been CreateContainerConfigError for 10s: secret "x" not found'
    )
  })

  it('never fails when disabled', () => {
    let now = at(0).getTime()
    const tracker = new FailFastTracker(
      { enabled: false, graceSeconds: 0 },
      () => now
    )
    const p = pod({
      phase: 'Pending',
      containerStatuses: [waiting('job', 'InvalidImageName')]
    })
    expect(tracker.check(p)).toBeUndefined()
    now = at(1000).getTime()
    expect(tracker.check(p)).toBeUndefined()
  })
})

describe('resolveFailFastSettings', () => {
  it('uses the defaults', () => {
    const s = resolveFailFastSettings(undefined, {}, 600)
    expect(s).toMatchObject({
      enabled: true,
      graceSeconds: 60,
      sources: { enabled: 'default', graceSeconds: 'default' },
      warnings: []
    })
    expect(renderSettings(s)).toBe(
      'fail fast on (default), grace period 60s (default)'
    )
  })

  it('prefers the job container env, then the runner env', () => {
    const s = resolveFailFastSettings(
      { HOOK_FAIL_FAST_SECONDS: '300' },
      { HOOK_FAIL_FAST_SECONDS: '120', HOOK_FAIL_FAST: 'FALSE' },
      600
    )
    expect(s).toMatchObject({
      enabled: false,
      graceSeconds: 300,
      sources: { enabled: 'runner env', graceSeconds: 'job container env' }
    })
  })

  it('warns about malformed values and uses the defaults', () => {
    const s = resolveFailFastSettings(
      { HOOK_FAIL_FAST: 'yes', HOOK_FAIL_FAST_SECONDS: '5m' },
      {},
      600
    )
    expect(s.enabled).toBe(true)
    expect(s.graceSeconds).toBe(60)
    expect(s.sources).toEqual({ enabled: 'default', graceSeconds: 'default' })
    expect(s.warnings).toHaveLength(2)
    expect(s.warnings[0]).toContain(
      'HOOK_FAIL_FAST from job container env is "yes"'
    )
    expect(s.warnings[1]).toContain(
      'HOOK_FAIL_FAST_SECONDS from job container env is "5m"'
    )
  })

  it('warns when the grace period cannot end before the prepare-job timeout', () => {
    const s = resolveFailFastSettings(
      { HOOK_FAIL_FAST_SECONDS: '900' },
      {},
      600
    )
    expect(s.graceSeconds).toBe(900)
    expect(s.warnings[0]).toContain('so that timeout comes first')
  })
})

describe('renderPodTrouble', () => {
  it('returns nothing for a healthy pod, as after a plain step failure', () => {
    const p = pod({
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
    })
    expect(renderPodTrouble(p)).toEqual([])
  })

  it('names an OOM kill and the memory limit', () => {
    const p = pod(
      {
        phase: 'Failed',
        conditions: [
          { type: 'Ready', status: 'False', reason: 'PodFailed' },
          { type: 'PodScheduled', status: 'True' }
        ],
        containerStatuses: [
          {
            name: 'job',
            image: 'j',
            imageID: '',
            ready: false,
            restartCount: 0,
            state: { terminated: { exitCode: 137, reason: 'OOMKilled' } }
          }
        ]
      },
      {
        containers: [{ name: 'job', resources: { limits: { memory: '5Gi' } } }]
      }
    )
    expect(renderPodTrouble(p)).toEqual([
      'pod phase Failed',
      'job terminated OOMKilled, exit 137 (memory limit 5Gi)',
      'Ready=False (PodFailed)'
    ])
  })

  it('names an eviction with the kubelet message', () => {
    const p = pod({
      phase: 'Failed',
      reason: 'Evicted',
      message: 'The node was low on resource: ephemeral-storage.'
    })
    expect(renderPodTrouble(p)).toEqual([
      'pod phase Failed',
      'pod Evicted: The node was low on resource: ephemeral-storage.'
    ])
  })
})

describe('eventsSince', () => {
  it('keeps events from the step on, allowing two seconds of clock skew', () => {
    const events = [
      event({ name: 'old', lastTimestamp: at(10) }),
      event({ name: 'skewed', lastTimestamp: at(98.5) }),
      event({ name: 'new', lastTimestamp: at(105) })
    ]
    expect(
      eventsSince(events, at(100).getTime()).map(e => e.metadata?.name)
    ).toEqual(['skewed', 'new'])
  })
})

describe('elapsedSeconds', () => {
  it('rounds and never goes negative', () => {
    expect(elapsedSeconds(1000, 2600)).toBe(2)
    expect(elapsedSeconds(5000, 1000)).toBe(0)
  })
})
