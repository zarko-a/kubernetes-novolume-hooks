import * as k8s from '@kubernetes/client-node'
import { ChoiceSetting, Env, resolveEnvChoice } from './settings'

// git refuses a repository owned by another user ("dubious ownership"). In a job pod the
// workspace is always owned by uid 1001 (fs-init, and the HTTP transfer's files), while the
// job container usually runs as root or as its image's own user. actions/checkout adds
// safe.directory only to a temporary HOME for its own git calls, so a later step's git
// fails unless the workflow adds safe.directory itself.
//
// The hook adds `safe.directory=*` to the job container's environment as git's environment
// config (GIT_CONFIG_COUNT, GIT_CONFIG_KEY_<n>, GIT_CONFIG_VALUE_<n>, git 2.31+). git counts
// that as the command scope, which safe.directory is read from; checked with root and a
// uid-1001 repository on git 2.34.1 (Ubuntu 22.04's backport of the check), 2.39.5 and
// 2.53.0. It changes no file owners, and it works for any uid the job container runs as.
// `*` rather than `/__w/*`: the job pod is
// single-tenant, which is what the check protects, and git before 2.46 does not match
// `/*` patterns.
export const GIT_SAFE_DIRECTORY_VALUE = '*'

export type GitSafeDirectoryMode = 'true' | 'false'

export function resolveGitSafeDirectory(
  jobEnv: Env | undefined,
  runnerEnv: Env
): ChoiceSetting<GitSafeDirectoryMode> {
  return resolveEnvChoice<GitSafeDirectoryMode>(
    'HOOK_GIT_SAFE_DIRECTORY',
    ['true', 'false'],
    'true',
    jobEnv,
    runnerEnv
  )
}

// Appends the safe.directory entry to a container's env, after any GIT_CONFIG_* entries the
// workflow or the pod template already set. Returns a warning, and changes nothing, when
// GIT_CONFIG_COUNT is set to something other than a whole number.
export function addGitSafeDirectory(env: k8s.V1EnvVar[]): string | undefined {
  const count = env.find(e => e.name === 'GIT_CONFIG_COUNT')
  if (!count) {
    env.push(
      { name: 'GIT_CONFIG_COUNT', value: '1' },
      { name: 'GIT_CONFIG_KEY_0', value: 'safe.directory' },
      { name: 'GIT_CONFIG_VALUE_0', value: GIT_SAFE_DIRECTORY_VALUE }
    )
    return undefined
  }
  const raw = count.value
  if (count.valueFrom || raw === undefined || !/^\s*\d+\s*$/.test(raw)) {
    return (
      'the job container sets GIT_CONFIG_COUNT to something other than a number; ' +
      'not adding safe.directory to its git config'
    )
  }
  const index = parseInt(raw, 10)
  count.value = String(index + 1)
  // An entry past the count is ignored by git; replace it rather than add a duplicate name.
  const taken = [`GIT_CONFIG_KEY_${index}`, `GIT_CONFIG_VALUE_${index}`]
  for (let i = env.length - 1; i >= 0; i--) {
    if (taken.includes(env[i].name)) {
      env.splice(i, 1)
    }
  }
  env.push(
    { name: `GIT_CONFIG_KEY_${index}`, value: 'safe.directory' },
    { name: `GIT_CONFIG_VALUE_${index}`, value: GIT_SAFE_DIRECTORY_VALUE }
  )
  return undefined
}
