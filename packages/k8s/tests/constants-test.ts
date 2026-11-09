import {
  getJobPodName,
  getRunnerPodName,
  getSecretName,
  getStepPodName,
  JOB_CONTAINER_NAME,
  MAX_POD_NAME_LENGTH,
  RUNNER_NAME_TAIL_LENGTH,
  RunnerInstanceLabel,
  shortenRunnerName,
  STEP_POD_NAME_SUFFIX_LENGTH
} from '../src/hooks/constants'

// A DNS-1123 subdomain, which pod and Secret names must be: dot-separated labels of
// lowercase letters, digits and `-`, each starting and ending with a letter or digit.
const DNS_SUBDOMAIN =
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/

// ARC 0.15 runner pod name: `<scale set>-runner-<5 random characters>`.
function arcRunnerName(scaleSet: string, suffix: string): string {
  return `${scaleSet}-runner-${suffix}`
}

describe('constants', () => {
  describe('runner instance label', () => {
    beforeEach(() => {
      process.env.ACTIONS_RUNNER_POD_NAME = 'example'
    })
    it('should throw if ACTIONS_RUNNER_POD_NAME env is not set', () => {
      delete process.env.ACTIONS_RUNNER_POD_NAME
      expect(() => new RunnerInstanceLabel()).toThrow()
    })

    it('should have key truthy', () => {
      const runnerInstanceLabel = new RunnerInstanceLabel()
      expect(typeof runnerInstanceLabel.key).toBe('string')
      expect(runnerInstanceLabel.key).toBeTruthy()
      expect(runnerInstanceLabel.key.length).toBeGreaterThan(0)
    })

    it('should have value as runner pod name', () => {
      const name = process.env.ACTIONS_RUNNER_POD_NAME as string
      const runnerInstanceLabel = new RunnerInstanceLabel()
      expect(typeof runnerInstanceLabel.value).toBe('string')
      expect(runnerInstanceLabel.value).toBe(name)
    })

    it('should have toString combination of key and value', () => {
      const runnerInstanceLabel = new RunnerInstanceLabel()
      expect(runnerInstanceLabel.toString()).toBe(
        `${runnerInstanceLabel.key}=${runnerInstanceLabel.value}`
      )
    })
  })

  describe('getRunnerPodName', () => {
    it('should throw if ACTIONS_RUNNER_POD_NAME env is not set', () => {
      delete process.env.ACTIONS_RUNNER_POD_NAME
      expect(() => getRunnerPodName()).toThrow()

      process.env.ACTIONS_RUNNER_POD_NAME = ''
      expect(() => getRunnerPodName()).toThrow()
    })

    it('should return corrent ACTIONS_RUNNER_POD_NAME name', () => {
      const name = 'example'
      process.env.ACTIONS_RUNNER_POD_NAME = name
      expect(getRunnerPodName()).toBe(name)
    })
  })

  describe('getJobPodName', () => {
    it('should throw on getJobPodName if ACTIONS_RUNNER_POD_NAME env is not set', () => {
      delete process.env.ACTIONS_RUNNER_POD_NAME
      expect(() => getJobPodName()).toThrow()

      process.env.ACTIONS_RUNNER_POD_NAME = ''
      expect(() => getRunnerPodName()).toThrow()
    })

    it('should contain suffix -workflow', () => {
      const tableTests = [
        {
          podName: 'test',
          expect: 'test-workflow'
        },
        {
          // podName.length == 63
          podName:
            'abcdaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          expect:
            'abcdaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-workflow'
        }
      ]

      for (const tt of tableTests) {
        process.env.ACTIONS_RUNNER_POD_NAME = tt.podName
        const actual = getJobPodName()
        expect(actual).toBe(tt.expect)
      }
    })
  })

  describe('getSecretName', () => {
    it('should throw if ACTIONS_RUNNER_POD_NAME env is not set', () => {
      delete process.env.ACTIONS_RUNNER_POD_NAME
      expect(() => getSecretName()).toThrow()

      process.env.ACTIONS_RUNNER_POD_NAME = ''
      expect(() => getSecretName()).toThrow()
    })

    it('should contain suffix -secret- and name trimmed', () => {
      const podNames = [
        'test',
        'abcdaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      ]

      for (const podName of podNames) {
        process.env.ACTIONS_RUNNER_POD_NAME = podName
        const actual = getSecretName()
        const re = new RegExp(
          `${podName.substring(
            MAX_POD_NAME_LENGTH -
              '-secret-'.length -
              STEP_POD_NAME_SUFFIX_LENGTH
          )}-secret-[a-z0-9]{8,}`
        )
        expect(actual).toMatch(re)
      }
    })
  })

  describe('getStepPodName', () => {
    it('should throw if ACTIONS_RUNNER_POD_NAME env is not set', () => {
      delete process.env.ACTIONS_RUNNER_POD_NAME
      expect(() => getStepPodName()).toThrow()

      process.env.ACTIONS_RUNNER_POD_NAME = ''
      expect(() => getStepPodName()).toThrow()
    })

    it('should contain suffix -step- and name trimmed', () => {
      const podNames = [
        'test',
        'abcdaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      ]

      for (const podName of podNames) {
        process.env.ACTIONS_RUNNER_POD_NAME = podName
        const actual = getStepPodName()
        const re = new RegExp(
          `${podName.substring(
            MAX_POD_NAME_LENGTH - '-step-'.length - STEP_POD_NAME_SUFFIX_LENGTH
          )}-step-[a-z0-9]{8,}`
        )
        expect(actual).toMatch(re)
      }
    })
  })

  describe('long runner pod names keep their unique tail', () => {
    afterEach(() => {
      delete process.env.ACTIONS_RUNNER_POD_NAME
    })

    it('leaves a job pod name that fits unchanged, up to exactly 63 characters', () => {
      for (const length of [14, 41, 53, 54]) {
        const runner = arcRunnerName('s'.repeat(length - 13), 'ab1cd')
        expect(runner).toHaveLength(length)
        process.env.ACTIONS_RUNNER_POD_NAME = runner
        expect(getJobPodName()).toBe(`${runner}-workflow`)
      }
      process.env.ACTIONS_RUNNER_POD_NAME = arcRunnerName(
        's'.repeat(41),
        'ab1cd'
      )
      expect(getJobPodName()).toHaveLength(MAX_POD_NAME_LENGTH)
    })

    it('cuts the scale set name, not the random suffix, when the name is too long', () => {
      for (const scaleSetLength of [42, 50, 63, 120]) {
        const runner = arcRunnerName('s'.repeat(scaleSetLength), 'xy9z0')
        process.env.ACTIONS_RUNNER_POD_NAME = runner
        const name = getJobPodName()
        expect(name.length).toBeLessThanOrEqual(MAX_POD_NAME_LENGTH)
        expect(name).toMatch(/^s+-runner-xy9z0-workflow$/)
        expect(name).toMatch(DNS_SUBDOMAIN)
      }
    })

    it('gives two runners of a set with a long name different job pod names', () => {
      const scaleSet = 'cb-linux-an-unusually-long-scale-set-12gb-4cpu-amd64' // 52 characters
      const first = arcRunnerName(scaleSet, 'aaaaa')
      const second = arcRunnerName(scaleSet, 'bbbbb')
      // Upstream's cut from the end gave both the same name (409 AlreadyExists).
      const upstream = (runner: string): string =>
        `${runner.substring(0, MAX_POD_NAME_LENGTH - '-workflow'.length)}-workflow`
      expect(upstream(first)).toBe(upstream(second))

      process.env.ACTIONS_RUNNER_POD_NAME = first
      const firstName = getJobPodName()
      process.env.ACTIONS_RUNNER_POD_NAME = second
      const secondName = getJobPodName()
      expect(firstName).not.toBe(secondName)
      expect(firstName).toBe(
        'cb-linux-an-unusually-long-scale-set-12gb-runner-aaaaa-workflow'
      )
      expect(secondName.endsWith('-runner-bbbbb-workflow')).toBe(true)
    })

    it('never leaves a dash or dot where the name was cut', () => {
      // Cut points that fall right after a `-` or a `.` in the scale set name.
      for (const scaleSet of [
        `${'s'.repeat(40)}-${'t'.repeat(10)}`,
        `${'s'.repeat(40)}--${'t'.repeat(10)}`,
        `${'s'.repeat(40)}.${'t'.repeat(10)}`
      ]) {
        process.env.ACTIONS_RUNNER_POD_NAME = arcRunnerName(scaleSet, 'q1w2e')
        const name = getJobPodName()
        expect(name).toMatch(DNS_SUBDOMAIN)
        expect(name).toMatch(/^s+-runner-q1w2e-workflow$/)
      }
    })

    it('keeps the tail in step pod and Secret names too', () => {
      process.env.ACTIONS_RUNNER_POD_NAME = arcRunnerName(
        's'.repeat(60),
        'z9y8x'
      )
      const step = getStepPodName()
      const secret = getSecretName()
      for (const name of [step, secret]) {
        expect(name.length).toBeLessThanOrEqual(MAX_POD_NAME_LENGTH)
        expect(name).toMatch(DNS_SUBDOMAIN)
      }
      expect(step).toMatch(/-runner-z9y8x-step-[a-f0-9]{8}$/)
      expect(secret).toMatch(/-runner-z9y8x-secret-[a-f0-9]{8}$/)
    })

    it('shortenRunnerName keeps exactly the last RUNNER_NAME_TAIL_LENGTH characters', () => {
      expect(RUNNER_NAME_TAIL_LENGTH).toBe(13)
      expect(shortenRunnerName('abc', 10)).toBe('abc')
      expect(shortenRunnerName('0123456789abcdefghijklmnop', 20)).toBe(
        '0123456defghijklmnop'
      )
    })
  })

  describe('const values', () => {
    it('should have constants set', () => {
      expect(JOB_CONTAINER_NAME).toBeTruthy()
      expect(MAX_POD_NAME_LENGTH).toBeGreaterThan(0)
      expect(STEP_POD_NAME_SUFFIX_LENGTH).toBeGreaterThan(0)
    })
  })
})
