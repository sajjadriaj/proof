import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check } from '../src/check.js'
import { report } from '../src/report.js'

// Behaviours found by reading the lcov branch data: conditions the suite only ever took
// one way. Each is correct today and had nothing holding it there.

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const runEnvCheck = async name => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-branch-env-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', `goal: g\nchecks:\n  - name: key\n    env: ${name}\n`)
  await quiet(() => check({ json: true }))
  return JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
}

test('an env var set to the empty string fails, and says empty rather than unset', async () => {
  // `export API_KEY=` in a .env is the ordinary way this happens. "unset" would send
  // someone looking for a missing line rather than an empty one.
  process.env.PROOF_TEST_EMPTY = ''
  try {
    const r = await runEnvCheck('PROOF_TEST_EMPTY')
    assert.equal(r.status, 'failed')
    assert.equal(r.failures[0].observed, 'empty')
  } finally { delete process.env.PROOF_TEST_EMPTY }
})

test('an env var that is absent says unset', async () => {
  delete process.env.PROOF_TEST_ABSENT
  const r = await runEnvCheck('PROOF_TEST_ABSENT')

  assert.equal(r.status, 'failed')
  assert.equal(r.failures[0].observed, 'unset', 'absent and empty are different answers')
})

test('an env var with a value passes', async () => {
  process.env.PROOF_TEST_SET = 'value'
  try {
    assert.equal((await runEnvCheck('PROOF_TEST_SET')).status, 'passed')
  } finally { delete process.env.PROOF_TEST_SET }
})

const renderResult = async result => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-branch-md-'))
  process.chdir(dir)
  mkdirSync('.proof/runs/0001', { recursive: true })
  writeFileSync('.proof/runs/0001/result.json', JSON.stringify({
    status: 'passed',
    goal: 'g',
    at: new Date(0).toISOString(),
    results: [{ name: 'c', kind: 'run', asserted: '`true`, exit 0', status: 'passed', ms: 5 }],
    failures: [],
    warnings: [],
    ...result,
  }))
  await quiet(() => report({ run: '0001' }))
  return readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
}

test('a check taking over a second is reported in seconds, not four digits of milliseconds', async () => {
  const md = await renderResult({
    results: [{ name: 'slow', kind: 'run', asserted: '`sleep 2`, exit 0', status: 'passed', ms: 2400 }],
  })
  assert.match(md, /\| 2\.4s \|/, md)
})

test('a fast check stays in milliseconds', async () => {
  const md = await renderResult({
    results: [{ name: 'quick', kind: 'run', asserted: '`true`, exit 0', status: 'passed', ms: 7 }],
  })
  assert.match(md, /\| 7ms \|/)
})

test('a detached HEAD reports the commit without inventing a branch', async () => {
  // `git.branch` is "HEAD" or null when detached — a CI checkout of a PR merge commit.
  const md = await renderResult({ git: { head: 'abcdef0123456789', branch: null, changed: [] } })

  assert.match(md, /\*\*Commit:\*\* `abcdef012345`/)
  assert.doesNotMatch(md, /\(null\)/, 'no empty parenthetical')
})

test('a branch is shown when there is one', async () => {
  const md = await renderResult({ git: { head: 'abcdef0123456789', branch: 'feature/x', changed: [] } })
  assert.match(md, /\*\*Commit:\*\* `abcdef012345` \(feature\/x\)/)
})

test('a run outside a repository shows no commit line at all', async () => {
  const md = await renderResult({ git: null })
  assert.match(md, /\*\*Verdict:\*\*/, 'a report was rendered at all')
  assert.doesNotMatch(md, /\*\*Commit:\*\*/)
})
