import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { fingerprint } from '../src/git.js'

const repo = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-drift-'))
  process.chdir(dir)
  execFileSync('git', ['init', '-q', '.'], { stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@t.t'], { stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { stdio: 'ignore' })
  writeFileSync('app.js', 'export const version = "1.0.0"\n')
  writeFileSync('.gitignore', 'dist/\n.proof/runs/\n')
  execFileSync('git', ['add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['commit', '-qm', 'init'], { stdio: 'ignore' })
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(contract))
  return dir
}

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const resultOf = dir => JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

test('the regression: an edit during the run is reported, not silently absorbed', async () => {
  const dir = repo({
    goal: 'the app reports version 1.0.0',
    checks: [
      { name: 'version is 1.0.0', file: { path: 'app.js', contains: '1.0.0' } },
      // Not `sed -i`: BSD sed wants an argument to -i and GNU sed refuses one, so the
      // portable spelling of "edit a tracked file" is to rewrite it.
      { name: 'something edits the tree', run: 'printf \'export const version = "9.9.9"\\n\' > app.js' },
    ],
  })

  assert.equal(await quiet(() => check({ json: true })), 0)
  const r = resultOf(dir)

  assert.ok(r.warnings.some(w => /working tree changed while this run was in progress/.test(w)))
  assert.deepEqual(r.git.changed, [], 'git context describes the tree as it was at the start')
})

test('a run that touches nothing tracked reports no drift', async () => {
  const dir = repo({
    goal: 'quiet run',
    checks: [{ name: 'reads only', file: { path: 'app.js', contains: '1.0.0' } }],
  })
  assert.equal(await quiet(() => check({ json: true })), 0)
  assert.deepEqual(resultOf(dir).warnings, [])
})

test('build output in an ignored directory is not mistaken for an edit', async () => {
  const dir = repo({
    goal: 'builds',
    checks: [{ name: 'build', run: 'mkdir -p dist && echo bundle > dist/out.js' }],
  })
  assert.equal(await quiet(() => check({ json: true })), 0)
  assert.deepEqual(resultOf(dir).warnings, [], 'dist/ is gitignored, so it is not tracked drift')
})

test('fingerprint notices content changes, not just which files changed', () => {
  repo({ goal: 'g', checks: [{ name: 'a', run: 'true' }] })

  const clean = fingerprint()
  writeFileSync('app.js', 'export const version = "2.0.0"\n')
  const edited = fingerprint()
  assert.notEqual(clean, edited)

  // same set of changed files, different content — must still differ
  writeFileSync('app.js', 'export const version = "3.0.0"\n')
  assert.notEqual(edited, fingerprint())
})

test('outside a git repository the check is simply absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-nogit-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({ goal: 'g', checks: [{ name: 'a', run: 'true' }] }))

  assert.equal(fingerprint(), null)
  assert.equal(await quiet(() => check({ json: true })), 0)
  assert.deepEqual(resultOf(dir).warnings, [])
})
