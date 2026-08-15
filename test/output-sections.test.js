import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Several notices can fire at once. Run together they read as one paragraph whose second
 * sentence begins right after the first one's full stop, and `check` printed two separate
 * sections both headed NOTE with an Evidence block between them.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { exit: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

// a diff that trips the contract notice and the tests notice at once, with runs piled up
const noisy = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-sections-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, '.proof'))
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, 'test/a.test.js'), 'ok\n')
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: g\nchecks:\n  - name: unit tests\n    run: "true"\n  - name: old\n    run: "true"\n')
  g('init', '-q', '-b', 'main', '.')
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't')
  g('add', '-A'); g('commit', '-qm', 'base')

  appendFileSync(join(dir, 'test/a.test.js'), 'relaxed\n')
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: unit tests\n    run: "true"\n')

  mkdirSync(join(dir, '.proof/runs'), { recursive: true })
  for (let i = 1; i <= 101; i++) {
    const id = `1${String(i).padStart(4, '0')}`
    mkdirSync(join(dir, '.proof/runs', id))
    writeFileSync(join(dir, '.proof/runs', id, 'result.json'), '{"status":"passed","results":[],"failures":[]}')
  }
  return dir
}

test('check separates the notices instead of running them together', () => {
  const out = proof(noisy(), 'check').out

  assert.match(out, /a check that was removed cannot fail\.\n\n {2}this diff changes 1 existing test file/,
    'a blank line between two distinct facts')
})

test('and prints one NOTE section, not two with Evidence between them', () => {
  const out = proof(noisy(), 'check').out

  assert.equal(out.match(/^NOTE$/gm)?.length, 1, out)
  assert.match(out, /NOTE[\s\S]*have collected[\s\S]*Evidence:/, 'both notes come before Evidence')
})

test('changed renders its notices the same way', () => {
  const out = proof(noisy(), 'changed').out

  assert.equal(out.match(/^NOTE$/gm)?.length, 1, out)
  assert.match(out, /before trusting the verdict\.\n\n {2}this diff also changes the contract/)
})

test('the tests notice does not point at a section that is not there', () => {
  // it said `"covered" below`, which is true in `changed` and describes nothing in `check`
  const dir = noisy()

  assert.doesNotMatch(proof(dir, 'check').out, /below/, 'nothing follows it in check')
  assert.match(proof(dir, 'check').out, /existing test file/, 'and the notice is present')
})

test('a run with one notice still gets a heading and no stray blank line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-sections-one-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')

  const out = proof(dir, 'check').out
  assert.equal(out.match(/^NOTE$/gm)?.length, 1)
  assert.doesNotMatch(out, /NOTE\n\n/)
})
