import * as k8s from '@kubernetes/client-node'

const mockCreateNamespacedPod = jest.fn()

jest.mock('@kubernetes/client-node', () => {
  const actual = jest.requireActual('@kubernetes/client-node')
  return {
    ...actual,
    KubeConfig: jest.fn().mockImplementation(() => ({
      loadFromDefault: jest.fn(),
      makeApiClient: jest.fn().mockReturnValue({
        createNamespacedPod: mockCreateNamespacedPod
      }),
      getContexts: jest.fn().mockReturnValue([{ namespace: 'test-namespace' }])
    }))
  }
})

import { createContainerStepPod, createJobPod } from '../src/k8s'
import { mergeInitContainers, mergePodSpecWithOptions } from '../src/k8s/utils'

function template(spec: Partial<k8s.V1PodSpec>): k8s.V1PodTemplateSpec {
  return { spec: { containers: [], ...spec } as k8s.V1PodSpec }
}

const SETUP: k8s.V1Container = {
  name: 'setup',
  image: 'busybox',
  command: ['sh', '-c', 'echo setup']
}
const SECOND: k8s.V1Container = { name: 'second', image: 'busybox' }

describe('template initContainers (upstream #347)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'test-namespace'
    process.env['GITHUB_WORKSPACE'] = '/__w/repo/repo'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'runner-abc'
    mockCreateNamespacedPod.mockImplementation(async ({ body }) => body)
  })

  afterEach(() => {
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['GITHUB_WORKSPACE']
    delete process.env['ACTIONS_RUNNER_POD_NAME']
  })

  async function jobPod(extension?: k8s.V1PodTemplateSpec): Promise<k8s.V1Pod> {
    return createJobPod(
      'runner-abc-workflow',
      { name: 'job', image: 'alpine' },
      undefined,
      undefined,
      extension
    )
  }

  it('runs the hook fs-init first, then the template init containers in order', async () => {
    const pod = await jobPod(template({ initContainers: [SETUP, SECOND] }))
    expect(pod.spec?.initContainers?.map(c => c.name)).toEqual([
      'fs-init',
      'setup',
      'second'
    ])
    expect(pod.spec?.initContainers?.[1]).toEqual(SETUP)
  })

  it('keeps fs-init unchanged when the template adds init containers', async () => {
    const plain = await jobPod()
    const merged = await jobPod(template({ initContainers: [SETUP] }))
    expect(merged.spec?.initContainers?.[0]).toEqual(
      plain.spec?.initContainers?.[0]
    )
  })

  it('still merges the template volumes next to the hook volumes', async () => {
    const pod = await jobPod(
      template({
        initContainers: [SETUP],
        volumes: [{ name: 'cache', emptyDir: {} }]
      })
    )
    expect(pod.spec?.volumes?.map(v => v.name)).toEqual(
      expect.arrayContaining(['work', 'github', 'cache'])
    )
  })

  it('leaves fs-init alone for a template without init containers, or with an empty list', async () => {
    for (const extension of [
      undefined,
      template({}),
      template({ initContainers: [] })
    ]) {
      const pod = await jobPod(extension)
      expect(pod.spec?.initContainers?.map(c => c.name)).toEqual(['fs-init'])
    }
  })

  it('fails with a clear error when a template init container is named fs-init', async () => {
    await expect(
      jobPod(template({ initContainers: [{ name: 'fs-init', image: 'x' }] }))
    ).rejects.toThrow(
      "the pod template's init container name fs-init is used by the hook; rename it in the template"
    )
    expect(mockCreateNamespacedPod).not.toHaveBeenCalled()
  })

  it('gives a container step pod, which has no init containers of its own, the template ones', async () => {
    const pod = await createContainerStepPod(
      'runner-abc-step-12345678',
      { name: 'job', image: 'alpine' },
      template({ initContainers: [SETUP] })
    )
    expect(pod.spec?.initContainers?.map(c => c.name)).toEqual(['setup'])
  })

  it('mergeInitContainers appends and does not modify its inputs', () => {
    const base = [{ name: 'fs-init' }]
    const from = [SETUP]
    expect(mergeInitContainers(base, from).map(c => c.name)).toEqual([
      'fs-init',
      'setup'
    ])
    expect(base).toEqual([{ name: 'fs-init' }])
    expect(mergeInitContainers(undefined, from)).toEqual([SETUP])
  })

  it('mergePodSpecWithOptions still replaces other keys as before', () => {
    const base = {
      containers: [],
      initContainers: [{ name: 'fs-init' }],
      restartPolicy: 'Never'
    } as k8s.V1PodSpec
    mergePodSpecWithOptions(base, {
      containers: [],
      initContainers: [SETUP],
      restartPolicy: 'OnFailure'
    } as k8s.V1PodSpec)
    expect(base.restartPolicy).toBe('OnFailure')
    expect(base.initContainers?.map(c => c.name)).toEqual(['fs-init', 'setup'])
  })
})
