const mockExecListing = jest.fn()
const mockInfo = jest.fn()

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: (message: string) => mockInfo(message),
  warning: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/k8s', () => {
  const actual = jest.requireActual('../src/k8s')
  return {
    ...actual,
    execListing: (...args: unknown[]) => mockExecListing(...args)
  }
})

import { logJobPodArch } from '../src/hooks/prepare-job'
import {
  applyJobSize,
  archFromUname,
  formatJobSize,
  hasAnyJobArch,
  JobSize,
  JobSizeLimits,
  resolveJobTemplateSource
} from '../src/k8s/job-size'

const RUNNER_ENV = {
  HOOK_JOB_PROFILE_DIR: '/profiles',
  HOOK_JOB_MAX_MEMORY: '26Gi',
  HOOK_JOB_MAX_CPU: '14'
}

const SIZE: JobSize = {
  memoryMiB: 5120,
  cpuMillis: 3000,
  arch: 'any',
  profile: 'standard'
}
const LIMITS: JobSizeLimits = {
  profileDir: '/profiles',
  profiles: ['standard'],
  maxMemoryMiB: 26624,
  maxCpuMillis: 14000
}

function profile(nodeSelector: Record<string, string>): any {
  return {
    spec: {
      nodeSelector,
      containers: [{ name: '$job' }]
    }
  }
}

describe('HOOK_JOB_ARCH any', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('is accepted from the job env', () => {
    const source = resolveJobTemplateSource(
      { HOOK_JOB_MEMORY: '5Gi', HOOK_JOB_CPU: '3', HOOK_JOB_ARCH: 'any' },
      RUNNER_ENV
    )
    expect(source.kind === 'per-job' && source.size.arch).toBe('any')
  })

  it('stays amd64 when unset', () => {
    const source = resolveJobTemplateSource(
      { HOOK_JOB_MEMORY: '5Gi', HOOK_JOB_CPU: '3' },
      RUNNER_ENV
    )
    expect(source.kind === 'per-job' && source.size.arch).toBe('amd64')
  })

  it('sets no architecture selector and removes the profile one', () => {
    const template = applyJobSize(
      profile({ 'kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64' }),
      SIZE,
      LIMITS
    )
    expect(template.spec?.nodeSelector).toEqual({ 'kubernetes.io/os': 'linux' })
  })

  it('still pins amd64 and arm64 as before', () => {
    for (const arch of ['amd64', 'arm64'] as const) {
      const template = applyJobSize(
        profile({ 'kubernetes.io/os': 'linux' }),
        { ...SIZE, arch },
        LIMITS
      )
      expect(template.spec?.nodeSelector).toEqual({
        'kubernetes.io/os': 'linux',
        'kubernetes.io/arch': arch
      })
    }
  })

  it('annotates the pod with any and says so in the job log line', () => {
    const template = applyJobSize(profile({}), SIZE, LIMITS)
    expect(template.metadata?.annotations?.['custom-hook/arch']).toBe('any')
    expect(formatJobSize(SIZE, LIMITS)).toContain('arch any')
    expect(hasAnyJobArch({ metadata: template.metadata })).toBe(true)
  })

  it('hasAnyJobArch is false for pinned or unsized pods', () => {
    expect(
      hasAnyJobArch({
        metadata: { annotations: { 'custom-hook/arch': 'arm64' } }
      })
    ).toBe(false)
    expect(hasAnyJobArch({ metadata: {} })).toBe(false)
    expect(hasAnyJobArch({})).toBe(false)
  })

  it('maps uname -m names to Kubernetes architectures', () => {
    expect(archFromUname('x86_64\n')).toBe('amd64')
    expect(archFromUname('aarch64\n')).toBe('arm64')
    expect(archFromUname('arm64')).toBe('arm64')
    expect(archFromUname('riscv64')).toBe('riscv64')
  })

  it('logs where the job pod runs', async () => {
    mockExecListing.mockResolvedValue('aarch64\n')
    await logJobPodArch('runner-abc-workflow')
    expect(mockExecListing).toHaveBeenCalledWith('runner-abc-workflow', 'job', [
      'uname',
      '-m'
    ])
    expect(mockInfo).toHaveBeenCalledWith(
      '[custom-hook] job pod runs on arm64 (HOOK_JOB_ARCH any)'
    )
  })

  it('does not fail the job when the image has no uname', async () => {
    mockExecListing.mockRejectedValue(new Error('executable file not found'))
    await expect(logJobPodArch('runner-abc-workflow')).resolves.toBeUndefined()
    expect(mockInfo).toHaveBeenCalledWith(
      '[custom-hook] job pod architecture unknown (HOOK_JOB_ARCH any): uname -m failed: executable file not found'
    )
  })
})
