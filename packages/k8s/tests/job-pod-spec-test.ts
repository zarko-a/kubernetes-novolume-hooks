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
import { CONTAINER_VOLUMES, prepareJobScript } from '../src/k8s/utils'

// The postStart our pod templates used as the workaround for upstream #330. Kept here
// verbatim so the test proves fs-init's links and the template's coexist.
const TEMPLATE_POST_START = `mkdir -p /github && \\
ln -sfn /__w/_temp/_github_workflow /github/workflow && \\
ln -sfn /__w/_temp/_github_home /github/home`

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

  describe('/github links (upstream #330)', () => {
    // fs-init's commands that touch the /github volume, run for real with /mnt pointed at a
    // scratch directory.
    function runGithubPart(script: string, root: string): void {
      const part = script
        .split(' && ')
        .filter(
          p =>
            p.startsWith('umask') ||
            p.startsWith('mkdir -p /mnt/github') ||
            p.startsWith('ln ')
        )
        .join(' && ')
        .split('/mnt/')
        .join(`${root}/`)
      execFileSync('sh', ['-c', `umask 0022 && ${part}`])
    }

    it('fs-init links /github/workflow and /github/home into _temp', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-init-github-'))
      try {
        runGithubPart(await fsInitScript(), root)
        expect(fs.readlinkSync(path.join(root, 'github/workflow'))).toBe(
          '/__w/_temp/_github_workflow'
        )
        expect(fs.readlinkSync(path.join(root, 'github/home'))).toBe(
          '/__w/_temp/_github_home'
        )
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('a template postStart that creates the same links still succeeds', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-init-github-'))
      try {
        runGithubPart(await fsInitScript(), root)
        execFileSync('sh', [
          '-c',
          TEMPLATE_POST_START.split('/github').join(`${root}/github`)
        ])
        expect(fs.readdirSync(path.join(root, 'github')).sort()).toEqual([
          'home',
          'workflow'
        ])
        expect(fs.readlinkSync(path.join(root, 'github/workflow'))).toBe(
          '/__w/_temp/_github_workflow'
        )
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('the links resolve to the live _temp files, not a copy', async () => {
      // Same layout as the job container, under a scratch root: links made by the same
      // commands, with targets rewritten to the scratch root.
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-init-github-'))
      try {
        const script = (await fsInitScript())
          .split('/__w/')
          .join(`${root}/__w/`)
        runGithubPart(script, root)
        const workflow = path.join(root, '__w/_temp/_github_workflow')
        fs.mkdirSync(workflow, { recursive: true })
        fs.writeFileSync(path.join(workflow, 'event.json'), '{"a":1}')
        const eventPath = path.join(root, 'github/workflow/event.json')
        expect(fs.readFileSync(eventPath, 'utf8')).toBe('{"a":1}')
        // A later step's _temp sync rewrites the file; the job container sees the new one.
        fs.writeFileSync(path.join(workflow, 'event.json'), '{"a":2}')
        expect(fs.readFileSync(eventPath, 'utf8')).toBe('{"a":2}')
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })

    it('fs-init creates the links on the HTTP transfer path too, before the download', async () => {
      const pod = await createJobPod(
        'runner-abc-workflow',
        { name: 'job', image: 'alpine' },
        undefined,
        undefined,
        undefined,
        { url: 'http://10.0.0.7:4567/work', token: 'secret-token' }
      )
      const script = pod.spec?.initContainers?.find(c => c.name === 'fs-init')
        ?.command?.[2] as string
      const link = script.indexOf('ln -sfn /__w/_temp/_github_workflow')
      expect(link).toBeGreaterThan(script.indexOf('mkdir -p /mnt/github'))
      expect(link).toBeLessThan(script.indexOf('curl'))
    })

    it('the prepare script for container.volumes no longer copies /github', () => {
      process.env['RUNNER_TEMP'] = fs.mkdtempSync(
        path.join(os.tmpdir(), 'prepare-')
      )
      try {
        const { runnerPath } = prepareJobScript([
          { sourceVolumePath: '/a', targetVolumePath: '/data', readOnly: false }
        ])
        const content = fs.readFileSync(runnerPath, 'utf8')
        expect(content).not.toContain('cp ')
        expect(content).not.toContain('/github')
        expect(content).toContain('mkdir -p /data')
      } finally {
        fs.rmSync(process.env['RUNNER_TEMP'] as string, {
          recursive: true,
          force: true
        })
        delete process.env['RUNNER_TEMP']
      }
    })
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
