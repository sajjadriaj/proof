import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSpec } from '../src/spec.js'

const asRoot = process.getuid?.() === 0
const opts = { skip: asRoot && 'root reads everything' }

const withSpec = body => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-specread-'))
  process.chdir(dir)
  mkdirSync('.proof')
  if (body !== null) writeFileSync('.proof/spec.yaml', body)
  return dir
}

test('the regression: a contract that cannot be read is not called invalid YAML', opts, () => {
  // It may be perfectly good YAML. Saying otherwise sends someone to edit a file that is
  // not broken, with a permission problem that stays unfixed.
  withSpec('goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  chmodSync('.proof/spec.yaml', 0o000)
  try {
    assert.throws(() => loadSpec(), e => {
      assert.match(e.message, /cannot read the contract/)
      assert.match(e.message, /permission denied/)
      assert.doesNotMatch(e.message, /valid YAML/, 'the file was never parsed, so nothing is known about it')
      assert.equal(e.code, 'ESPECREAD')
      return true
    })
  } finally { chmodSync('.proof/spec.yaml', 0o600) }
})

test('a directory where the contract should be says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-specdir-'))
  process.chdir(dir)
  mkdirSync('.proof/spec.yaml', { recursive: true })

  assert.throws(() => loadSpec(), /cannot read the contract.*it is a directory/)
})

test('broken YAML is still reported as broken YAML, with the line', () => {
  // The distinction only helps if the parse error keeps its own diagnosis.
  withSpec('goal: g\nchecks:\n\t- name: a\n')

  assert.throws(() => loadSpec(), e => {
    assert.match(e.message, /is not valid YAML/)
    assert.match(e.message, /line 3/, 'the parser location survives')
    return true
  })
})

test('an absent contract is still its own error', () => {
  // Three states, three answers: absent, unreadable, unparseable.
  withSpec(null)
  assert.throws(() => loadSpec(), e => {
    assert.equal(e.code, 'ENOSPEC')
    assert.match(e.message, /run `proof init/)
    return true
  })
})

test('a readable, parseable contract loads', () => {
  withSpec('goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  assert.equal(loadSpec().goal, 'g')
})
