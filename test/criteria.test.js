import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { coverage } from '../src/criteria.js'
import { validateSpec } from '../src/validate.js'

// The largest hole this tool had: a contract can be valid, green, and say nothing about half
// the requirement. Passing checks are evidence for what the checks assert — which is not the
// same as evidence for what was asked for.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const project = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-criteria-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof', 'spec.yaml'), contract)
  return dir
}

const flat = out => out.replace(/\s+/g, ' ')

const COVERED = `goal: g
criteria:
  - id: AC1
    requirement: the thing happens
  - id: AC2
    requirement: the other thing happens
checks:
  - name: a
    satisfies: [AC1]
    run: "true"
  - name: b
    satisfies: AC2
    run: "true"
`

test('a criterion no check points at makes a green run INCOMPLETE', () => {
  const dir = project(`goal: g
criteria:
  - id: AC1
    requirement: the thing happens
  - id: AC2
    requirement: nobody wrote a check for this
checks:
  - name: a
    satisfies: [AC1]
    run: "true"
`)

  const r = proof(dir, 'check')
  assert.match(r.out, /AC2/)
  assert.match(r.out, /UNCOVERED/)
  assert.match(r.out, /INCOMPLETE/)
  assert.doesNotMatch(r.out, /^ {2}DONE$/m)
  assert.match(flat(r.out), /nothing in this run is evidence for AC2/)
  // The checks did pass: the verdict is about coverage, and it says which.
  assert.match(r.out, /1 passed, 1\/2 criteria verified/)
})

test('every criterion covered by a passing check is DONE', () => {
  const r = proof(project(COVERED), 'check')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /VERDICT\n {2}DONE/)
  assert.match(r.out, /2 passed, 2\/2 criteria verified/)
})

test('a criterion whose check fails is reported as failed, not uncovered', () => {
  const dir = project(`goal: g
criteria:
  - id: AC1
    requirement: the thing happens
checks:
  - name: a
    satisfies: [AC1]
    run: exit 1
`)
  const r = proof(dir, 'check')
  assert.equal(r.code, 1)
  assert.match(r.out, /AC1\s+the thing happens\s+FAILED/)
})

test('a criterion covered only by a skipped check is unverified, not verified', () => {
  const dir = project(`goal: g
criteria:
  - id: AC1
    requirement: the thing happens
checks:
  - name: a
    satisfies: [AC1]
    run: "true"
    skip: "see #412"
  - name: b
    run: "true"
`)
  const r = proof(dir, 'check')
  assert.match(r.out, /AC1\s+the thing happens\s+UNVERIFIED/)
  assert.match(r.out, /INCOMPLETE/)
})

test('coverage is derivable from the file alone, before anything runs', () => {
  const spec = {
    goal: 'g',
    criteria: [{ id: 'AC1', requirement: 'one' }, { id: 'AC2', requirement: 'two' }],
    checks: [{ name: 'a', satisfies: ['AC1'], run: 'true' }],
  }
  assert.deepEqual(coverage(spec).map(c => [c.id, c.status]), [['AC1', 'covered'], ['AC2', 'uncovered']])

  const withRun = coverage(spec, [{ name: 'a', status: 'passed' }])
  assert.deepEqual(withRun.map(c => [c.id, c.status]), [['AC1', 'verified'], ['AC2', 'uncovered']])
})

test('lint names the uncovered criteria without spending a run', () => {
  const dir = project(`goal: g
criteria:
  - id: AC1
    requirement: one
  - id: AC2
    requirement: two
checks:
  - name: a
    satisfies: [AC1]
    run: "true"
`)
  const r = proof(dir, 'lint')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /AC2 {2}UNCOVERED/)
  assert.match(flat(r.out), /1 of 2 criteria covered/)
  assert.match(flat(r.out), /a run of this contract cannot report completion/)
})

test('a satisfies naming a criterion that does not exist is refused, with the near miss', () => {
  const problems = validateSpec({
    goal: 'g',
    criteria: [{ id: 'AC1', requirement: 'one' }],
    checks: [{ name: 'a', satisfies: ['AC2'], run: 'true' }],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no criterion "AC2" is declared — did you mean "AC1"\?/)
})

test('satisfies without any criteria declared is refused rather than ignored', () => {
  const problems = validateSpec({ goal: 'g', checks: [{ name: 'a', satisfies: ['AC1'], run: 'true' }] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /declares no `criteria`/)
})

test('two criteria with one id are refused — coverage is keyed by id', () => {
  const problems = validateSpec({
    goal: 'g',
    criteria: [{ id: 'AC1', requirement: 'one' }, { id: 'AC1', requirement: 'two' }],
    checks: [{ name: 'a', satisfies: ['AC1'], run: 'true' }],
  })
  assert.ok(problems.some(p => /duplicate criterion id/.test(p)), problems.join('\n'))
})

test('a criterion with no requirement text is refused', () => {
  const problems = validateSpec({
    goal: 'g',
    criteria: [{ id: 'AC1' }],
    checks: [{ name: 'a', satisfies: ['AC1'], run: 'true' }],
  })
  assert.ok(problems.some(p => /requirement: needs the requirement in words/.test(p)), problems.join('\n'))
})

test('provenance survives into the evidence', () => {
  const dir = project(`goal: g
criteria:
  - id: AC1
    requirement: one
    source: {type: github_issue, reference: "#143"}
checks:
  - name: a
    satisfies: [AC1]
    run: "true"
`)
  const r = proof(dir, 'check', '--json')
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.criteria[0].source, 'github_issue #143')
  assert.deepEqual(payload.results[0].criteria, ['AC1'])
})

test('guard refuses a contract with an uncovered criterion rather than loop forever', () => {
  const dir = project(`goal: g
criteria:
  - id: AC1
    requirement: one
  - id: AC2
    requirement: nobody wrote a check for this
checks:
  - name: a
    satisfies: [AC1]
    run: "true"
`)
  writeFileSync(join(dir, 'agent.sh'), '#!/bin/sh\ntrue\n', { mode: 0o755 })
  const r = proof(dir, 'guard', '--max-attempts', '1', '--', './agent.sh')
  assert.equal(r.code, 2, r.out)
  assert.match(flat(r.out), /AC2.*no run can report completion/)
})
