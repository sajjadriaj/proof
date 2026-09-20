import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classify, failedPreconditions } from '../src/falsify.js'

/**
 * A base commit that never reached the state the contract asserts against proves nothing, and
 * must not be reported as proof.
 *
 * This is the worst answer `proof falsify` can give. Falsification is the one step whose whole
 * job is to stop somebody fooling themselves — so a confident DISCRIMINATES on a run that
 * measured nothing is worse than no verdict at all. Two real contracts hit it: one reported
 * "18 of 18 check(s) fail without your change" when its fixture had exited 1 and the other
 * seventeen had failed with `no value for ${api_key}`.
 *
 * The tell is structural rather than textual. A contract's opening checks are usually not
 * claims: they sign somebody in, seed a row, and hand an id to everything below. A check that
 * captures a variable another check uses is a precondition, and its failure is a statement
 * about the harness, not about the change.
 */
const CRITERIA = [{ id: 'AC1', requirement: 'the thing works' }]

const SPEC = {
  goal: 'g',
  criteria: CRITERIA,
  checks: [
    { name: 'the fixture exists', run: 'npx tsx fixture.ts', capture: { api_key: 'match:KEY=(\\S+)' } },
    {
      name: 'the thing works',
      satisfies: ['AC1'],
      http: { path: '/a', headers: { authorization: 'Bearer ${api_key}' } },
    },
  ],
}

const CONTEXT = { spec: SPEC, base: 'HEAD', from: 'working tree', commit: 'abcdef1234567890' }

test('a failed precondition is named', () => {
  const results = [
    { name: 'the fixture exists', kind: 'run', status: 'failed' },
    { name: 'the thing works', kind: 'http', status: 'failed' },
  ]
  assert.deepEqual(failedPreconditions(SPEC, results), ['the fixture exists'])
})

test('a check nothing captures from is not a precondition', () => {
  // It failed, and it is a claim — exactly the failure falsification is looking for.
  const results = [
    { name: 'the fixture exists', kind: 'run', status: 'passed' },
    { name: 'the thing works', kind: 'http', status: 'failed' },
  ]
  assert.deepEqual(failedPreconditions(SPEC, results), [])
})

test('a dead base is INCONCLUSIVE, not DISCRIMINATES', () => {
  const out = classify({
    results: [
      { name: 'the fixture exists', kind: 'run', status: 'failed', observed: 'exit 1' },
      {
        name: 'the thing works',
        kind: 'http',
        status: 'failed',
        observed: 'no value for ${api_key} — `api_key` is captured by "the fixture exists", which did not run or did not pass',
      },
    ],
  }, CONTEXT)

  assert.equal(out.status, 'inconclusive')
  assert.match(out.reason, /the fixture exists failed on abcdef123456/)
  // And it says what to do about it, because "inconclusive" without a next step just moves the
  // guessing somewhere else.
  assert.match(out.reason, /runs on both commits/)
})

test('a real failure still discriminates', () => {
  // The positive control. A rule that turned every run inconclusive would satisfy the test
  // above and destroy the command.
  const out = classify({
    results: [
      { name: 'the fixture exists', kind: 'run', status: 'passed' },
      { name: 'the thing works', kind: 'http', status: 'failed', observed: 'status 404' },
    ],
  }, CONTEXT)

  assert.equal(out.status, 'discriminates')
  assert.deepEqual(out.discriminating, ['the thing works'])
})

test('a contract with no captures is unaffected', () => {
  const spec = {
    goal: 'g',
    criteria: CRITERIA,
    checks: [{ name: 'the thing works', satisfies: ['AC1'], http: { path: '/a' } }],
  }
  const out = classify({
    results: [{ name: 'the thing works', kind: 'http', status: 'failed', observed: 'status 404' }],
  }, { ...CONTEXT, spec })

  assert.equal(out.status, 'discriminates')
})

test('a captured value nobody uses does not make its check a precondition', () => {
  // Captured and never referenced: the check is still a claim, and its failure is still the
  // answer falsification came for.
  const spec = {
    goal: 'g',
    criteria: CRITERIA,
    checks: [
      { name: 'the thing works', satisfies: ['AC1'], run: 'x', capture: { unused: 'match:(.*)' } },
    ],
  }
  const out = classify({
    results: [{ name: 'the thing works', kind: 'run', status: 'failed', observed: 'exit 1' }],
  }, { ...CONTEXT, spec })

  assert.equal(out.status, 'discriminates')
})

test('a check that never ran is not evidence, even without the precondition rule', () => {
  // Belt and braces. `failedPreconditions` catches the shape where the producing check is in
  // the contract; this catches any check that reports it never ran, whatever the reason. A
  // measurement that did not happen is not a measurement that disagreed.
  const spec = {
    goal: 'g',
    criteria: CRITERIA,
    checks: [{ name: 'the thing works', satisfies: ['AC1'], http: { path: '/a' } }],
  }
  const out = classify({
    results: [{ name: 'the thing works', kind: 'http', status: 'failed', unmet: true, observed: 'no value for ${x}' }],
  }, { ...CONTEXT, spec })

  assert.equal(out.status, 'inconclusive')
  assert.deepEqual(out.discriminating, [])
})
