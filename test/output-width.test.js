import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TERMINAL_WIDTH, block } from '../src/terminal.js'

const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return r.stdout + r.stderr
}

/**
 * A project whose every value is long: the goal, the check names, the routes, the env vars.
 * Anything that interpolates one of these into a line has to bound it.
 */
const wideProject = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-width-'))
  git(dir, 'init', '-q', '-b', 'main', '.')
  git(dir, 'config', 'user.email', 't@t.t')
  git(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, '.proof'), { recursive: true })

  writeFileSync(join(dir, 'src/base.ts'), 'export const base = 1\n')
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: verify that customers can complete checkout with a saved card and a coupon while the '
    + 'inventory service is degraded and the audit log stays consistent\n'
    + 'checks:\n'
    + '  - name: a check whose name is long enough on its own to fill most of a terminal line\n'
    + '    run: echo ok\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')

  // a diff, so `changed` and `infer` have something to say
  writeFileSync(join(dir, 'src/routes.ts'),
    "app.post('/api/v2/organisations/:organisationId/workspaces/:workspaceId/projects/:projectId"
    + "/settings/notifications/email', handler)\n"
    + 'const key = process.env.A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_THAT_KEEPS_GOING_AND_GOING\n')
  return dir
}

const overlong = out => out.split('\n').filter(l => l.length > TERMINAL_WIDTH)

// `check` and `report` are covered by their own width tests; these are the commands whose
// prose lines were still being printed unwrapped.
for (const args of [['changed'], ['infer'], ['check'], ['report', '--list']]) {
  test(`proof ${args.join(' ')} keeps every line within the terminal width`, () => {
    const dir = wideProject()
    proof(dir, 'check')

    const out = proof(dir, ...args)
    assert.deepEqual(overlong(out), [], `overlong line(s) from proof ${args.join(' ')}`)
  })
}

test('the regression: a degraded-scan warning wraps instead of running off the line', () => {
  const dir = wideProject()
  // An unreadable file produces the longest warning proof emits.
  writeFileSync(join(dir, 'src/unreadable.ts'), 'x\n')
  execFileSync('chmod', ['000', join(dir, 'src/unreadable.ts')])

  try {
    const out = proof(dir, 'changed')
    assert.deepEqual(overlong(out), [])
    assert.match(out.replace(/\s+/g, ' '), /could not be read/)
  } finally {
    execFileSync('chmod', ['644', join(dir, 'src/unreadable.ts')])
  }
})

test('the regression: a gap note wraps under a hanging indent', () => {
  // Notes are short today, so no CLI output exercises this — assert the rendering itself
  // rather than a wrap that does not currently happen.
  const note = 'not declared in .env.example, .env.sample, .env.template, .env.local, .env.production '
    + 'or any other env file this project carries'
  const rendered = block(note, ' '.repeat(14)).replace(/^ {14}/, `${' '.repeat(12)}↳ `)
  const lines = rendered.split('\n')

  assert.ok(lines.length > 1, 'the note wrapped')
  assert.match(lines[0], /^ {12}↳ /, 'the arrow marks the first line')
  for (const line of lines.slice(1)) {
    assert.match(line, /^ {14}\S/, `continuation is not aligned under the note: ${JSON.stringify(line)}`)
  }
  for (const line of lines) assert.ok(line.length <= TERMINAL_WIDTH, line)
})

test('a long path is left whole rather than broken across lines', () => {
  // Wrapping prose is right; chopping an identifier a reader needs to copy is not.
  const dir = wideProject()
  const out = proof(dir, 'changed')
  assert.match(out, /src\/routes\.ts/)
})
