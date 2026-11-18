import * as shlex from 'shlex'

// Detached steps (survive a dropped exec connection). A `run:` step used to live inside one
// exec session: when the API server or the kubelet dropped the websocket, containerd killed
// the step with it (the exec runs with the streaming request's context), and the job failed.
// Now the exec session only starts the step and reads its output:
//
// - `start` (the step's one exec session in the normal case) stops what an interrupted
//   earlier step left running (the barrier), starts a supervisor in its own session, and
//   then follows the step's output like `follow` from offset 0.
// - `supervise` runs the step's command (stepCommand: `_temp` down, the script, the file
//   commands up) in its own process group, its stdout and stderr appended to two files, and
//   records the exit code in a third. It polls the hook's step server every second; the
//   answer also carries a cancel. It stops the step (SIGTERM, SIGKILL 3s later) when the hook
//   is gone, or when the step's output on disk passes HOOK_RUN_OUTPUT_LIMIT_MB.
// - `follow <offset out> <offset err>` prints the two files from those byte offsets and
//   exits with the step's exit code once it is recorded. After a dropped connection the hook
//   runs it with the bytes it has received so far: no duplicate and no missing output.
// - `signal <SIG>` sends a signal to the step's process group (the hook's cancel).
// - `status` prints `exit <code>`, `running` or `gone`: the hook asks before it believes an
//   exit code that could also be the reader's own death (128+n).
//
// The hook is gone only when both links to it are: HOOK_RUN_ORPHAN_SECONDS liveness polls in
// a row failed, and no `start` or `follow` process is reading the output (containerd kills
// that process when the hook's exec session ends). One link alone is not enough: the polls
// fail during a pod network blip, the reader dies during an API server restart, and the
// step must survive both.
//
// Files, in STEP_DIR_ROOT/<step id>/:
//   pid          the supervisor, "<pid> <start time>" (the start time guards against PID
//                reuse). Created exclusively: it is the lock that makes a step run once
//   pgid         the step's process group leader, the same way
//   follower     the process reading the output for the hook, the same way
//   interrupted  the step's group has had the cancel's SIGINT (it must get only one)
//   stdout       the step's stdout, append-only
//   stderr       the step's stderr, append-only, and every message of this client about the
//                step: the hook resumes by byte offsets, so nothing else may be printed
//   exit         "<code>" or "<code> <signal>", written to exit.tmp and renamed
//
// A finished step's directory is removed by the next step's barrier, not by the hook: the
// hook would need another exec session per step for it, and removing it from `follow`
// would lose the end of the output if the connection dropped in the last moment.

// Outside `_temp`, so the per-step `_temp` merge and upload never touch it.
export const STEP_DIR_ROOT = '/__w/_custom_hook/steps'

// `follow` exits with this, printing nothing, when the step's directory does not exist: the
// launch never ran. The hook believes it only while its step server has had no request
// (a started step always fetches `_temp` first), since a step's own script may exit 215.
export const STEP_NOT_LAUNCHED_EXIT = 215

// Types only, so erased at compile time: the runner stays self-contained.
type Loose = any
type ClientRequire = (id: string) => Loose

// Run in the job container as `node step-client.js start|supervise|follow|signal|status
// <dir> ...`. Serialized with toString() like stepClient (see step-transfer.ts), with the
// same rules: no imports, no module-level names, nothing TypeScript compiles into a helper
// for ES5. Settings for `start` and `supervise` come from the env: HOOK_RUN_COMMAND (the
// step's shell command), HOOK_RUN_URL and HOOK_RUN_TOKEN (the step server),
// HOOK_RUN_ORPHAN_SECONDS and HOOK_RUN_OUTPUT_LIMIT_MB. The step's command gets the env
// without the HOOK_RUN_* variables.
export function stepRunner(
  load: ClientRequire,
  args: string[],
  env: Record<string, string | undefined>,
  exit: (code: number) => void
): void {
  const fs = load('fs')
  const childProcess = load('child_process')
  const httpModule = load('http')
  const signalNumbers = load('os').constants.signals
  const mode = args[0]
  const dir = args[1]
  // Same values as STEP_CLIENT_FAILED_EXIT and STEP_NOT_LAUNCHED_EXIT; literal here
  // because this function cannot import them (a test checks they match).
  const CLIENT_FAILED_EXIT = 213
  const NOT_LAUNCHED_EXIT = 215
  const PREFIX = '[custom-hook] '
  // Between SIGTERM and SIGKILL when the supervisor stops a step.
  const STOP_GRACE_MS = 3000
  // How long `start` waits for its supervisor, and `follow` for any supervisor.
  const SUPERVISOR_START_MS = 10000
  const FOLLOW_START_MS = 15000
  // What stands in `pid` when no supervisor will ever run the step.
  const NO_SUPERVISOR = '0 none'

  function file(d: string, name: string): string {
    return d + '/' + name
  }

  // Only for a client that is about to exit without a step to read: anything printed here
  // is counted by the hook as step output (see `stderr` in the file list above).
  function note(message: string): void {
    process.stderr.write(PREFIX + message + '\n')
  }

  // A message about the step, where the hook's byte offsets expect it.
  function say(message: string): void {
    try {
      fs.appendFileSync(file(dir, 'stderr'), PREFIX + message + '\n')
    } catch {
      // the directory is gone; so is whoever would read it
    }
  }

  // State, start time and process group of a process, from /proc/<pid>/stat, or null if
  // there is none.
  function processInfo(
    pid: number
  ): { state: string; start: string; group: string } | null {
    if (!(pid > 0)) {
      return null
    }
    let stat: string
    try {
      stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
    } catch {
      return null
    }
    // The command name, in parentheses, may contain spaces; the fields after it do not.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { state: fields[0], start: fields[19], group: fields[2] }
  }

  function processRecord(pid: number): string {
    const info = processInfo(pid)
    return pid + ' ' + (info ? info.start : '')
  }

  function readRecord(path: string): { pid: number; start: string } | null {
    let text: string
    try {
      text = fs.readFileSync(path, 'utf8')
    } catch {
      return null
    }
    const parts = text.trim().split(' ')
    if (!parts[0]) {
      return null
    }
    return { pid: Number(parts[0]), start: parts[1] || '' }
  }

  // The recorded process still runs: same PID and start time (not a reused PID), and not a
  // zombie (the job container's PID 1, `tail`, never reaps the orphans it inherits).
  function recordedAlive(path: string): boolean {
    const record = readRecord(path)
    if (!record) {
      return false
    }
    const info = processInfo(record.pid)
    return (
      !!info &&
      info.start === record.start &&
      info.state !== 'Z' &&
      info.state !== 'X'
    )
  }

  // Any process of the group still runs. The group can outlive its leader, and a zombie
  // still answers kill(-group, 0), so this reads /proc.
  function groupAlive(group: number): boolean {
    let names: string[]
    try {
      names = fs.readdirSync('/proc')
    } catch {
      return false
    }
    return names.some(name => {
      const info = processInfo(Number(name))
      return (
        !!info &&
        info.group === String(group) &&
        info.state !== 'Z' &&
        info.state !== 'X'
      )
    })
  }

  // Signals the process group recorded in <d>/pgid. Returns whether any process got it.
  // The group may outlive its leader (a child that ignored the signal), so a dead leader
  // does not stop the signal, but a leader PID now used by another process does.
  function signalRecordedGroup(d: string, signal: string): boolean {
    const record = readRecord(file(d, 'pgid'))
    if (!record || !(record.pid > 0)) {
      return false
    }
    const info = processInfo(record.pid)
    if (info && info.start !== record.start) {
      return false
    }
    try {
      process.kill(-record.pid, signal)
      return true
    } catch {
      return false
    }
  }

  function exists(path: string): boolean {
    return fs.existsSync(path)
  }

  function remove(path: string): void {
    try {
      fs.rmSync(path, { recursive: true, force: true })
    } catch {
      // left for the job pod's deletion
    }
  }

  // Creates path with content unless it exists; returns whether this call created it. A
  // hard link, so the file appears with its content: nobody reads it half written.
  function claim(path: string, content: string): boolean {
    const temp = path + '.' + process.pid + '.tmp'
    try {
      fs.writeFileSync(temp, content)
      fs.linkSync(temp, path)
      return true
    } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') {
        return false
      }
      // A filesystem without hard links: an exclusive create, then the content.
      try {
        const fd = fs.openSync(path, 'wx')
        fs.writeSync(fd, content)
        fs.closeSync(fd)
        return true
      } catch {
        return false
      }
    } finally {
      try {
        fs.unlinkSync(temp)
      } catch {
        // never written
      }
    }
  }

  // Not this process's to act on: a step running `pkill node` must take down neither the
  // supervisor nor the reader (the hook would take the reader's 143 for the step's exit
  // code). The step's own group gets signals through its process group; containerd ends a
  // reader with SIGKILL.
  let signalsIgnored = false
  function ignoreSignals(): void {
    if (signalsIgnored) {
      return
    }
    signalsIgnored = true
    ;['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(signal => {
      process.on(signal, () => undefined)
    })
  }

  // Before a step starts: a step directory without `exit` belongs to an earlier step whose
  // hook was killed before its step finished. Its processes are killed, so steps never
  // overlap. A finished step is left alone, with anything it started in the background on
  // purpose (`nohup server &` for a later step). Every other step directory is removed.
  // Calls done with the number of steps it stopped.
  function barrier(done: (stopped: number) => void): void {
    const root = dir.slice(0, dir.lastIndexOf('/'))
    let names: string[] = []
    try {
      names = fs.readdirSync(root)
    } catch {
      done(0)
      return
    }
    const waiting: { dir: string; group: number }[] = []
    names.forEach(name => {
      const other = root + '/' + name
      if (other === dir) {
        return
      }
      const record = readRecord(file(other, 'pgid'))
      if (
        record &&
        !exists(file(other, 'exit')) &&
        signalRecordedGroup(other, 'SIGKILL')
      ) {
        waiting.push({ dir: other, group: record.pid })
      } else {
        remove(other)
      }
    })
    const deadline = Date.now() + 5000
    function check(): void {
      const left = waiting.filter(
        other => groupAlive(other.group) && Date.now() < deadline
      )
      if (left.length) {
        setTimeout(check, 50)
        return
      }
      waiting.forEach(other => remove(other.dir))
      done(waiting.length)
    }
    check()
  }

  function supervise(): void {
    // One supervisor per step directory, whoever started it: a launch the hook repeats,
    // because it could not tell whether the first one ran, never runs the step twice.
    if (!claim(file(dir, 'pid'), processRecord(process.pid))) {
      exit(0)
      return
    }
    ignoreSignals()
    const out = fs.openSync(file(dir, 'stdout'), 'a')
    const err = fs.openSync(file(dir, 'stderr'), 'a')
    const childEnv: Record<string, string | undefined> = {}
    for (const key in env) {
      if (!key.startsWith('HOOK_RUN_')) {
        childEnv[key] = env[key]
      }
    }
    let finished = false
    function record(code: number, signal: string | null): void {
      if (finished) {
        return
      }
      finished = true
      clearInterval(timer)
      try {
        if (signal) {
          say('the step was ended by ' + signal)
        }
        fs.writeFileSync(
          file(dir, 'exit.tmp'),
          signal ? code + ' ' + signal : String(code)
        )
        fs.renameSync(file(dir, 'exit.tmp'), file(dir, 'exit'))
      } catch {
        // the directory is gone (a later step's barrier removed it)
      }
      exit(0)
    }
    // detached: the step's shell gets its own session and process group, so the group can
    // be signalled without the supervisor.
    const child = childProcess.spawn(
      'sh',
      ['-c', env.HOOK_RUN_COMMAND || 'false'],
      {
        detached: true,
        stdio: ['ignore', out, err],
        env: childEnv
      }
    )
    fs.closeSync(out)
    fs.closeSync(err)
    child.on('error', (error: Error) => {
      say('cannot start the step: ' + error.message)
      record(CLIENT_FAILED_EXIT, null)
    })
    if (child.pid) {
      fs.writeFileSync(file(dir, 'pgid'), processRecord(child.pid))
    }

    // The hook's cancel, as the liveness reply carried it.
    let applied = ''
    // The supervisor is stopping the step itself (see stop); while the SIGKILL is still to
    // come, the exit code is not recorded, so the supervisor stays to send it.
    let stopping = false
    let killPending = false
    let ended: { code: number; signal: string | null } | null = null
    function signalGroup(signal: string): void {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
        } catch {
          // the group is gone
        }
      }
    }
    child.on('exit', (code: number | null, signal: string | null) => {
      ended = {
        code: signal
          ? 128 + (signalNumbers[signal] || 0)
          : code === null
            ? 1
            : code,
        signal
      }
      // A cancelled step leaves nothing behind: its background children (started with
      // SIGINT ignored by a non-interactive shell) go with it.
      if (applied || exists(file(dir, 'interrupted'))) {
        signalGroup('SIGKILL')
      }
      if (!killPending) {
        record(ended.code, ended.signal)
      }
    })

    // SIGTERM to the step's group, SIGKILL after the grace period. The step's shell usually
    // dies at the SIGTERM; what it started may not, so the SIGKILL is sent whatever has
    // exited by then, and only after it is the exit code recorded.
    function stop(message: string): void {
      if (stopping || finished) {
        return
      }
      stopping = true
      killPending = true
      say(message)
      signalGroup('SIGTERM')
      setTimeout(() => {
        killPending = false
        signalGroup('SIGKILL')
        if (ended) {
          record(ended.code, ended.signal)
        }
      }, STOP_GRACE_MS)
    }

    const limitMb = Number(env.HOOK_RUN_OUTPUT_LIMIT_MB) || 0
    function checkOutput(): void {
      if (!limitMb) {
        return
      }
      let size = 0
      try {
        size =
          fs.statSync(file(dir, 'stdout')).size +
          fs.statSync(file(dir, 'stderr')).size
      } catch {
        return
      }
      if (size > limitMb * 1048576) {
        stop(
          'the step wrote more than ' +
            limitMb +
            ' MiB of output (HOOK_STEP_OUTPUT_LIMIT_MB on the runner); stopping the step'
        )
      }
    }

    // One poll a second, so this many failed polls in a row. Counted, not timed: a
    // supervisor that did not run for a while (a starved or frozen container), or a clock
    // that jumped, has no failed polls to show.
    const orphanPolls = Number(env.HOOK_RUN_ORPHAN_SECONDS) || 15
    let misses = 0
    function poll(): void {
      checkOutput()
      let settled = false
      function answered(ok: boolean, body: string): void {
        if (settled) {
          return
        }
        settled = true
        if (!ok) {
          misses++
          if (misses >= orphanPolls && !recordedAlive(file(dir, 'follower'))) {
            stop(
              'the runner has not answered ' +
                misses +
                ' liveness checks in a row and nothing is reading the output of the ' +
                'step (its hook process or pod is gone); stopping the step'
            )
          }
          return
        }
        misses = 0
        // One SIGINT for the group, whichever way it comes (see `signal`): a second one
        // makes some tools quit without cleaning up.
        if (body === 'SIGINT' && !applied) {
          applied = body
          if (claim(file(dir, 'interrupted'), '')) {
            signalGroup(body)
          }
        } else if (body === 'SIGKILL' && applied !== body) {
          applied = body
          signalGroup(body)
        }
      }
      const request = httpModule.request(
        env.HOOK_RUN_URL + '/alive',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + env.HOOK_RUN_TOKEN },
          timeout: 2000
        },
        (response: Loose) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            body += chunk
          })
          response.on('end', () => {
            answered(
              response.statusCode === 200 || response.statusCode === 204,
              body
            )
          })
          response.on('close', () => answered(false, ''))
        }
      )
      request.on('timeout', () => request.destroy(new Error('timeout')))
      request.on('error', () => answered(false, ''))
      request.end()
    }
    const timer = setInterval(poll, 1000)
  }

  // Prints the step's output from the given offsets until its exit code is recorded, then
  // calls done with it.
  function follow(offsets: number[], done: (code: number) => void): void {
    ignoreSignals()
    if (!exists(dir)) {
      done(NOT_LAUNCHED_EXIT)
      return
    }
    const names = ['stdout', 'stderr']
    const outputs = [process.stdout, process.stderr]
    const fds: number[] = []
    const buffer = Buffer.alloc(65536)
    let checkedAt = Date.now()

    // Copies one file from its offset to its end; then(copied anything).
    function pump(index: number, then: (copied: boolean) => void): void {
      const n = fs.readSync(
        fds[index],
        buffer,
        0,
        buffer.length,
        offsets[index]
      )
      if (n <= 0) {
        then(false)
        return
      }
      offsets[index] += n
      outputs[index].write(Buffer.from(buffer.subarray(0, n)), () => {
        pump(index, () => then(true))
      })
    }

    function finish(): void {
      const code = Number(
        String(fs.readFileSync(file(dir, 'exit'), 'utf8'))
          .trim()
          .split(' ')[0]
      )
      done(code >= 0 && code <= 255 ? code : 1)
    }

    function lost(): void {
      signalRecordedGroup(dir, 'SIGKILL')
      say(
        'the step supervisor exited without recording an exit code; the step was stopped'
      )
      pump(1, () => done(1))
    }

    function loop(): void {
      // Checked before reading: once it exists, everything the step wrote is in the files.
      const finished = exists(file(dir, 'exit'))
      pump(0, copiedOut => {
        pump(1, copiedErr => {
          if (finished) {
            finish()
            return
          }
          if (copiedOut || copiedErr) {
            setImmediate(loop)
            return
          }
          // A quiet step and a dead supervisor look the same, so check the supervisor.
          if (Date.now() - checkedAt >= 1000) {
            checkedAt = Date.now()
            if (
              !recordedAlive(file(dir, 'pid')) &&
              !exists(file(dir, 'exit'))
            ) {
              lost()
              return
            }
          }
          setTimeout(loop, 100)
        })
      })
    }

    function read(): void {
      try {
        names.forEach(name => {
          fds.push(fs.openSync(file(dir, name), 'r'))
        })
        // What tells the supervisor that the hook still reads the step (see the top).
        fs.writeFileSync(file(dir, 'follower'), processRecord(process.pid))
      } catch (error) {
        note('cannot read the output of the step: ' + (error as Error).message)
        done(1)
        return
      }
      loop()
    }

    // The directory exists before its supervisor does: wait for one. If none comes, the
    // launch died in between; `pid` is then taken here, so a supervisor that turns up
    // late does not run the step after the hook has gone on without it.
    const waitUntil = Date.now() + FOLLOW_START_MS
    function ready(): void {
      if (readRecord(file(dir, 'pid'))) {
        read()
        return
      }
      if (Date.now() < waitUntil) {
        setTimeout(ready, 50)
        return
      }
      if (claim(file(dir, 'pid'), NO_SUPERVISOR)) {
        note('the step was never started: its launch was interrupted')
        done(CLIENT_FAILED_EXIT)
        return
      }
      read()
    }
    ready()
  }

  function start(): void {
    ignoreSignals()
    barrier(stopped => {
      let supervisor: Loose
      try {
        fs.mkdirSync(dir, { recursive: true })
        // Appending: a repeated launch must not truncate what the first one's step wrote.
        fs.closeSync(fs.openSync(file(dir, 'stdout'), 'a'))
        const err = fs.openSync(file(dir, 'stderr'), 'a')
        if (stopped) {
          say(
            'stopped the processes of an earlier step that did not finish (its hook was interrupted)'
          )
        }
        // Its own session (detached), so it outlives this exec session; its stderr goes
        // to the step's, so its own errors reach the job log.
        supervisor = childProcess.spawn(
          process.execPath,
          [process.argv[1], 'supervise', dir],
          { detached: true, stdio: ['ignore', 'ignore', err], env }
        )
        fs.closeSync(err)
      } catch (error) {
        note('cannot start the step: ' + (error as Error).message)
        exit(CLIENT_FAILED_EXIT)
        return
      }
      let supervisorExited = false
      supervisor.on('exit', () => {
        supervisorExited = true
      })
      supervisor.on('error', () => {
        supervisorExited = true
      })
      const deadline = Date.now() + SUPERVISOR_START_MS
      function started(): void {
        // This launch's supervisor, or another launch's: either way the step has one.
        if (readRecord(file(dir, 'pid'))) {
          follow([0, 0], code => {
            // Wait for the supervisor to exit, so it is reaped here and not left a zombie
            // under the job container's PID 1.
            const reapDeadline = Date.now() + 2000
            function reaped(): void {
              if (supervisorExited || Date.now() >= reapDeadline) {
                exit(code)
                return
              }
              setTimeout(reaped, 20)
            }
            reaped()
          })
          return
        }
        if (supervisorExited || Date.now() >= deadline) {
          try {
            supervisor.kill('SIGKILL')
          } catch {
            // gone already
          }
          // The hook runs the step another way after this exit code, so a supervisor that
          // is only slow must find `pid` taken. If one took it first, the step has started.
          if (
            !claim(file(dir, 'pid'), NO_SUPERVISOR) &&
            readRecord(file(dir, 'pid'))
          ) {
            started()
            return
          }
          process.stderr.write(
            String(fs.readFileSync(file(dir, 'stderr'), 'utf8'))
          )
          note('the step supervisor did not start')
          exit(CLIENT_FAILED_EXIT)
          return
        }
        setTimeout(started, 10)
      }
      started()
    })
  }

  function sendSignal(name: string): void {
    // Before the step's group exists there is nothing to signal, and `interrupted` must
    // stay free for the supervisor, which will send the SIGINT from its next poll.
    if (!readRecord(file(dir, 'pgid'))) {
      exit(1)
      return
    }
    if (name === 'SIGINT' && !claim(file(dir, 'interrupted'), '')) {
      exit(0)
      return
    }
    exit(signalRecordedGroup(dir, name) ? 0 : 1)
  }

  function status(): void {
    // Read before `exit`: a supervisor that is gone has recorded all it ever will.
    const alive = recordedAlive(file(dir, 'pid'))
    let text = alive ? 'running' : 'gone'
    try {
      text = 'exit ' + String(fs.readFileSync(file(dir, 'exit'), 'utf8')).trim()
    } catch {
      // not recorded
    }
    process.stdout.write(text + '\n', () => exit(0))
  }

  if (mode === 'start' && dir) {
    start()
  } else if (mode === 'supervise' && dir) {
    supervise()
  } else if (mode === 'follow' && dir) {
    follow([Number(args[2]) || 0, Number(args[3]) || 0], exit)
  } else if (mode === 'signal' && dir) {
    sendSignal(args[2])
  } else if (mode === 'status' && dir) {
    status()
  } else {
    note(
      'usage: step-client.js start|supervise|follow|signal|status <dir> [offsets|signal]'
    )
    exit(2)
  }
}

// Shell lines that set $hook_node, or exit `missingExit` when the externals have none.
export function nodeLines(externals: string, missingExit: number): string[] {
  return [
    'hook_musl=',
    'for f in /lib/ld-musl-*; do [ -e "$f" ] && hook_musl=_alpine; done',
    `hook_node=${shlex.quote(externals)}/node24$hook_musl/bin/node`,
    `[ -x "$hook_node" ] || exit ${missingExit}`
  ]
}

export interface RunnerOptions {
  // The runner's externals as the job container sees them.
  externals: string
  missingNodeExit: number
  client: string
  dir: string
}

export interface LaunchOptions extends RunnerOptions {
  // The step's own command (stepCommand), run by the supervisor.
  command: string
  url: string
  token: string
  orphanSeconds: number
  outputLimitMb: number
}

// The command of the step's exec session: start the supervisor and follow the output.
export function stepLaunchCommand(options: LaunchOptions): string {
  const q = shlex.quote
  return [
    ...nodeLines(options.externals, options.missingNodeExit),
    `HOOK_RUN_COMMAND=${q(options.command)} HOOK_RUN_URL=${q(options.url)} ` +
      `HOOK_RUN_TOKEN=${q(options.token)} HOOK_RUN_ORPHAN_SECONDS=${options.orphanSeconds} ` +
      `HOOK_RUN_OUTPUT_LIMIT_MB=${options.outputLimitMb} ` +
      `exec "$hook_node" ${q(options.client)} start ${q(options.dir)}`
  ].join('\n')
}

// The command that resumes reading the output after a dropped connection.
export function stepFollowCommand(
  options: RunnerOptions,
  stdoutOffset: number,
  stderrOffset: number
): string {
  const q = shlex.quote
  return [
    ...nodeLines(options.externals, options.missingNodeExit),
    `exec "$hook_node" ${q(options.client)} follow ${q(options.dir)} ${stdoutOffset} ${stderrOffset}`
  ].join('\n')
}

// The command that sends a signal to the step's process group (the hook's cancel).
export function stepSignalCommand(
  options: RunnerOptions,
  signal: 'SIGINT' | 'SIGKILL'
): string {
  const q = shlex.quote
  return [
    ...nodeLines(options.externals, options.missingNodeExit),
    `exec "$hook_node" ${q(options.client)} signal ${q(options.dir)} ${signal}`
  ].join('\n')
}

// The command that prints whether the step has recorded an exit code (see `status`).
export function stepStatusCommand(options: RunnerOptions): string {
  const q = shlex.quote
  return [
    ...nodeLines(options.externals, options.missingNodeExit),
    `exec "$hook_node" ${q(options.client)} status ${q(options.dir)}`
  ].join('\n')
}
