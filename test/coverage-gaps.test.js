import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateSpec } from '../src/validate.js'
import { report } from '../src/report.js'

// Found by running the suite under --experimental-test-coverage: reachable lines no test
// exercised. An untested line in a verification tool is a claim nobody has checked.

const SERVE = { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true }
const problems = checks => validateSpec({ goal: 'g', serve: SERVE, checks }).join('\n')

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

test('a bad type token inside an array in a json expectation is caught', () => {
  // Objects were checked; array elements were walked but nothing asserted about the result.
  const out = problems([{ name: 'c', http: { path: '/', expect: { json: { items: ['<numbr>'] } } } }])

  assert.match(out, /<numbr>/)
  assert.match(out, /items\[0\]/, 'the element is located, not just the field')
})

test('a valid type token inside an array is accepted', () => {
  assert.equal(problems([{ name: 'c', http: { path: '/', expect: { json: { items: ['<number>'] } } } }]), '')
})

test('a browser flow that is not a list is a contract error', () => {
  const out = problems([{ name: 'c', browser: { flow: 'visit the page' } }])
  assert.match(out, /flow: must be a list of steps/)
})

test('an expect_request that is not a mapping is a contract error', () => {
  const out = problems([{ name: 'c', browser: { flow: [{ visit: '/', expect_request: '/api/x' }] } }])
  assert.match(out, /expect_request: must be a mapping/)
})

test('the report lists the files that were uncommitted when the run started', async () => {
  // A whole section of report.md — the reviewer's answer to "verified against what, exactly?"
  // when the tree was dirty — that nothing exercised.
  const dir = mkdtempSync(join(tmpdir(), 'proof-covgap-'))
  process.chdir(dir)
  mkdirSync('.proof/runs/0001', { recursive: true })
  writeFileSync('.proof/runs/0001/result.json', JSON.stringify({
    status: 'passed',
    goal: 'g',
    at: new Date(0).toISOString(),
    git: { head: 'abc123abc123', branch: 'feature/x', changed: ['src/a.ts', 'src/b.ts'] },
    results: [{ name: 'c', kind: 'run', asserted: '`true`, exit 0', status: 'passed', ms: 1 }],
    failures: [],
    warnings: [],
  }))

  await quiet(() => report({ run: '0001' }))
  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')

  assert.match(md, /## Changed files/)
  assert.match(md, /- `src\/a\.ts`/)
  assert.match(md, /- `src\/b\.ts`/)
})

test('a clean tree gets no changed-files section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-covgap-clean-'))
  process.chdir(dir)
  mkdirSync('.proof/runs/0001', { recursive: true })
  writeFileSync('.proof/runs/0001/result.json', JSON.stringify({
    status: 'passed',
    goal: 'g',
    at: new Date(0).toISOString(),
    git: { head: 'abc123abc123', branch: 'main', changed: [] },
    results: [{ name: 'c', kind: 'run', asserted: '`true`, exit 0', status: 'passed', ms: 1 }],
    failures: [],
    warnings: [],
  }))

  await quiet(() => report({ run: '0001' }))
  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
  assert.match(md, /## Checks/, 'a report was written at all')
  assert.doesNotMatch(md, /## Changed files/)
})

test('the runner refuses a relative path with no base, even called directly', async () => {
  // Validation rejects this contract, so the guard inside the runner is unreachable through
  // the CLI. It is the last thing standing between a relative path and a guessed host.
  const { check } = await import('../src/check.js')
  const dir = mkdtempSync(join(tmpdir(), 'proof-covgap-nobase-'))
  process.chdir(dir)
  mkdirSync('.proof')
  // written past validation on purpose: `serve` is absent, `http.path` is relative
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: c\n    http: {path: /x}\n')

  const code = await quiet(() => check({ json: true })).catch(() => 2)
  assert.equal(code, 2, 'the contract is rejected before anything is requested')
})
