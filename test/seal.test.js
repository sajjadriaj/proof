import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { contractHash } from '../src/seal.js'

// An agent that cannot make a check pass can edit the check. The seal does not forbid that —
// requirements change — it stops the evidence gathered before the edit from being read as if
// the edit had not happened.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const CONTRACT = `goal: g
criteria:
  - id: AC1
    requirement: one
checks:
  - name: a
    satisfies: [AC1]
    run: "true"
`

const project = (contract = CONTRACT) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-seal-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof', 'spec.yaml'), contract)
  return dir
}

const flat = out => out.replace(/\s+/g, ' ')
const lock = dir => JSON.parse(readFileSync(join(dir, '.proof', 'lock.json'), 'utf8'))

test('seal records the contract fingerprint and the criteria it covers', () => {
  const dir = project()
  const r = proof(dir, 'seal')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /Contract sealed/)

  const entry = lock(dir).sealed['.proof/spec.yaml']
  assert.match(entry.contract_hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(entry.criteria, ['AC1'])
  assert.ok(entry.sealed_at)
})

test('the fingerprint is over what the contract says, not how it is laid out', () => {
  // Reindenting and rewrapping a comment must not invalidate a seal — a fingerprint people
  // reseal past without reading is worth nothing.
  const a = { goal: 'g', checks: [{ name: 'a', run: 'true' }] }
  const b = { checks: [{ run: 'true', name: 'a' }], goal: 'g' }
  assert.equal(contractHash(a), contractHash(b))

  const changed = { goal: 'g', checks: [{ name: 'a', run: 'false' }] }
  assert.notEqual(contractHash(a), contractHash(changed))
})

test('a contract edited after sealing costs the completion verdict, with the reason', () => {
  const dir = project()
  assert.equal(proof(dir, 'seal').code, 0)
  assert.equal(proof(dir, 'check').code, 0)

  writeFileSync(join(dir, '.proof', 'spec.yaml'), CONTRACT.replace('run: "true"', 'run: "true"\n    timeout: 30'))
  const r = proof(dir, 'check')
  assert.match(r.out, /INCOMPLETE/)
  assert.match(flat(r.out), /the contract has changed since it was sealed/)
  assert.doesNotMatch(r.out, /^ {2}DONE$/m)
})

test('diff names what moved and which criteria that leaves without evidence', () => {
  const dir = project()
  proof(dir, 'seal')
  writeFileSync(join(dir, '.proof', 'spec.yaml'), `goal: g
criteria:
  - id: AC1
    requirement: one
  - id: AC2
    requirement: two
checks:
  - name: a
    satisfies: [AC1]
    run: "true"
  - name: b
    satisfies: [AC2]
    run: "true"
`)

  const r = proof(dir, 'diff')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /\+ AC2/)
  assert.match(r.out, /\+ check "b"/)
  assert.match(r.out, /AC2 {3}UNVERIFIED/)
})

test('a changed criterion is REVERIFY, not UNVERIFIED — it had evidence for other words', () => {
  const dir = project()
  proof(dir, 'seal')
  writeFileSync(join(dir, '.proof', 'spec.yaml'), CONTRACT.replace('requirement: one', 'requirement: one, more precisely'))

  const r = proof(dir, 'diff')
  assert.match(r.out, /~ AC1/)
  assert.match(r.out, /AC1 {3}REVERIFY/)
})

test('a contract that has not moved says so rather than printing an empty diff', () => {
  const dir = project()
  proof(dir, 'seal')
  const r = proof(dir, 'diff')
  assert.match(r.out, /none — the contract is exactly what was sealed/)
})

test('diff on a contract that was never sealed is a configuration error, not an empty answer', () => {
  const r = proof(project(), 'diff')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /has never been sealed/)
})

test('resealing says what it replaces — the previous chain does not carry over silently', () => {
  const dir = project()
  proof(dir, 'seal')
  writeFileSync(join(dir, '.proof', 'spec.yaml'), CONTRACT.replace('requirement: one', 'requirement: two'))
  const r = proof(dir, 'seal')
  assert.match(r.out, /This replaces [0-9a-f]{12}/)
  assert.match(flat(r.out), /have to run again/)
})

test('two contracts sharing .proof each keep their own seal', () => {
  // The one failure an integrity feature cannot have: the second seal overwriting the first.
  const dir = project()
  writeFileSync(join(dir, 'release.yaml'), 'goal: release\nchecks:\n  - name: r\n    run: "true"\n')
  proof(dir, 'seal')
  proof(dir, 'seal', '--spec', 'release.yaml')

  const sealed = lock(dir).sealed
  assert.ok(sealed['.proof/spec.yaml'])
  assert.ok(sealed['release.yaml'])
  assert.notEqual(sealed['.proof/spec.yaml'].contract_hash, sealed['release.yaml'].contract_hash)
})

test('the run records which contract it was a verdict about', () => {
  const dir = project()
  const payload = JSON.parse(proof(dir, 'check', '--json').stdout)
  assert.match(payload.contract_hash, /^[0-9a-f]{64}$/)
  assert.equal(payload.contract_integrity, 'unsealed')

  proof(dir, 'seal')
  assert.equal(JSON.parse(proof(dir, 'check', '--json').stdout).contract_integrity, 'valid')
})

test('guard refuses a contract that moved after sealing rather than relaunch an agent at it', () => {
  const dir = project()
  proof(dir, 'seal')
  writeFileSync(join(dir, '.proof', 'spec.yaml'), CONTRACT.replace('requirement: one', 'requirement: two'))
  writeFileSync(join(dir, 'agent.sh'), '#!/bin/sh\ntrue\n', { mode: 0o755 })

  const r = proof(dir, 'guard', '--max-attempts', '1', '--', './agent.sh')
  assert.equal(r.code, 2, r.out)
  assert.match(flat(r.out), /has changed since it was sealed/)
})

test('the policy block only takes yes or no', () => {
  const dir = project(`${CONTRACT}policy:
  require_falsification: maybe
`)
  const r = proof(dir, 'check')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /policy › require_falsification: must be a boolean/)
})

test('a contract named absolutely is the same contract as one named relatively', () => {
  // Otherwise the same file gets two verification chains: sealed under one name, checked
  // under the other, and nothing matching anything.
  const dir = project()
  proof(dir, 'seal')
  const payload = JSON.parse(proof(dir, 'check', '--json', '--spec', join(dir, '.proof', 'spec.yaml')).stdout)
  assert.equal(payload.contract_integrity, 'valid')
})
