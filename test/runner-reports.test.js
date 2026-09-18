import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseJUnit } from '../src/junit.js'
import { validateSpec } from '../src/validate.js'

// `run: npx playwright test` already worked and told proof one thing: the exit code. Three
// tests failed and the verdict said `exit 1`, so the evidence bundle — what an agent reads to
// decide what to fix — held less than the terminal it was captured from.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const project = files => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-report-'))
  mkdirSync(join(dir, '.proof'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

const REPORT = (body, wrap = true) => (wrap
  ? `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n<testsuite name="s">\n${body}\n</testsuite>\n</testsuites>`
  : `<testsuite name="s">\n${body}\n</testsuite>`)

// --- the parser --------------------------------------------------------------

test('passes, failures, errors and skips are counted apart', () => {
  const r = parseJUnit(REPORT(`
    <testcase name="signs in" classname="auth"/>
    <testcase name="rejects an expired token" classname="auth"><failure message="expected 401, got 200">at auth.spec.ts:14</failure></testcase>
    <testcase name="boots" classname="app"><error message="ECONNREFUSED"/></testcase>
    <testcase name="later" classname="app"><skipped/></testcase>
  `))
  assert.equal(r.tests, 4)
  assert.equal(r.failed, 2)
  assert.equal(r.skipped, 1)
  assert.deepEqual(r.failures, [
    { test: 'auth › rejects an expired token', message: 'expected 401, got 200' },
    { test: 'app › boots', message: 'ECONNREFUSED' },
  ])
})

test('a failure with no message attribute falls back to the body', () => {
  const r = parseJUnit(REPORT('<testcase name="t"><failure>AssertionError: 1 !== 2\nat x.js:3</failure></testcase>'))
  assert.equal(r.failures[0].message, 'AssertionError: 1 !== 2')
})

test('entities are decoded, so a real message survives', () => {
  const r = parseJUnit(REPORT('<testcase name="t"><failure message="expected &lt;div&gt; &amp; got &quot;x&quot;"/></testcase>'))
  assert.equal(r.failures[0].message, 'expected <div> & got "x"')
})

test('a bare testsuite without the wrapper is read too', () => {
  assert.equal(parseJUnit(REPORT('<testcase name="t"/>', false)).tests, 1)
})

test('a classname that repeats the name is not said twice', () => {
  const r = parseJUnit(REPORT('<testcase name="auth signs in" classname="auth"><failure message="x"/></testcase>'))
  assert.equal(r.failures[0].test, 'auth signs in')
})

test('something that is not a JUnit report is null, not an empty one', () => {
  // "not a report" and "a report of nothing" are different problems with different fixes.
  assert.equal(parseJUnit('{"tests": []}'), null)
  assert.equal(parseJUnit(''), null)
  assert.equal(parseJUnit(REPORT('')).tests, 0)
})

// --- through a check ---------------------------------------------------------

test('a failing suite names the tests instead of reporting exit 1', () => {
  const dir = project({
    'run.sh': '#!/bin/sh\ncat report.xml > /dev/null\nexit 1\n',
    'report.xml': REPORT(`
      <testcase name="signs in" classname="auth"/>
      <testcase name="rejects an expired token" classname="auth"><failure message="expected 401, got 200"/></testcase>
    `),
    '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: the browser suite\n    run: sh run.sh\n    results: report.xml\n',
  })
  const r = proof(dir, 'check')

  assert.equal(r.code, 1)
  assert.match(r.out, /Expected:\n {4}2 test\(s\) pass/)
  assert.match(r.out, /1 of 2 failed:/)
  assert.match(r.out, /auth › rejects an expired token — expected 401, got 200/)
  assert.doesNotMatch(r.out, /Observed:\n {4}exit 1/)
  // and the report itself is evidence
  assert.match(r.out, /Evidence:\n {4}report\.xml/)
})

test('the regression this exists for: a filter that matched nothing is not a pass', () => {
  // `npx playwright test --grep nope` runs nothing and exits 0. That is the whole class of
  // bug this tool is about, arriving through the check written to catch the others.
  const dir = project({
    'report.xml': REPORT(''),
    '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: the suite\n    run: "true"\n    results: report.xml\n',
  })
  const r = proof(dir, 'check')
  assert.equal(r.code, 1)
  assert.match(r.out.replace(/\s+/g, ' '), /the report records 0 tests — the command ran nothing/)
})

test('a passing suite says how many, not just that it exited 0', () => {
  const dir = project({
    'report.xml': REPORT('<testcase name="a"/>\n<testcase name="b"/>'),
    '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: the suite\n    run: "true"\n    results: report.xml\n',
  })
  const r = proof(dir, 'check')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /the suite\s+PASS/)
  assert.match(proof(dir, 'lint').out, /every test in report\.xml passes/)
})

test('a missing report is a failure that names the likely cause', () => {
  const dir = project({ '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: the suite\n    run: "true"\n    results: out/report.xml\n' })
  const r = proof(dir, 'check')
  assert.equal(r.code, 1)
  assert.match(r.out.replace(/\s+/g, ' '), /wrote no report at out\/report\.xml — check the reporter flag/)
})

test('a clean report with a bad exit code is still a failure, and says which', () => {
  // The suite passed and something else in the command did not — a lint step, a teardown.
  const dir = project({
    'report.xml': REPORT('<testcase name="a"/>'),
    '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: the suite\n    run: exit 3\n    results: report.xml\n',
  })
  const r = proof(dir, 'check')
  assert.equal(r.code, 1)
  assert.match(r.out.replace(/\s+/g, ' '), /exit 3, though every test in the report passed/)
})

test('results is refused on a verb that runs no command', () => {
  const problems = validateSpec({
    goal: 'g',
    serve: { run: 'x', ready_url: 'http://localhost:3000' },
    checks: [{ name: 'c', http: { path: '/a' }, results: 'r.xml' }],
  })
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /results: only a `run:` check runs a command/)
})

test('proof can read its own JUnit output, so the two halves agree', async () => {
  // The writer and the reader are both string work in this repository; a round trip is what
  // keeps them the same shape.
  const { junit } = await import('../src/report.js')
  const xml = junit({
    status: 'failed',
    goal: 'g',
    results: [
      { name: 'ok', kind: 'run', status: 'passed', asserted: 'a', ms: 1 },
      { name: 'bad', kind: 'http', status: 'failed', asserted: 'b', ms: 2 },
      { name: 'off', kind: 'run', status: 'skipped', observed: 'why', ms: 0 },
    ],
    failures: [{ check: 'bad', expected: 'status 200', observed: 'status 500' }],
  })
  const r = parseJUnit(xml)
  assert.equal(r.tests, 3)
  assert.equal(r.failed, 1)
  assert.equal(r.skipped, 1)
  assert.equal(r.failures[0].test, 'proof.http › bad')
  assert.equal(r.failures[0].message, 'status 200')
})
