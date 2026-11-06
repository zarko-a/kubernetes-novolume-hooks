import { execFileSync } from 'child_process'
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

describe('job pod spec', () => {
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

  async function fsInitScript(): Promise<string> {
    const pod = await createJobPod('runner-abc-workflow', {
      name: 'job',
      image: 'alpine'
    })
    const fsInit = pod.spec?.initContainers?.find(c => c.name === 'fs-init')
    expect(fsInit?.command?.slice(0, 2)).toEqual(['sh', '-c'])
    return fsInit?.command?.[2] as string
  }

  it('fs-init sets umask 0002 before creating any directory', async () => {
    const script = await fsInitScript()
    expect(script.startsWith('umask 0002 && ')).toBe(true)
    expect(script).toContain('mkdir -p /mnt/work/repo/repo')
  })

  it('fs-init creates group-writable directories when run by a shell', async () => {
    const script = await fsInitScript()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-init-'))
    try {
      // fs-init's directory part, pointed at a temporary root instead of /mnt, with a
      // restrictive umask in force first, as in the runner image.
      const directories = script
        .split(' && ')
        .filter(part => part.startsWith('umask') || part.startsWith('mkdir'))
        .join(' && ')
        .split('/mnt/')
        .join(`${root}/`)
      execFileSync('sh', ['-c', `umask 0022 && ${directories}`])

      const mode = fs.statSync(path.join(root, 'work/repo/repo')).mode & 0o777
      expect(mode.toString(8)).toBe('775')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps fsGroup 1001, which makes every container a member of group 1001', async () => {
    const pod = await createJobPod('runner-abc-workflow', {
      name: 'job',
      image: 'alpine'
    })
    expect(pod.spec?.securityContext?.fsGroup).toBe(1001)
  })
})
