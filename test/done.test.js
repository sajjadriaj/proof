import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

// The completion gate. `check` reports what the contract did; this reports whether the
// evidence justifies calling the work finished — and it decides nothing itself: every input is
// a record some earlier command wrote.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const flat = out => out.replace(/\s+/g, ' ')
const manifest = dir => JSON.parse(readFileSync(join(dir, '.proof', 'report.json'), 'utf8'))

const CONTRACT = `goal: the feature exists
criteria:
  - id: AC1
    requirement: the feature is in the file
checks:
  - name: the feature is there
    satisfies: [AC1]
    file: {path: app.txt, contains: "the feature"}
`

/** A repo whose base commit predates the change, so falsification has something to find. */
const repo = (contract = CONTRACT) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-done-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, 'app.txt'), 'nothing yet\n')
  writeFileSync(join(dir, '.proof', 'spec.yaml'), contract)
  g('init', '-q', '-b', 'main', '.')
  g('config', 'user.email', 't@t.t')
  g('config', 'user.name', 't')
  g('add', '-A')
  g('commit', '-qm', 'before')
  writeFileSync(join(dir, 'app.txt'), 'the feature\n')
  return dir
}

const commit = dir => execFileSync('git', ['commit', '-qam', 'the change'], { cwd: dir, stdio: 'ignore' })

test('the whole chain, satisfied, is DONE and exits 0', () => {
  const dir = repo()
  assert.equal(proof(dir, 'falsify').code, 0)
  commit(dir)
  assert.equal(proof(dir, 'check').code, 0)

  const r = proof(dir, 'done')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /VERDICT\n {2}DONE/)
  assert.match(r.out, /Criteria\s+1\/1 VERIFIED/)
  assert.match(r.out, /Falsification\s+PASS/)

  const m = manifest(dir)
  assert.equal(m.verdict, 'DONE')
  assert.deepEqual(m.coverage, { AC1: 'verified' })
  assert.equal(m.falsification.result, 'discriminates')
  assert.deepEqual(m.reasons, [])
})

test('no run recorded is INCOMPLETE, not DONE by absence', () => {
  const dir = repo()
  const r = proof(dir, 'done')
  assert.equal(r.code, 1)
  assert.match(flat(r.out), /no run of this contract has been recorded/)
})

test('a contract never falsified is INCOMPLETE by default', () => {
  const dir = repo()
  proof(dir, 'check')
  const r = proof(dir, 'done')
  assert.equal(r.code, 1)
  assert.match(flat(r.out), /has never been shown to fail without the change/)
})

test('a policy can drop falsification, and then the same evidence is DONE', () => {
  const dir = repo(`${CONTRACT}policy:
  require_falsification: false
`)
  proof(dir, 'check')
  const r = proof(dir, 'done')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /VERDICT\n {2}DONE/)
})

test('an uncovered criterion is named, and withholds DONE', () => {
  const dir = repo(`goal: g
criteria:
  - id: AC1
    requirement: the feature is in the file
  - id: AC2
    requirement: nobody wrote a check for this
checks:
  - name: the feature is there
    satisfies: [AC1]
    file: {path: app.txt, contains: "the feature"}
policy:
  require_falsification: false
`)
  proof(dir, 'check')
  const r = proof(dir, 'done')
  assert.equal(r.code, 1)
  assert.match(flat(r.out), /AC2 has no verification evidence/)
  assert.equal(manifest(dir).coverage.AC2, 'uncovered')
})

test('evidence from another commit is INVALID, not stale-but-fine', () => {
  const dir = repo(`${CONTRACT}policy:
  require_falsification: false
`)
  proof(dir, 'check')
  commit(dir)                                   // the run verified the tree before this commit

  const r = proof(dir, 'done')
  assert.equal(r.code, 1)
  assert.match(r.out, /VERDICT\n {2}INVALID/)
  assert.match(flat(r.out), /that evidence is about other code/)
})

test('a run recorded under a different contract cannot be reused as evidence', () => {
  const dir = repo(`${CONTRACT}policy:
  require_falsification: false
`)
  proof(dir, 'check')
  writeFileSync(join(dir, '.proof', 'spec.yaml'), `goal: the feature exists
criteria:
  - id: AC1
    requirement: the feature is in the file, and says which feature
checks:
  - name: the feature is there
    satisfies: [AC1]
    file: {path: app.txt, contains: "the feature"}
policy:
  require_falsification: false
`)

  const r = proof(dir, 'done')
  assert.equal(r.code, 1)
  assert.match(r.out, /VERDICT\n {2}INVALID/)
  assert.match(flat(r.out), /evidence does not carry across contract changes/)
})

test('a sealed contract that moved is INVALID when the policy requires the seal', () => {
  const dir = repo(`${CONTRACT}policy:
  require_falsification: false
  require_sealed_contract: true
`)
  proof(dir, 'seal')
  proof(dir, 'check')
  assert.equal(proof(dir, 'done').code, 0)

  writeFileSync(join(dir, '.proof', 'spec.yaml'), readFileSync(join(dir, '.proof', 'spec.yaml'), 'utf8')
    .replace('requirement: the feature is in the file', 'requirement: something else entirely'))
  proof(dir, 'check')
  const r = proof(dir, 'done')
  assert.equal(r.code, 1)
  assert.match(r.out, /VERDICT\n {2}INVALID/)
})

test('a required challenge that was never run withholds DONE', () => {
  const dir = repo(`${CONTRACT}challenges:
  - name: remove the feature
    breaks: [AC1]
    apply: "printf 'nothing\\n' > app.txt"
policy:
  require_falsification: false
  require_challenges: true
`)
  proof(dir, 'check')
  const before = proof(dir, 'done')
  assert.equal(before.code, 1)
  assert.match(flat(before.out), /has never been challenged/)

  assert.equal(proof(dir, 'challenge').code, 0)
  const after = proof(dir, 'done')
  assert.equal(after.code, 0, after.out)
  assert.deepEqual(manifest(dir).challenges.missed, [])
})

test('a fault the contract missed withholds DONE even when challenges are optional', () => {
  const dir = repo(`goal: g
criteria:
  - id: AC1
    requirement: the feature is in the file
checks:
  - name: the file is there
    satisfies: [AC1]
    file: app.txt
challenges:
  - name: remove the feature
    breaks: [AC1]
    apply: "printf 'nothing\\n' > app.txt"
policy:
  require_falsification: false
`)
  proof(dir, 'check')
  proof(dir, 'challenge')
  const r = proof(dir, 'done')
  assert.equal(r.code, 1)
  assert.match(flat(r.out), /the contract accepted 1 injected fault/)
})

test('a subset run is not evidence about the contract', () => {
  const dir = repo(`goal: g
criteria:
  - id: AC1
    requirement: the feature is in the file
checks:
  - name: the feature is there
    satisfies: [AC1]
    file: {path: app.txt, contains: "the feature"}
  - name: it still builds
    run: "true"
policy:
  require_falsification: false
`)
  proof(dir, 'check', '--only', 'feature')
  const subset = proof(dir, 'done')
  assert.equal(subset.code, 1, subset.out)
  assert.match(flat(subset.out), /was a subset run/)
})

test('a check the contract switched off withholds DONE, with the reason from the file', () => {
  const dir = repo(`goal: g
criteria:
  - id: AC1
    requirement: the feature is in the file
checks:
  - name: the feature is there
    satisfies: [AC1]
    file: {path: app.txt, contains: "the feature"}
  - name: the slow one
    run: "true"
    skip: "see #412"
policy:
  require_falsification: false
`)
  proof(dir, 'check')
  const r = proof(dir, 'done')
  assert.equal(r.code, 1, r.out)
  assert.match(flat(r.out), /1 check\(s\) are skipped in the contract \(the slow one\)/)
})

test('the manifest is the same object --json prints', () => {
  const dir = repo(`${CONTRACT}policy:
  require_falsification: false
`)
  proof(dir, 'check')
  const payload = JSON.parse(proof(dir, 'done', '--json').stdout)
  const written = manifest(dir)
  assert.equal(payload.verdict, written.verdict)
  assert.deepEqual(payload.coverage, written.coverage)
  assert.equal(written.contract.hash.length, 64)
})

test('a contract kept elsewhere writes its own manifest', () => {
  const dir = repo()
  writeFileSync(join(dir, 'release.yaml'), `goal: release
checks:
  - name: the feature is there
    file: {path: app.txt, contains: "the feature"}
policy:
  require_falsification: false
`)
  proof(dir, 'check', '--spec', 'release.yaml')
  assert.equal(proof(dir, 'done', '--spec', 'release.yaml').code, 0)
  assert.ok(readFileSync(join(dir, '.proof', 'report-release-yaml.json'), 'utf8').includes('"DONE"'))
})

test('a baseline that is no longer in the repository is INVALID, not a pass', () => {
  // The falsification on record cannot be reproduced, so nothing about it can be trusted —
  // which is a different failure from never having run it.
  const dir = repo()
  proof(dir, 'falsify')
  commit(dir)
  proof(dir, 'check')
  assert.equal(proof(dir, 'done').code, 0)

  const file = join(dir, '.proof', 'falsification.json')
  const record = JSON.parse(readFileSync(file, 'utf8'))
  record.records['.proof/spec.yaml'].commit = '0'.repeat(40)
  writeFileSync(file, JSON.stringify(record))

  const r = proof(dir, 'done')
  assert.equal(r.code, 1)
  assert.match(r.out, /VERDICT\n {2}INVALID/)
  assert.match(flat(r.out), /is no longer in this repository/)
})

// --- the one step to take now ------------------------------------------------------------

test('the gate names the next command, in lifecycle order', async () => {
  const { nextStep } = await import('../src/done.js')

  const base = {
    criteria: [],
    contract: { modified: false },
    invalid: [],
    checks: { total: 2, passed: 2 },
    falsification: { result: 'discriminates' },
    challenges: { missed: [], counterexamples: [], result: 'complete' },
    attack: { gaps: [], violations: [], counterexamples: [], result: 'no_counterexample_found' },
    flakes: [],
    policy: {},
  }

  assert.equal(nextStep({ ...base, checks: { total: null, passed: null } }).run, 'proof check')
  assert.equal(nextStep({ ...base, checks: { total: 2, passed: 1 } }).run, 'proof report')
  assert.equal(nextStep({ ...base, falsification: { result: 'missing' } }).run, 'proof falsify')
  assert.equal(nextStep({ ...base, contract: { modified: true } }).run, 'proof diff')
  assert.equal(nextStep({ ...base, invalid: ['evidence is about other code'] }).run, 'proof check')

  // A finding names its own counterexample rather than a placeholder.
  const gap = nextStep({
    ...base,
    attack: { gaps: ['AC1'], violations: [], counterexamples: ['.proof/counterexamples/ce-17f09e06.yaml'], result: 'verification_gap' },
  })
  assert.equal(gap.run, 'proof replay ce-17f09e06')

  // A criterion with no evidence has no command to run — it needs a check written.
  const uncovered = nextStep({ ...base, criteria: [{ id: 'AC4', status: 'uncovered' }] })
  assert.equal(uncovered.run, null)
  assert.match(uncovered.why, /satisfies: \[AC4\]/)

  // Everything satisfied: nothing to suggest.
  assert.equal(nextStep(base), null)
})

test('the next step is carried in --json too, so an agent reads the same answer', () => {
  const dir = repo(`${CONTRACT}policy:
  require_falsification: false
`)
  const payload = JSON.parse(proof(dir, 'done', '--json').stdout)
  assert.equal(payload.next.run, 'proof check')
  assert.match(payload.next.why, /nothing has run this contract yet/)
})
