import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * The thesis, in the form that costs the most. An agent that relaxes an assertion and edits
 * the code in one diff got `OK — unit tests` on both files and a DONE verdict: the check
 * vouching for the code was running expectations the same diff rewrote.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { exit: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-testschanged-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, '.proof'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, 'src/cart.js'), 'export const total = (a, b) => a + b\n')
  writeFileSync(join(dir, 'test/cart.test.js'), "import {total} from '../src/cart.js'\nif (total(2,2) !== 4) throw new Error('bad')\n")
  // a check that actually names these files, so coverage reads OK — which is the reading
  // the note exists to qualify
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: g\nchecks:\n  - name: unit tests\n    run: node test/cart.test.js\n')
  g('init', '-q', '-b', 'main', '.')
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't')
  g('add', '-A'); g('commit', '-qm', 'base')
  return dir
}

const json = dir => JSON.parse(proof(dir, 'changed', '--json').stdout)

test('an existing test edited alongside the code is called out', () => {
  const dir = project()
  writeFileSync(join(dir, 'src/cart.js'), 'export const total = (a, b) => a * b\n')
  appendFileSync(join(dir, 'test/cart.test.js'), '// relaxed\n')

  const out = json(dir)
  assert.deepEqual(out.tests_changed, ['test/cart.test.js'])
  assert.ok(out.warnings.some(w => /existing test file/.test(w)), JSON.stringify(out.warnings))

  // and the coverage line still says OK — the note is what stops that reading as proof
  assert.match(proof(dir, 'changed').out, /OK {4}src\/cart\.js — unit tests/)
})

test('a test the diff only adds is not counted', () => {
  // a new test cannot weaken existing coverage, and a warning that fires on most good diffs
  // is one people learn to scroll past
  const dir = project()
  writeFileSync(join(dir, 'test/new.test.js'), 'if (1 !== 1) throw new Error("x")\n')

  const out = json(dir)
  assert.deepEqual(out.tests_changed, [])
  assert.ok(!out.warnings.some(w => /existing test file/.test(w)))
})

test('adding one while editing another reports only the edit', () => {
  const dir = project()
  appendFileSync(join(dir, 'test/cart.test.js'), '// relaxed\n')
  writeFileSync(join(dir, 'test/new.test.js'), 'if (1 !== 1) throw new Error("x")\n')

  assert.deepEqual(json(dir).tests_changed, ['test/cart.test.js'])
})

test('a deleted test is the strongest signal and is reported', () => {
  const dir = project()
  rmSync(join(dir, 'test/cart.test.js'))

  assert.deepEqual(json(dir).tests_changed, ['test/cart.test.js'])
})

test('a diff touching no tests says nothing', () => {
  const dir = project()
  appendFileSync(join(dir, 'src/cart.js'), 'export const x = 1\n')

  const out = json(dir)
  assert.deepEqual(out.tests_changed, [])
  assert.ok(!out.warnings.some(w => /existing test file/.test(w)))
})

test('it is a note, not a failure — editing tests is normal', () => {
  const dir = project()
  appendFileSync(join(dir, 'test/cart.test.js'), '// relaxed\n')

  const r = proof(dir, 'changed')
  assert.equal(r.exit, 0)
  assert.match(r.out, /existing test file/, 'the note is there — and the exit code is still 0')
})

/**
 * `changed` reports the blast radius; `check` produces the verdict that gets acted on.
 * "The suite passed" means less when this diff is also what the suite now says.
 */
test('check carries the note too, not just changed', () => {
  const dir = project()
  appendFileSync(join(dir, 'test/cart.test.js'), '// relaxed\n')

  const out = JSON.parse(proof(dir, 'check', '--json').stdout)
  assert.equal(out.status, 'passed', 'a note, not a gate')
  assert.ok(out.warnings.some(w => /existing test file/.test(w)), JSON.stringify(out.warnings))
})

test('and stays quiet in check for an added test', () => {
  const dir = project()
  writeFileSync(join(dir, 'test/new.test.js'), 'if (1 !== 1) throw new Error("x")\n')

  const out = JSON.parse(proof(dir, 'check', '--json').stdout)
  assert.equal(out.status, 'passed', 'the run happened')
  assert.ok(!out.warnings.some(w => /existing test file/.test(w)), JSON.stringify(out.warnings))
})

test('check outside a repository still runs', () => {
  // the note needs a diff; not having one must not take the verdict down with it
  const dir = mkdtempSync(join(tmpdir(), 'proof-tc-norepo-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: t\n    run: "true"\n')

  const out = JSON.parse(proof(dir, 'check', '--json').stdout)
  assert.equal(out.status, 'passed')
  assert.ok(!out.warnings.some(w => /existing test file/.test(w)))
})
