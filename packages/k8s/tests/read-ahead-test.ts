import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

jest.mock('@actions/core', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}))

import { readAheadCommand, startReadAhead } from '../src/k8s/read-ahead'

describe('read-ahead', () => {
  let scratch: string
  let root: string
  let bin: string
  let log: string
  let env: NodeJS.ProcessEnv

  // A `cat` that records the files it was given (one per line) and then runs the given
  // shell snippet, instead of reading them.
  function stubCat(then = ''): void {
    fs.writeFileSync(
      path.join(bin, 'cat'),
      `#!/bin/sh\nfor f; do printf '%s\\n' "$f" >>'${log}'; done\n${then}\n`,
      { mode: 0o755 }
    )
  }

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'read-ahead-'))
    root = path.join(scratch, '_work')
    bin = path.join(scratch, 'bin')
    log = path.join(scratch, 'cat.log')
    fs.mkdirSync(bin)
    fs.mkdirSync(path.join(root, '_actions/a/b'), { recursive: true })
    fs.mkdirSync(path.join(root, '_temp'), { recursive: true })
    for (let i = 0; i < 150; i++) {
      fs.writeFileSync(path.join(root, '_actions/a/b', `f${i}`), 'x')
    }
    fs.writeFileSync(path.join(root, '_temp', 'with space'), 'x')
    fs.symlinkSync('f0', path.join(root, '_actions/a/b/link'))
    env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  })

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  it('reads every regular file once, in parallel batches', async () => {
    stubCat()
    const ms = await startReadAhead(root, env).finished
    expect(typeof ms).toBe('number')

    const read = fs.readFileSync(log, 'utf8').trim().split('\n').sort()
    expect(read).toHaveLength(151)
    expect(new Set(read).size).toBe(151)
    expect(read).toContain(path.join(root, '_temp', 'with space'))
    expect(read).not.toContain(path.join(root, '_actions/a/b/link'))
  })

  it('finishes quietly when the directory does not exist', async () => {
    stubCat()
    const ms = await startReadAhead(path.join(scratch, 'missing'), env).finished
    expect(typeof ms).toBe('number')
    expect(fs.existsSync(log)).toBe(false)
  })

  it('stop() ends every reader at once', async () => {
    const pids = path.join(scratch, 'pids')
    stubCat(`echo $$ >>'${pids}'; sleep 30`)
    const readAhead = startReadAhead(root, env)
    // Wait until the readers are running.
    for (let i = 0; i < 100 && !fs.existsSync(pids); i++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    readAhead.stop()
    expect(await readAhead.finished).toBeUndefined()

    await new Promise(resolve => setTimeout(resolve, 100))
    // Killed processes nobody reaps stay as zombies (state Z) in a container without an init.
    for (const pid of fs.readFileSync(pids, 'utf8').trim().split('\n')) {
      let state = 'gone'
      try {
        state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]
      } catch {
        // No such process.
      }
      expect(['gone', 'Z']).toContain(state)
    }
  })

  it('quotes the root for the shell', () => {
    expect(readAheadCommand("/home/runner/it's _work", 8)).toBe(
      `find '/home/runner/it'"'"'s _work' -type f -print0 2>/dev/null | ` +
        'xargs -0 -r -P 8 -n 64 cat >/dev/null 2>&1; exit 0'
    )
  })
})
