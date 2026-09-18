import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSpec } from '../src/validate.js'

// Assertions the contract states and the runner never evaluates. Each of these validated
// clean, ran, and reported PASS with one clause fewer than its author wrote — the exact
// failure mode the strict schema exists to prevent.

const spec = check => ({ goal: 'g', serve: { run: 'x', ready_url: 'http://localhost:3000' }, checks: [check] })
const problemsFor = check => validateSpec(spec(check))

test('expect_output on a non-run check is refused, not ignored', () => {
  for (const [verb, check] of [
    ['http', { name: 'a', http: { path: '/x' }, expect_output: 'ok' }],
    ['file', { name: 'a', file: 'x.txt', expect_output: 'ok' }],
    ['env', { name: 'a', env: 'HOME', expect_output: 'ok' }],
    ['browser', { name: 'a', browser: { visit: '/x' }, expect_output: 'ok' }],
  ]) {
    const problems = problemsFor(check)
    assert.equal(problems.length, 1, `${verb}: ${JSON.stringify(problems)}`)
    assert.match(problems[0], /expect_output: only a `run:` check/)
    // and it says where the assertion does belong for that verb
    assert.match(problems[0], /Assert on the/)
  }
})

test('expect_exit on a non-run check is refused the same way', () => {
  const problems = problemsFor({ name: 'a', http: { path: '/x' }, expect_exit: 0 })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /expect_exit: only a `run:` check/)
})

test('a run check still accepts both', () => {
  assert.deepEqual(problemsFor({ name: 'a', run: 'true', expect_exit: 1, expect_output: 'hi' }), [])
})

test('the regression: `expect: 200` silently became "any status below 400"', () => {
  const problems = problemsFor({ name: 'a', http: { path: '/x', expect: 200 } })
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /http › expect: must be a mapping of assertions/)

  assert.deepEqual(problemsFor({ name: 'a', http: { path: '/x', expect: { status: 200 } } }), [])
})

test('headers that are not a mapping are refused', () => {
  // `{...'abc'}` is `{0: 'a', 1: 'b', 2: 'c'}` — headers nobody wrote, sent as written.
  const problems = problemsFor({ name: 'a', http: { path: '/x', headers: 'authorization: t' } })
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /http › headers: must be a mapping/)

  assert.deepEqual(problemsFor({ name: 'a', http: { path: '/x', headers: { accept: 'text/html' } } }), [])
})

test('a fill step that is not a mapping is refused', () => {
  // Object.entries('a@b.c') enumerates characters, so the step looked for a field called "0".
  const problems = problemsFor({ name: 'a', browser: { visit: '/x', flow: [{ fill: 'a@b.c' }] } })
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /fill: must be a mapping of field to value/)

  assert.deepEqual(problemsFor({ name: 'a', browser: { visit: '/x', flow: [{ fill: { email: 'a@b.c' } }] } }), [])
})

test('a file verb that is neither a path nor a mapping is refused at load', () => {
  // It reached the runner as neither and failed there with `file.path missing` — a contract
  // mistake reported as a failed check.
  const problems = problemsFor({ name: 'a', file: 42 })
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /file: must be a path, or a mapping with a `path`/)

  assert.deepEqual(problemsFor({ name: 'a', file: 'x.txt' }), [])
  assert.deepEqual(problemsFor({ name: 'a', file: { path: 'x.txt' } }), [])
})
