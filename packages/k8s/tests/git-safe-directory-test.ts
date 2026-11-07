import * as k8s from '@kubernetes/client-node'
import {
  addGitSafeDirectory,
  resolveGitSafeDirectory
} from '../src/k8s/git-safe-directory'

describe('addGitSafeDirectory', () => {
  it('adds safe.directory=* as the only environment config entry', () => {
    const env: k8s.V1EnvVar[] = [{ name: 'CI', value: 'true' }]
    expect(addGitSafeDirectory(env)).toBeUndefined()
    expect(env).toEqual([
      { name: 'CI', value: 'true' },
      { name: 'GIT_CONFIG_COUNT', value: '1' },
      { name: 'GIT_CONFIG_KEY_0', value: 'safe.directory' },
      { name: 'GIT_CONFIG_VALUE_0', value: '*' }
    ])
  })

  it('appends after the entries the workflow already set', () => {
    const env: k8s.V1EnvVar[] = [
      { name: 'GIT_CONFIG_COUNT', value: '2' },
      { name: 'GIT_CONFIG_KEY_0', value: 'user.name' },
      { name: 'GIT_CONFIG_VALUE_0', value: 'ci' },
      { name: 'GIT_CONFIG_KEY_1', value: 'core.autocrlf' },
      { name: 'GIT_CONFIG_VALUE_1', value: 'false' }
    ]
    expect(addGitSafeDirectory(env)).toBeUndefined()
    expect(env).toEqual([
      { name: 'GIT_CONFIG_COUNT', value: '3' },
      { name: 'GIT_CONFIG_KEY_0', value: 'user.name' },
      { name: 'GIT_CONFIG_VALUE_0', value: 'ci' },
      { name: 'GIT_CONFIG_KEY_1', value: 'core.autocrlf' },
      { name: 'GIT_CONFIG_VALUE_1', value: 'false' },
      { name: 'GIT_CONFIG_KEY_2', value: 'safe.directory' },
      { name: 'GIT_CONFIG_VALUE_2', value: '*' }
    ])
  })

  it('replaces an entry past the count instead of adding a second one', () => {
    const env: k8s.V1EnvVar[] = [
      { name: 'GIT_CONFIG_COUNT', value: '0' },
      { name: 'GIT_CONFIG_KEY_0', value: 'user.name' },
      { name: 'GIT_CONFIG_VALUE_0', value: 'ignored by git' }
    ]
    expect(addGitSafeDirectory(env)).toBeUndefined()
    expect(env).toEqual([
      { name: 'GIT_CONFIG_COUNT', value: '1' },
      { name: 'GIT_CONFIG_KEY_0', value: 'safe.directory' },
      { name: 'GIT_CONFIG_VALUE_0', value: '*' }
    ])
  })

  it.each([
    [{ name: 'GIT_CONFIG_COUNT', value: 'two' }],
    [{ name: 'GIT_CONFIG_COUNT', value: '-1' }],
    [{ name: 'GIT_CONFIG_COUNT', value: '' }],
    [
      {
        name: 'GIT_CONFIG_COUNT',
        valueFrom: { configMapKeyRef: { name: 'git', key: 'count' } }
      }
    ]
  ])('leaves a GIT_CONFIG_COUNT it cannot read alone: %j', count => {
    const env: k8s.V1EnvVar[] = [{ ...count }]
    expect(addGitSafeDirectory(env)).toMatch(
      /GIT_CONFIG_COUNT to something other than a number/
    )
    expect(env).toEqual([count])
  })
})

describe('resolveGitSafeDirectory', () => {
  it('is on by default', () => {
    expect(resolveGitSafeDirectory(undefined, {})).toEqual({
      value: 'true',
      source: 'default'
    })
  })

  it('is turned off from the job container env before the runner env', () => {
    expect(
      resolveGitSafeDirectory(
        { HOOK_GIT_SAFE_DIRECTORY: 'false' },
        { HOOK_GIT_SAFE_DIRECTORY: 'true' }
      )
    ).toEqual({ value: 'false', source: 'job container env' })
  })

  it('warns about a value that is not true or false and stays on', () => {
    const setting = resolveGitSafeDirectory(undefined, {
      HOOK_GIT_SAFE_DIRECTORY: 'off'
    })
    expect(setting.value).toBe('true')
    expect(setting.warning).toMatch(/HOOK_GIT_SAFE_DIRECTORY/)
  })
})
