// HOOK_* settings that take one of a few words. Each is read from the job container's env
// (`container.env` in the workflow) first, then the runner's env (a scale-set default), then
// falls back to its built-in default.

export type Env = Record<string, string | undefined>

export interface ChoiceSetting<T extends string> {
  value: T
  // Where the value came from: `job container env`, `runner env` or `default`.
  source: string
  // Set when a value was given but is not one of the choices; value is then the default.
  warning?: string
}

export function resolveEnvChoice<T extends string>(
  name: string,
  choices: readonly T[],
  fallback: T,
  jobEnv: Env | undefined,
  runnerEnv: Env
): ChoiceSetting<T> {
  let raw: string | undefined
  let source = 'default'
  if (jobEnv?.[name]) {
    raw = jobEnv[name]
    source = 'job container env'
  } else if (runnerEnv[name]) {
    raw = runnerEnv[name]
    source = 'runner env'
  }
  if (raw === undefined) {
    return { value: fallback, source }
  }
  const value = raw.trim().toLowerCase()
  const choice = choices.find(c => c === value)
  if (choice !== undefined) {
    return { value: choice, source }
  }
  return {
    value: fallback,
    source: 'default',
    warning: `${name} from ${source} is "${raw}", not ${choices.join(' or ')}; using ${fallback}`
  }
}
