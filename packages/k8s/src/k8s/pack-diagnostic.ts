// TEMPORARY diagnostic, to be reverted: why packing _work is slow on the runner pod.
import { spawn } from 'child_process'
import * as fs from 'fs'
import { Writable } from 'stream'
import { pipeline } from 'stream/promises'
import tar from 'tar-fs'
import { hookInfo } from './hook-log'

function cgroupStats(): Record<string, number> {
  const out: Record<string, number> = {}
  const read = (file: string): string => {
    try {
      return fs.readFileSync(`/sys/fs/cgroup/${file}`, 'utf8')
    } catch {
      return ''
    }
  }
  for (const line of read('io.stat').split('\n')) {
    const re = /(rbytes|rios)=(\d+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      out[m[1]] = (out[m[1]] ?? 0) + Number(m[2])
    }
  }
  for (const line of read('memory.stat').split('\n')) {
    const [k, v] = line.split(' ')
    if (
      [
        'file',
        'anon',
        'pgmajfault',
        'workingset_refault_file',
        'pgscan',
        'pgsteal'
      ].includes(k)
    ) {
      out[k] = Number(v)
    }
  }
  for (const line of read('cpu.stat').split('\n')) {
    const [k, v] = line.split(' ')
    if (['usage_usec', 'nr_throttled', 'throttled_usec'].includes(k)) {
      out[k] = Number(v)
    }
  }
  out['memory.current'] = Number(read('memory.current').trim() || 0)
  out['memory.max'] = Number(read('memory.max').trim()) || -1
  return out
}

function sink(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb()
    }
  })
}

async function timed(label: string, run: () => Promise<void>): Promise<void> {
  const before = cgroupStats()
  const started = Date.now()
  await run()
  const ms = Date.now() - started
  const after = cgroupStats()
  const delta = Object.keys(after)
    .filter(k => !k.startsWith('memory.'))
    .map(k => `${k}+${after[k] - (before[k] ?? 0)}`)
    .join(' ')
  hookInfo(
    `DIAG ${label}: ${ms} ms; ${delta}; memory.current ${after['memory.current']} max ${after['memory.max']}`
  )
}

export async function packDiagnostic(root: string): Promise<void> {
  try {
    const entries = fs.readdirSync(root)
    await timed('tar-fs #1', async () =>
      pipeline(tar.pack(root, { entries, umask: 0 }), sink())
    )
    await timed(
      'gnu tar',
      async () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn('sh', ['-c', `tar cf - -C '${root}' . | wc -c`], {
            stdio: ['ignore', 'ignore', 'inherit']
          })
          child.on('error', reject)
          child.on('close', () => resolve())
        })
    )
    await timed('tar-fs #2', async () =>
      pipeline(tar.pack(root, { entries, umask: 0 }), sink())
    )
    await timed(
      'find stat',
      async () =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            'sh',
            ['-c', `find '${root}' -type f -exec stat -c %s {} + | wc -l`],
            {
              stdio: ['ignore', 'ignore', 'inherit']
            }
          )
          child.on('error', reject)
          child.on('close', () => resolve())
        })
    )
    hookInfo(
      `DIAG node ${process.version}, uv threadpool ${process.env.UV_THREADPOOL_SIZE ?? 'default'}`
    )
  } catch (error) {
    hookInfo(`DIAG failed: ${error}`)
  }
}
