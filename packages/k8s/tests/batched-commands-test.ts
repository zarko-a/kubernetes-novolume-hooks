import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { listDirAllCommand, mergeTempCommand } from '../src/k8s/utils'

// The shell commands below run for real with the container's `sh` and `find`. Each batched
// command is compared with the per-file command it replaced, on the same files.

function sh(script: string): string {
  return execFileSync('sh', ['-c', script], { encoding: 'utf8' })
}

function sortedLines(output: string): string[] {
  return output
    .split('\n')
    .filter(line => line.length > 0)
    .sort()
}

// Every file under root, as "relative path: content", sorted.
function snapshot(root: string): string[] {
  const entries: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        entries.push(
          `${path.relative(root, full)}: ${fs.readFileSync(full, 'utf8')}`
        )
      }
    }
  }
  walk(root)
  return entries.sort()
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
  }
}

describe('batched shell commands', () => {
  let workspace: string

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'batched-'))
  })

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  describe('listDirAllCommand', () => {
    const PER_FILE = (dir: string): string =>
      `cd '${dir}' && find . -type f -not -path '*/_runner_hook_responses*' -exec stat -c '%s %n' {} \\;`

    it('batches stat with {} +', () => {
      expect(listDirAllCommand('/__w')).toContain("stat -c '%s %n' {} +")
      expect(listDirAllCommand('/__w')).not.toContain('\\;')
    })

    it('lists exactly what the per-file command listed', () => {
      const files: Record<string, string> = {
        'a.txt': 'a',
        'with space/b c.txt': 'bc',
        'deep/er/c.json': '{}',
        '_runner_hook_responses/skip.json': 'skipped',
        'nested/_runner_hook_responses-x/also-skipped': 'x',
        'empty-file': ''
      }
      for (let i = 0; i < 300; i++) {
        files[`many/file-${i}.txt`] = `${i}`
      }
      writeFiles(workspace, files)
      fs.mkdirSync(path.join(workspace, 'empty-dir'))

      const batched = sortedLines(sh(listDirAllCommand(workspace)))
      const perFile = sortedLines(sh(PER_FILE(workspace)))

      expect(batched).toEqual(perFile)
      expect(batched).toHaveLength(304)
      expect(batched).toContain('2 ./with space/b c.txt')
      expect(batched.join('\n')).not.toContain('_runner_hook_responses')
    })
  })

  describe('mergeTempCommand', () => {
    // The merge as upstream wrote it, one `sh` per file, with its paths parameterised.
    const PER_FILE = (src: string, dst: string): string =>
      [
        'set -e',
        `mkdir -p '${dst}' '${src}'`,
        `SRC='${src}'`,
        `DST='${dst}'`,
        'cp -a "$SRC/_runner_file_commands/." "$DST/_runner_file_commands"',
        `find "$SRC" -type f ! -path "*/_runner_file_commands/*" -exec sh -c '
    rel="\${1#$2/}"
    target="$3/$rel"
    mkdir -p "$(dirname "$target")"
    cp -a "$1" "$target"
  ' _ {} "$SRC" "$DST" \\;`,
        `rm -rf '${src}'`
      ].join(' && ')

    function fixture(root: string): { src: string; dst: string } {
      const src = path.join(root, '_temp_pre')
      const dst = path.join(root, '_temp')
      writeFiles(src, {
        '_runner_file_commands/set_output_1': 'new output',
        '_runner_file_commands/set_env_1': 'new env',
        'event.json': '{"new": true}',
        '_github_home/.gitconfig': '[user]',
        'with space/file name.txt': 'spaced',
        'deep/nested/dir/file.sh': 'echo hi'
      })
      for (let i = 0; i < 200; i++) {
        writeFiles(src, { [`many/file-${i}`]: `${i}` })
      }
      writeFiles(dst, {
        '_runner_file_commands/set_output_1': 'old output',
        '_runner_file_commands/old_only': 'kept',
        'event.json': '{"old": true}',
        'dst-only.txt': 'kept too'
      })
      return { src, dst }
    }

    it('batches the per-file sh with {} +', () => {
      const script = mergeTempCommand('/__w/_temp_pre', '/__w/_temp')
      expect(script).toContain('{} +')
      expect(script).not.toContain('\\;')
    })

    it('produces the same _temp as the per-file merge and removes the source', () => {
      const batchedRoot = path.join(workspace, 'batched')
      const perFileRoot = path.join(workspace, 'per-file')
      const batched = fixture(batchedRoot)
      const perFile = fixture(perFileRoot)

      sh(mergeTempCommand(batched.src, batched.dst))
      sh(PER_FILE(perFile.src, perFile.dst))

      expect(snapshot(batched.dst)).toEqual(snapshot(perFile.dst))
      expect(fs.existsSync(batched.src)).toBe(false)

      const merged = snapshot(batched.dst)
      expect(merged).toContain('_runner_file_commands/set_output_1: new output')
      expect(merged).toContain('_runner_file_commands/old_only: kept')
      expect(merged).toContain('event.json: {"new": true}')
      expect(merged).toContain('dst-only.txt: kept too')
      expect(merged).toContain('with space/file name.txt: spaced')
      expect(merged).toContain('many/file-199: 199')
    })

    it('quotes paths with spaces', () => {
      const { src, dst } = fixture(path.join(workspace, 'a dir'))
      sh(mergeTempCommand(src, dst))
      expect(snapshot(dst)).toContain('deep/nested/dir/file.sh: echo hi')
    })
  })
})
