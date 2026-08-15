import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Outside a repository every git call fails, and `changed` printed the empty result as
 * "No changes against HEAD — nothing to verify" — proof reporting that it could not look
 * as though it had looked and found nothing.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: process.env })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const project = ({ git: useGit }) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-norepo-'))
  mkdirSync(join(dir, '.proof'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: t\n    run: "true"\n')
  writeFileSync(join(dir, 'src/a.js'), 'export const x = () => process.env.API_KEY\n')
  if (useGit) {
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
    g('init', '-q', '-b', 'main', '.')
    g('config', 'user.email', 't@t.t')
    g('config', 'user.name', 't')
  }
  return dir
}

test('changed refuses outside a repository instead of reporting nothing to verify', () => {
  const dir = project({ git: false })
  const r = proof(dir, 'changed')

  assert.equal(r.code, 2, r.out)
  assert.match(r.out, /not a git repository/)
  assert.doesNotMatch(r.out, /nothing to verify/, 'the reassuring line is the bug')
})

test('and says so in JSON, with the code', () => {
  const dir = project({ git: false })
  const r = proof(dir, 'changed', '--json')

  assert.equal(r.code, 2)
  assert.equal(JSON.parse(r.stdout).code, 'ENOREPO')
})

test('but infer still works there — it falls back to scanning the tree', () => {
  const dir = project({ git: false })
  const r = proof(dir, 'infer', '--json')

  assert.equal(r.code, 0, r.out)
  const titles = JSON.parse(r.stdout).gaps.map(g => g.title)
  assert.ok(titles.some(t => t.includes('API_KEY')), `gaps: ${titles}`)
})

test('and check still works there', () => {
  const dir = project({ git: false })
  assert.equal(proof(dir, 'check').code, 0)
})

test('a repository with no commits yet is a legitimate state, not a refusal', () => {
  const dir = project({ git: true })
  const r = proof(dir, 'changed')

  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /src\/a\.js/, 'untracked files are the change')
})
