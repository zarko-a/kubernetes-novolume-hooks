import { resolveEnvChoice } from '../src/k8s/settings'
import { resolveExternals } from '../src/k8s/externals'

describe('resolveEnvChoice', () => {
  const resolve = (job?: Record<string, string>, runner = {}) =>
    resolveEnvChoice('HOOK_X', ['a', 'b'], 'a', job, runner)

  it('uses the default when neither env sets the variable, or sets it empty', () => {
    expect(resolve()).toEqual({ value: 'a', source: 'default' })
    expect(resolve({ HOOK_X: '' }, { HOOK_X: '' })).toEqual({
      value: 'a',
      source: 'default'
    })
  })

  it('prefers the job container env over the runner env', () => {
    expect(resolve({ HOOK_X: 'b' }, { HOOK_X: 'a' })).toEqual({
      value: 'b',
      source: 'job container env'
    })
    expect(resolve({}, { HOOK_X: ' B ' })).toEqual({
      value: 'b',
      source: 'runner env'
    })
  })

  it('warns and uses the default for an unknown value', () => {
    expect(resolve({ HOOK_X: 'c' })).toEqual({
      value: 'a',
      source: 'default',
      warning: 'HOOK_X from job container env is "c", not a or b; using a'
    })
  })
})

describe('resolveExternals', () => {
  it('defaults to image and accepts copy', () => {
    expect(resolveExternals(undefined, {})).toEqual({
      mode: 'image',
      source: 'default'
    })
    expect(resolveExternals(undefined, { HOOK_EXTERNALS: 'copy' })).toEqual({
      mode: 'copy',
      source: 'runner env'
    })
  })
})
