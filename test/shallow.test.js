import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * `actions/checkout` clones with fetch-depth: 1, so `merge-base` finds nothing and forkPoint
 * falls back to the tip of base — reintroducing the misattribution it exists to prevent, in
 * the setup most CI uses. `changed` listed a file the branch never touched; `infer --write`
 * would have appended checks for it.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: process.env })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

// a branch that added one file, plus a commit made on main afterwards
const origin = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-shallow-origin-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  const commit = (name, msg) => {
    writeFileSync(join(dir, name), `export const ${name.replace('.js', '')} = 1\n`)
    g('add', '-A'); g('commit', '-qm', msg)
  }
  g('init', '-q', '-b', 'main', '.')
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't')
  commit('base.js', 'c1')
  g('checkout', '-qb', 'feature')
  commit('feature.js', 'c2')          // the branch's only work
  g('checkout', '-q', 'main')
  commit('later.js', 'c3')            // main moved on afterwards
  return dir
}

const shallowClone = () => {
  const src = origin()
  const dir = mkdtempSync(join(tmpdir(), 'proof-shallow-clone-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${src}`, dir], { stdio: 'ignore' })
  g('fetch', '-q', '--depth', '1', 'origin', 'main:refs/remotes/origin/main')
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: t\n    run: "true"\n')

  // the premise: git really cannot find the fork point here
  const mb = spawnSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: dir })
  assert.notEqual(mb.status, 0, 'fixture is not actually shallow — the test would prove nothing')
  return dir
}

test('changed says the fork point is unknown instead of misattributing main\'s commits', () => {
  const dir = shallowClone()
  const r = proof(dir, 'changed', '--base', 'origin/main')

  assert.match(r.out, /later\.js/, 'the wrong file is still listed — this is the degraded reading')
  assert.match(r.out, /shallow clone/, 'and it must say why that reading cannot be trusted')
  assert.match(r.out, /fetch-depth: 0|--unshallow/, 'with the fix')
})

test('and carries it in JSON, where CI reads it', () => {
  const dir = shallowClone()
  const out = JSON.parse(proof(dir, 'changed', '--base', 'origin/main', '--json').stdout)

  assert.ok(out.warnings.some(w => /shallow clone/.test(w)), `warnings: ${JSON.stringify(out.warnings)}`)
})

test('infer warns too — --write would append checks for files the branch never touched', () => {
  const dir = shallowClone()
  const out = JSON.parse(proof(dir, 'infer', '--base', 'origin/main', '--json').stdout)

  assert.ok(out.warnings.some(w => /shallow clone/.test(w)), `warnings: ${JSON.stringify(out.warnings)}`)
})

test('a full clone says nothing — the warning must not fire on every branch comparison', () => {
  const src = origin()
  const dir = mkdtempSync(join(tmpdir(), 'proof-full-clone-'))
  execFileSync('git', ['clone', '-q', '--branch', 'feature', `file://${src}`, dir], { stdio: 'ignore' })
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: t\n    run: "true"\n')

  const out = JSON.parse(proof(dir, 'changed', '--base', 'origin/main', '--json').stdout)
  assert.ok(!out.warnings.some(w => /shallow clone/.test(w)), `warnings: ${JSON.stringify(out.warnings)}`)
  assert.deepEqual(out.changed, ['feature.js'], 'and the fork point is found, so later.js is not the branch\'s')
})
