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
import { CONTAINER_VOLUMES } from '../src/k8s/utils'

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

  it('without a work download, fs-init gets no download and no env', async () => {
    const pod = await createJobPod('runner-abc-workflow', {
      name: 'job',
      image: 'alpine'
    })
    const fsInit = pod.spec?.initContainers?.find(c => c.name === 'fs-init')
    expect(fsInit?.env).toBeUndefined()
    expect(fsInit?.command?.[2]).not.toContain('HOOK_WORK')
  })

  it('with a work download, fs-init downloads last and gets the URL and token', async () => {
    const pod = await createJobPod(
      'runner-abc-workflow',
      { name: 'job', image: 'alpine' },
      undefined,
      undefined,
      undefined,
      { url: 'http://10.0.0.7:4567/work', token: 'secret-token' }
    )
    const fsInit = pod.spec?.initContainers?.find(c => c.name === 'fs-init')
    expect(fsInit?.env).toEqual([
      { name: 'HOOK_WORK_URL', value: 'http://10.0.0.7:4567/work' },
      { name: 'HOOK_WORK_TOKEN', value: 'secret-token' }
    ])
    const script = fsInit?.command?.[2] as string
    expect(script.indexOf('mkdir -p /mnt/work/repo/repo')).toBeLessThan(
      script.indexOf('curl')
    )
    expect(script.trimEnd().endsWith(') || true')).toBe(true)
    // The token reaches curl through the env, not the command line in the pod spec.
    expect(script).not.toContain('secret-token')
    expect(script).toContain('"Authorization: Bearer $HOOK_WORK_TOKEN"')
  })

  describe('externals', () => {
    beforeEach(() => {
      process.env['ACTIONS_RUNNER_IMAGE'] = 'registry.example/runner:1.2.3'
    })
    afterEach(() => {
      delete process.env['ACTIONS_RUNNER_IMAGE']
    })

    async function podWith(mode: 'image' | 'copy') {
      return createJobPod(
        'runner-abc-workflow',
        { name: 'job', image: 'alpine', volumeMounts: CONTAINER_VOLUMES },
        [{ name: 'redis', image: 'redis', volumeMounts: CONTAINER_VOLUMES }],
        undefined,
        undefined,
        undefined,
        mode
      )
    }

    it('image: mounts the externals from the runner image, read-only, and copies nothing', async () => {
      const pod = await podWith('image')
      expect(pod.spec?.volumes?.find(v => v.name === 'externals')).toEqual({
        name: 'externals',
        image: { reference: 'registry.example/runner:1.2.3' }
      })
      for (const container of pod.spec?.containers ?? []) {
        expect(
          container.volumeMounts?.find(m => m.name === 'externals')
        ).toEqual({
          name: 'externals',
          mountPath: '/__e',
          subPath: 'home/runner/externals',
          readOnly: true
        })
      }
      const fsInit = pod.spec?.initContainers?.find(c => c.name === 'fs-init')
      expect(fsInit?.image).toBe('registry.example/runner:1.2.3')
      expect(fsInit?.command?.[2]).not.toContain('externals')
      expect(fsInit?.volumeMounts?.map(m => m.name)).toEqual(['work', 'github'])
    })

    it('image: leaves the shared mount list alone', async () => {
      await podWith('image')
      expect(CONTAINER_VOLUMES.find(m => m.name === 'externals')).toEqual({
        name: 'externals',
        mountPath: '/__e'
      })
    })

    it('copy: fs-init moves the externals into an emptyDir, as upstream', async () => {
      const pod = await podWith('copy')
      expect(pod.spec?.volumes?.find(v => v.name === 'externals')).toEqual({
        name: 'externals',
        emptyDir: {}
      })
      const fsInit = pod.spec?.initContainers?.find(c => c.name === 'fs-init')
      expect(fsInit?.command?.[2]).toContain(
        'mkdir -p /mnt/externals && mv /home/runner/externals/* /mnt/externals/'
      )
      expect(fsInit?.volumeMounts?.map(m => m.name)).toEqual([
        'externals',
        'work',
        'github'
      ])
      expect(
        pod.spec?.containers?.[0].volumeMounts?.find(
          m => m.name === 'externals'
        )
      ).toEqual({ name: 'externals', mountPath: '/__e' })
    })
  })
})
