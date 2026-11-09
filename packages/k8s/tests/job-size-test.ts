import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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

import { createJobPod } from '../src/k8s'
import { createContainerSpec } from '../src/hooks/prepare-job'
import {
  applyJobSize,
  formatJobSize,
  formatMebibytes,
  formatMillicores,
  JobSize,
  JobSizeError,
  JobSizeLimits,
  loadJobTemplate,
  parseMebibytes,
  parseMillicores,
  resolveJobTemplateSource
} from '../src/k8s/job-size'

const RUNNER_ENV = {
  HOOK_JOB_PROFILE_DIR: '/profiles',
  HOOK_JOB_PROFILES: 'standard,podman',
  HOOK_JOB_MAX_MEMORY: '26Gi',
  HOOK_JOB_MAX_CPU: '14',
  HOOK_JOB_MAX_DISK: '30Gi',
  HOOK_JOB_CPU_LIMIT: '20'
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(JobSizeError)
    return (error as JobSizeError).problems
  }
  throw new Error('expected a JobSizeError')
}

describe('parseMebibytes', () => {
  it.each([
    ['512Mi', 512],
    ['7Gi', 7168],
    ['1.5Gi', 1536],
    ['0.25Gi', 256],
    [' 7Gi ', 7168],
    ['26Gi', 26624]
  ])('%s is %d MiB', (raw, expected) => {
    expect(parseMebibytes('X', raw)).toBe(expected)
  })

  it.each([
    ['0.3Gi', 'not a whole number of Mi'],
    ['1.5Mi', 'not a whole number of Mi'],
    ['0Gi', 'more than zero'],
    ['0Mi', 'more than zero'],
    ['7G', 'not a quantity'],
    ['7gi', 'not a quantity'],
    ['7Ki', 'not a quantity'],
    ['7', 'not a quantity'],
    ['-1Gi', 'not a quantity'],
    ['1e3Mi', 'not a quantity'],
    ['Gi', 'not a quantity'],
    ['7 Gi', 'not a quantity'],
    ['99999999Gi', 'not a quantity']
  ])('%s is rejected (%s)', (raw, reason) => {
    const result = parseMebibytes('HOOK_JOB_MEMORY', raw)
    expect(typeof result).toBe('string')
    expect(result).toContain('HOOK_JOB_MEMORY')
    expect(result).toContain(reason)
  })
})

describe('parseMillicores', () => {
  it.each([
    ['3', 3000],
    ['0.5', 500],
    ['1.25', 1250],
    ['0.001', 1],
    ['500m', 500],
    [' 2 ', 2000],
    ['14', 14000]
  ])('%s is %d millicores', (raw, expected) => {
    expect(parseMillicores('X', raw)).toBe(expected)
  })

  it.each([
    ['1.2345', 'finer than a millicore'],
    ['0', 'more than zero'],
    ['0m', 'more than zero'],
    ['0.0', 'more than zero'],
    ['2.5m', 'not a number of CPUs'],
    ['abc', 'not a number of CPUs'],
    ['-1', 'not a number of CPUs'],
    ['1,5', 'not a number of CPUs'],
    ['2 cores', 'not a number of CPUs']
  ])('%s is rejected (%s)', (raw, reason) => {
    const result = parseMillicores('HOOK_JOB_CPU', raw)
    expect(typeof result).toBe('string')
    expect(result).toContain('HOOK_JOB_CPU')
    expect(result).toContain(reason)
  })
})

describe('formatting', () => {
  it('uses Gi for whole GiB and Mi otherwise', () => {
    expect(formatMebibytes(7168)).toBe('7Gi')
    expect(formatMebibytes(1536)).toBe('1536Mi')
  })

  it('uses cores for whole CPUs and millicores otherwise', () => {
    expect(formatMillicores(3000)).toBe('3')
    expect(formatMillicores(1500)).toBe('1500m')
  })
})

describe('resolveJobTemplateSource', () => {
  it('runs without a template when neither the job nor the runner sizes the pod', () => {
    expect(resolveJobTemplateSource({}, {})).toEqual({ kind: 'none' })
    expect(resolveJobTemplateSource(undefined, {})).toEqual({ kind: 'none' })
  })

  it('uses the fixed template when the job sets no HOOK_JOB_* value', () => {
    expect(
      resolveJobTemplateSource(
        { FOO: 'bar' },
        { ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE: '/t/fixed.yaml' }
      )
    ).toEqual({ kind: 'fixed', path: '/t/fixed.yaml' })
  })

  it('uses the fixed template on a runner that also sizes per job, when the job asks for nothing', () => {
    expect(
      resolveJobTemplateSource(
        {},
        {
          ...RUNNER_ENV,
          ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE: '/t/fixed.yaml'
        }
      )
    ).toEqual({ kind: 'fixed', path: '/t/fixed.yaml' })
  })

  it('fails on a per-job runner without a fixed template when the job asks for nothing, naming the variables', () => {
    const problems = problemsOf(() => resolveJobTemplateSource({}, RUNNER_ENV))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('HOOK_JOB_MEMORY')
    expect(problems[0]).toContain('HOOK_JOB_CPU')
    expect(problems[0]).toContain('container.env')
  })

  it('fails when the job asks for a size on a runner that does not size per job', () => {
    const problems = problemsOf(() =>
      resolveJobTemplateSource(
        { HOOK_JOB_MEMORY: '7Gi', HOOK_JOB_CPU: '3' },
        { ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE: '/t/fixed.yaml' }
      )
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('HOOK_JOB_MEMORY, HOOK_JOB_CPU')
    expect(problems[0]).toContain('HOOK_JOB_PROFILE_DIR is not set')
  })

  it('reads the job values from the job container env only, not the runner env', () => {
    expect(
      resolveJobTemplateSource(
        {},
        {
          HOOK_JOB_MEMORY: '7Gi',
          HOOK_JOB_CPU: '3',
          ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE: '/t/fixed.yaml'
        }
      )
    ).toEqual({ kind: 'fixed', path: '/t/fixed.yaml' })
  })

  it('treats empty job values as unset', () => {
    expect(
      resolveJobTemplateSource(
        { HOOK_JOB_MEMORY: '', HOOK_JOB_CPU: '  ' },
        { ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE: '/t/fixed.yaml' }
      )
    ).toEqual({ kind: 'fixed', path: '/t/fixed.yaml' })
  })

  it('sizes per job with the defaults for arch and profile', () => {
    const source = resolveJobTemplateSource(
      { HOOK_JOB_MEMORY: '5Gi', HOOK_JOB_CPU: '3' },
      RUNNER_ENV
    )
    expect(source).toEqual({
      kind: 'per-job',
      size: {
        memoryMiB: 5120,
        cpuMillis: 3000,
        diskMiB: undefined,
        arch: 'amd64',
        profile: 'standard'
      },
      limits: {
        profileDir: '/profiles',
        profiles: ['standard', 'podman'],
        maxMemoryMiB: 26624,
        maxCpuMillis: 14000,
        maxDiskMiB: 30720,
        cpuLimitMillis: 20000
      }
    })
  })

  it('takes every value the job sets', () => {
    const source = resolveJobTemplateSource(
      {
        HOOK_JOB_MEMORY: '26Gi',
        HOOK_JOB_CPU: '500m',
        HOOK_JOB_DISK: '25Gi',
        HOOK_JOB_ARCH: 'arm64',
        HOOK_JOB_PROFILE: 'podman'
      },
      RUNNER_ENV
    )
    expect(source.kind === 'per-job' && source.size).toEqual({
      memoryMiB: 26624,
      cpuMillis: 500,
      diskMiB: 25600,
      arch: 'arm64',
      profile: 'podman'
    })
  })

  it('names every problem at once', () => {
    const problems = problemsOf(() =>
      resolveJobTemplateSource(
        {
          HOOK_JOB_MEMORY: '7G',
          HOOK_JOB_ARCH: 'x86_64',
          HOOK_JOB_PROFILE: 'gpu'
        },
        RUNNER_ENV
      )
    )
    expect(problems).toEqual([
      'HOOK_JOB_MEMORY is "7G", not a quantity in Mi or Gi (e.g. 512Mi, 7Gi, 1.5Gi)',
      'HOOK_JOB_CPU is required',
      'HOOK_JOB_ARCH is "x86_64", not amd64, arm64 or any',
      'HOOK_JOB_PROFILE is "gpu", not one this runner allows (standard, podman)'
    ])
  })

  it('requires memory when only the CPU is set', () => {
    expect(
      problemsOf(() =>
        resolveJobTemplateSource({ HOOK_JOB_CPU: '3' }, RUNNER_ENV)
      )
    ).toEqual(['HOOK_JOB_MEMORY is required'])
  })

  it('rejects values over the runner limits, naming the limit', () => {
    expect(
      problemsOf(() =>
        resolveJobTemplateSource(
          {
            HOOK_JOB_MEMORY: '27Gi',
            HOOK_JOB_CPU: '14.5',
            HOOK_JOB_DISK: '31Gi'
          },
          RUNNER_ENV
        )
      )
    ).toEqual([
      'HOOK_JOB_MEMORY is 27Gi, more than this runner allows (26Gi)',
      'HOOK_JOB_CPU is 14500m, more than this runner allows (14)',
      'HOOK_JOB_DISK is 31Gi, more than this runner allows (30Gi)'
    ])
  })

  it('accepts values equal to the limits', () => {
    const source = resolveJobTemplateSource(
      { HOOK_JOB_MEMORY: '26Gi', HOOK_JOB_CPU: '14', HOOK_JOB_DISK: '30Gi' },
      RUNNER_ENV
    )
    expect(source.kind).toBe('per-job')
  })

  it('rejects HOOK_JOB_DISK on a runner without HOOK_JOB_MAX_DISK', () => {
    const { HOOK_JOB_MAX_DISK: _, ...runner } = RUNNER_ENV
    expect(
      problemsOf(() =>
        resolveJobTemplateSource(
          { HOOK_JOB_MEMORY: '5Gi', HOOK_JOB_CPU: '3', HOOK_JOB_DISK: '1Gi' },
          runner
        )
      )
    ).toEqual([
      'HOOK_JOB_DISK is set, but this runner does not allow it (HOOK_JOB_MAX_DISK is not set on the runner)'
    ])
  })

  it('allows only the standard profile when the runner lists none', () => {
    const { HOOK_JOB_PROFILES: _, ...runner } = RUNNER_ENV
    expect(
      problemsOf(() =>
        resolveJobTemplateSource(
          {
            HOOK_JOB_MEMORY: '5Gi',
            HOOK_JOB_CPU: '3',
            HOOK_JOB_PROFILE: 'podman'
          },
          runner
        )
      )
    ).toEqual([
      'HOOK_JOB_PROFILE is "podman", not one this runner allows (standard)'
    ])
  })

  it('fails on runner misconfiguration, naming every problem', () => {
    const problems = problemsOf(() =>
      resolveJobTemplateSource(
        { HOOK_JOB_MEMORY: '5Gi', HOOK_JOB_CPU: '3' },
        {
          HOOK_JOB_PROFILE_DIR: '/profiles',
          HOOK_JOB_PROFILES: 'standard,../etc',
          HOOK_JOB_MAX_CPU: 'lots',
          HOOK_JOB_MAX_DISK: '30G'
        }
      )
    )
    expect(problems).toEqual([
      'runner configuration: HOOK_JOB_PROFILES lists "../etc", not a valid profile name',
      'runner configuration: HOOK_JOB_MAX_MEMORY is not set',
      'runner configuration: HOOK_JOB_MAX_CPU is "lots", not a number of CPUs (e.g. 2, 0.5 or 500m)',
      'runner configuration: HOOK_JOB_MAX_DISK is "30G", not a quantity in Mi or Gi (e.g. 512Mi, 7Gi, 1.5Gi)'
    ])
  })

  it('fails when the CPU limit is below the largest CPU request allowed', () => {
    expect(
      problemsOf(() =>
        resolveJobTemplateSource(
          { HOOK_JOB_MEMORY: '5Gi', HOOK_JOB_CPU: '3' },
          { ...RUNNER_ENV, HOOK_JOB_CPU_LIMIT: '10' }
        )
      )
    ).toEqual([
      'runner configuration: HOOK_JOB_CPU_LIMIT (10) is below HOOK_JOB_MAX_CPU (14)'
    ])
  })

  it('rejects a profile name that could leave the profile directory', () => {
    const problems = problemsOf(() =>
      resolveJobTemplateSource(
        {
          HOOK_JOB_MEMORY: '5Gi',
          HOOK_JOB_CPU: '3',
          HOOK_JOB_PROFILE: '../standard'
        },
        RUNNER_ENV
      )
    )
    expect(problems).toEqual([
      'HOOK_JOB_PROFILE is "../standard", not one this runner allows (standard, podman)'
    ])
  })
})

const SIZE: JobSize = {
  memoryMiB: 7168,
  cpuMillis: 2500,
  arch: 'arm64',
  profile: 'standard'
}
const LIMITS: JobSizeLimits = {
  profileDir: '/profiles',
  profiles: ['standard'],
  maxMemoryMiB: 26624,
  maxCpuMillis: 14000,
  maxDiskMiB: 30720,
  cpuLimitMillis: 20000
}

function profile(): any {
  return {
    metadata: { annotations: { 'karpenter.sh/do-not-disrupt': '12h' } },
    spec: {
      hostUsers: false,
      nodeSelector: {
        'kubernetes.io/os': 'linux',
        'kubernetes.io/arch': 'amd64'
      },
      containers: [
        {
          name: '$job',
          volumeMounts: [{ name: 'memory-storage', mountPath: '/mnt/memory/' }],
          resources: {
            limits: { cpu: 4, memory: '1Gi' },
            requests: { cpu: 1, memory: '1Gi', 'ephemeral-storage': '2Gi' }
          }
        }
      ],
      volumes: [{ name: 'memory-storage', emptyDir: { medium: 'Memory' } }]
    }
  }
}

describe('applyJobSize', () => {
  it("replaces the job container's memory and CPU, and keeps the rest of the profile", () => {
    const template = applyJobSize(profile(), SIZE, LIMITS)
    const job = template.spec?.containers.find(c => c.name === '$job')
    expect(job?.resources).toEqual({
      requests: { cpu: '2500m', memory: '7Gi', 'ephemeral-storage': '2Gi' },
      limits: { cpu: '20', memory: '7Gi' }
    })
    expect(job?.volumeMounts).toEqual([
      { name: 'memory-storage', mountPath: '/mnt/memory/' }
    ])
    expect(template.spec?.hostUsers).toBe(false)
    expect(template.spec?.volumes).toEqual(profile().spec.volumes)
  })

  it('sets the architecture selector and keeps the others', () => {
    const template = applyJobSize(profile(), SIZE, LIMITS)
    expect(template.spec?.nodeSelector).toEqual({
      'kubernetes.io/os': 'linux',
      'kubernetes.io/arch': 'arm64'
    })
  })

  it("overrides the profile's ephemeral-storage request with HOOK_JOB_DISK", () => {
    const template = applyJobSize(
      profile(),
      { ...SIZE, diskMiB: 25600 },
      LIMITS
    )
    const job = template.spec?.containers.find(c => c.name === '$job')
    expect(job?.resources?.requests?.['ephemeral-storage']).toBe('25Gi')
  })

  it("drops the profile's CPU limit when the runner sets none", () => {
    const template = applyJobSize(profile(), SIZE, {
      ...LIMITS,
      cpuLimitMillis: undefined
    })
    const job = template.spec?.containers.find(c => c.name === '$job')
    expect(job?.resources?.limits).toEqual({ memory: '7Gi' })
  })

  it('annotates the pod with the requested values and keeps the profile annotations', () => {
    const template = applyJobSize(profile(), { ...SIZE, diskMiB: 1536 }, LIMITS)
    expect(template.metadata?.annotations).toEqual({
      'karpenter.sh/do-not-disrupt': '12h',
      'custom-hook/memory': '7Gi',
      'custom-hook/cpu': '2500m',
      'custom-hook/disk': '1536Mi',
      'custom-hook/arch': 'arm64',
      'custom-hook/profile': 'standard'
    })
  })

  it('adds the job container when the profile has none', () => {
    const template = applyJobSize({ spec: { containers: [] } }, SIZE, LIMITS)
    expect(template.spec?.containers).toEqual([
      {
        name: '$job',
        resources: {
          requests: { memory: '7Gi', cpu: '2500m' },
          limits: { memory: '7Gi', cpu: '20' }
        }
      }
    ])
  })

  it('works on an empty profile', () => {
    const template = applyJobSize({}, SIZE, LIMITS)
    expect(template.spec?.nodeSelector).toEqual({
      'kubernetes.io/arch': 'arm64'
    })
    expect(template.spec?.containers).toHaveLength(1)
  })

  it('does not change the profile it was given', () => {
    const original = profile()
    applyJobSize(original, SIZE, LIMITS)
    expect(original).toEqual(profile())
  })

  it('describes the size in one line', () => {
    expect(formatJobSize(SIZE, LIMITS)).toBe(
      'job pod sized from the job: memory 7Gi, cpu 2500m (limit 20), disk from profile, arch arm64, profile standard'
    )
    expect(
      formatJobSize(
        { ...SIZE, diskMiB: 25600 },
        { ...LIMITS, cpuLimitMillis: undefined }
      )
    ).toBe(
      'job pod sized from the job: memory 7Gi, cpu 2500m (no limit), disk 25Gi, arch arm64, profile standard'
    )
  })
})

describe('loadJobTemplate and the job pod', () => {
  let dir: string

  beforeEach(() => {
    jest.clearAllMocks()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-size-'))
    fs.writeFileSync(
      path.join(dir, 'profile-standard.yaml'),
      [
        '---',
        'apiVersion: v1',
        'kind: PodTemplate',
        'metadata:',
        '  annotations:',
        '    karpenter.sh/do-not-disrupt: 12h',
        'spec:',
        '  hostUsers: false',
        '  nodeSelector:',
        '    kubernetes.io/os: linux',
        '  containers:',
        '    - name: $job',
        '      resources:',
        '        requests:',
        '          ephemeral-storage: 2Gi',
        ''
      ].join('\n')
    )
    fs.writeFileSync(
      path.join(dir, 'fixed.yaml'),
      'spec:\n  hostUsers: false\n'
    )
    process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE'] = 'test-namespace'
    process.env['GITHUB_WORKSPACE'] = '/__w/repo/repo'
    process.env['ACTIONS_RUNNER_POD_NAME'] = 'runner-abc'
    mockCreateNamespacedPod.mockImplementation(async ({ body }) => body)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    delete process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
    delete process.env['GITHUB_WORKSPACE']
    delete process.env['ACTIONS_RUNNER_POD_NAME']
  })

  it('returns nothing and logs nothing when the hook behaves as upstream', () => {
    expect(loadJobTemplate({}, {})).toEqual({})
  })

  it('reads the fixed template without a log line', () => {
    expect(
      loadJobTemplate(
        {},
        { ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE: path.join(dir, 'fixed.yaml') }
      )
    ).toEqual({ template: { spec: { hostUsers: false } } })
  })

  it('names the profile file when it cannot be read', () => {
    const problems = problemsOf(() =>
      loadJobTemplate(
        {
          HOOK_JOB_MEMORY: '5Gi',
          HOOK_JOB_CPU: '3',
          HOOK_JOB_PROFILE: 'podman'
        },
        { ...RUNNER_ENV, HOOK_JOB_PROFILE_DIR: dir }
      )
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(
      `runner configuration: cannot read profile podman from ${path.join(dir, 'profile-podman.yaml')}`
    )
  })

  it('builds the job pod from the profile and the job values', async () => {
    const jobEnv = { HOOK_JOB_MEMORY: '5Gi', HOOK_JOB_CPU: '3', FOO: 'bar' }
    const { template, log } = loadJobTemplate(jobEnv, {
      ...RUNNER_ENV,
      HOOK_JOB_PROFILE_DIR: dir
    })
    expect(log).toBe(
      'job pod sized from the job: memory 5Gi, cpu 3 (limit 20), disk from profile, arch amd64, profile standard'
    )

    const container = createContainerSpec(
      { image: 'alpine', environmentVariables: jobEnv } as any,
      'job',
      true,
      template
    )
    const pod = await createJobPod(
      'runner-abc-workflow',
      container,
      [],
      undefined,
      template
    )

    expect(pod.spec?.hostUsers).toBe(false)
    expect(pod.spec?.nodeSelector).toEqual({
      'kubernetes.io/os': 'linux',
      'kubernetes.io/arch': 'amd64'
    })
    expect(pod.metadata?.annotations).toEqual({
      'karpenter.sh/do-not-disrupt': '12h',
      'custom-hook/memory': '5Gi',
      'custom-hook/cpu': '3',
      'custom-hook/arch': 'amd64',
      'custom-hook/profile': 'standard'
    })
    const job = pod.spec?.containers.find(c => c.name === 'job')
    expect(job?.resources).toEqual({
      requests: { cpu: '3', memory: '5Gi', 'ephemeral-storage': '2Gi' },
      limits: { cpu: '20', memory: '5Gi' }
    })
    // The extension's `$job` entry is merged into `job`, never added as a container.
    expect(pod.spec?.containers.map(c => c.name)).toEqual(['job'])
    expect(job?.env).toEqual(
      expect.arrayContaining([
        { name: 'HOOK_JOB_MEMORY', value: '5Gi' },
        { name: 'FOO', value: 'bar' }
      ])
    )
  })
})
