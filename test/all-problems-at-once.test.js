import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * A fresh `init` on a project with no test script, plus `infer --write`, produced a contract
 * needing three edits. `check` showed two, and the third only after both were fixed — while
 * proof knew about all three from the first run.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { exit: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const withSpec = body => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-allproblems-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), body)
  return dir
}

const BOTH = 'goal: g\nchecks:\n'
  + '  - name: tests\n    run: echo "replace me with a real command"\n'
  + '  - name: orders\n    http: {path: "/api/orders/[id]"}\n'

test('an invalid contract also names the placeholder waiting behind it', () => {
  const dir = withSpec(BOTH)
  const r = proof(dir, 'check')

  assert.equal(r.exit, 2)
  assert.match(r.out, /still has the route pattern/, 'the validation problem')
  assert.match(r.out, /Also, once the above are fixed: 1 check\(s\) still hold proof's own placeholder command \(tests\)/)
})

test('but it is not counted as a validation problem', () => {
  // `infer --write` must stay allowed on a contract holding a placeholder, so it is a later
  // refusal, not an invalid contract
  const dir = withSpec(BOTH)
  const out = JSON.parse(proof(dir, 'check', '--json').stdout)

  assert.equal(out.code, 'EBADSPEC')
  assert.deepEqual(out.placeholders, ['tests'])
  assert.ok(!out.problems.some(p => /placeholder/.test(p)), JSON.stringify(out.problems))
})

test('a valid contract with a placeholder still refuses in its own phase', () => {
  const dir = withSpec('goal: g\nchecks:\n  - name: tests\n    run: echo "replace me with a real command"\n')
  const out = JSON.parse(proof(dir, 'check', '--json').stdout)

  assert.equal(out.code, 'EUNFINISHED')
  assert.match(out.error, /still Proof's own placeholder/)
})

test('an invalid contract with no placeholder says nothing extra', () => {
  const dir = withSpec('goal: g\nchecks:\n  - name: orders\n    http: {path: "/api/orders/[id]"}\n')
  const r = proof(dir, 'check')

  assert.match(r.out, /still has the route pattern/, 'it reached validation at all')
  assert.doesNotMatch(r.out, /Also, once the above/)
  assert.equal(JSON.parse(proof(dir, 'check', '--json').stdout).placeholders, undefined)
})

test('the whole handoff needs one pass, not three', () => {
  // fix everything the first `check` reported; the second must run
  const dir = withSpec(BOTH)
  proof(dir, 'check')

  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: g\nchecks:\n  - name: tests\n    run: "true"\n'
    + '  - name: orders\n    http: {url: "http://127.0.0.1:9/x"}\n')

  const out = JSON.parse(proof(dir, 'check', '--json').stdout)
  assert.notEqual(out.code, 'EBADSPEC')
  assert.notEqual(out.code, 'EUNFINISHED')
})

test('infer --write is still allowed on a contract holding a placeholder', () => {
  const dir = withSpec('goal: g\nchecks:\n  - name: tests\n    run: echo "replace me with a real command"\n')
  const before = readFileSync(join(dir, '.proof/spec.yaml'), 'utf8')

  const r = proof(dir, 'infer', '--write')
  assert.equal(r.exit, 0, r.out)
  assert.doesNotMatch(r.out, /placeholder/, 'and it is not refused for the placeholder')
  // exit 0 says it did not refuse; this says the placeholder is still there afterwards
  assert.match(readFileSync(join(dir, '.proof/spec.yaml'), 'utf8'), /replace me with a real command/)
  assert.ok(before.length > 0)
})
