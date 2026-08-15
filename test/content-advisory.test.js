import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { check } from '../src/check.js'

// A real server, so the checks actually pass. Pointing the contract at a dead port made
// every run fail, and a failing run has no advisory at all — every assertion of `null`
// would have held for entirely the wrong reason.
let server
let base

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ up: true }))
  })
  await new Promise(res => server.listen(0, '127.0.0.1', res))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => server?.close())

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const serve = () => `serve:\n  run: sleep 30\n  ready_url: ${base}\n  reuse_existing: true\n`

/** Runs the contract and returns [advisory, status]. */
const runContract = async spec => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-advisory-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', spec)
  await quiet(() => check({ json: true }))
  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  return [r.advisory, r.status]
}

test('the regression: status-only http checks are flagged as proving less than they look', async () => {
  // `infer` can only generate `expect: {status: 200}` — it cannot know the requirement —
  // so a contract built from generated checks passes on a 200 carrying the wrong body.
  const [advisory, status] = await runContract(
    `goal: the status endpoint reports the service is up\n${serve()}`
    + 'checks:\n  - name: status\n    http: {path: /api/status, expect: {status: 200}}\n',
  )
  assert.equal(status, 'passed', 'the advisory is about a PASSING run')
  assert.match(advisory ?? '', /asserts what the app actually returned/)
})

test('asserting the body clears it', async () => {
  const [advisory, status] = await runContract(
    `goal: g\n${serve()}`
    + 'checks:\n  - name: status\n    http: {path: /api/status, expect: {status: 200, body_contains: "up"}}\n',
  )
  assert.equal(status, 'passed')
  assert.equal(advisory, null)
})

test('a json assertion counts as content', async () => {
  const [advisory, status] = await runContract(
    `goal: g\n${serve()}`
    + 'checks:\n  - name: status\n    http: {path: /s, expect: {json: {up: true}}}\n',
  )
  assert.equal(status, 'passed')
  assert.equal(advisory, null)
})

test('one content assertion among several status-only checks is enough', async () => {
  const [advisory, status] = await runContract(
    `goal: g\n${serve()}`
    + 'checks:\n  - name: health\n    http: {path: /health, expect: {status: 200}}\n'
    + '  - name: status\n    http: {path: /s, expect: {status: 200, body_contains: "up"}}\n',
  )
  assert.equal(status, 'passed')
  assert.equal(advisory, null)
})

test('the older advisory still wins when nothing exercises the app at all', async () => {
  // Both could apply to a contract with no http checks; the more fundamental one —
  // nothing runs the app — is the one worth saying.
  const [advisory, status] = await runContract('goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  assert.equal(status, 'passed')
  assert.match(advisory ?? '', /Nothing in this contract exercises the running application/)
})

test('an env-only contract is not told to assert response bodies it has no responses for', async () => {
  const [advisory, status] = await runContract('goal: g\nchecks:\n  - name: a\n    env: HOME\n')
  assert.equal(status, 'passed')
  assert.equal(advisory, null)
})

test('a failing run gets no advisory — the failure is the message', async () => {
  const [advisory, status] = await runContract(
    `goal: g\n${serve()}`
    + 'checks:\n  - name: status\n    http: {path: /s, expect: {status: 404}}\n',
  )
  assert.equal(status, 'failed', 'the server answers 200, so asserting 404 fails')
  assert.equal(advisory, null)
})

test('the regression: with a serve block, the advisory does not claim nothing exercised the app', async () => {
  // `app boots` and `app still running` both passed, so the app was started and answered.
  // "Nothing in this contract exercises the running application" was simply false there.
  const [advisory, status] = await runContract(
    `goal: g\n${serve()}checks:\n  - name: unit tests\n    run: echo ok\n`,
  )

  assert.equal(status, 'passed')
  assert.match(advisory ?? '', /The app was started and answered/)
  assert.doesNotMatch(advisory ?? '', /Nothing in this contract exercises/)
})

test('and it names the narrower gap that is actually there', async () => {
  const [advisory] = await runContract(
    `goal: g\n${serve()}checks:\n  - name: unit tests\n    run: echo ok\n`,
  )

  assert.match(advisory, /`app boots` shows it is up, not that the requirement works/)
  assert.match(advisory, /Add an `http` or `browser` check/)
})

test('without a serve block the original advisory still applies', async () => {
  // Nothing started the app there, so the stronger statement is the true one.
  const [advisory] = await runContract('goal: g\nchecks:\n  - name: unit tests\n    run: echo ok\n')
  assert.match(advisory ?? '', /Nothing in this contract exercises the running application/)
})

test('a subset run carries no advisory at all', async () => {
  // Every advisory is a statement about what the whole contract proves, and a subset did not
  // run the whole contract. Reporting "no http check asserts content" for checks that were
  // never selected is a caveat about something the reader did not ask for — and INCOMPLETE
  // already says the run makes no completion claim.
  const dir = mkdtempSync(join(tmpdir(), 'proof-advisory-skipped-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    `goal: g\n${serve()}checks:\n  - name: unit tests\n    run: echo ok\n  - name: api\n    http: {path: /}\n`)

  await quiet(() => check({ json: true, only: 'unit tests' }))
  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

  assert.equal(r.status, 'partial')
  assert.equal(r.serve_skipped, true)
  assert.equal(r.advisory, null)
})

test('an http check silences it entirely', async () => {
  const [advisory] = await runContract(
    `goal: g\n${serve()}checks:\n  - name: api\n    http: {path: /, expect: {body_contains: "up"}}\n`,
  )
  assert.equal(advisory, null)
})
