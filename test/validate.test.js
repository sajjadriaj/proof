import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { validateSpec, suggest } from '../src/validate.js'
import { loadSpec } from '../src/spec.js'
import { check } from '../src/check.js'

const ok = spec => assert.deepEqual(validateSpec(spec), [])
const problems = spec => validateSpec(spec)

test('a typo that would silently disable an assertion is rejected with a suggestion', () => {
  const p = problems({
    goal: 'g',
    checks: [{ name: 'api', http: { url: 'http://x.test/', expect_status: 200 } }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /unknown key "expect_status" — did you mean "expect"\?/)
})

test('the regression: a 500 response can no longer pass a contract demanding 200', async () => {
  const server = createServer((_, res) => { res.writeHead(500); res.end('boom') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`

  process.chdir(mkdtempSync(join(tmpdir(), 'proof-validate-')))
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'server must return 200',
    checks: [{ name: 'api returns 200', http: { url, expect_status: 200 } }],
  }))

  try {
    await assert.rejects(() => check({ json: true }), /unknown key "expect_status"/)
  } finally { server.close() }
})

test('unknown keys are caught at every nesting depth', () => {
  assert.match(problems({ goal: 'g', chekcs: [] })[0], /unknown key "chekcs" — did you mean "checks"\?/)
  assert.match(
    problems({ goal: 'g', serve: { run: 'x', ready_url: 'http://x.test', timeuot: 5 }, checks: [{ name: 'a', run: 'true' }] })[0],
    /serve: unknown key "timeuot" — did you mean "timeout"\?/,
  )
  assert.match(
    problems({ goal: 'g', checks: [{ name: 'a', http: { url: 'http://x.test/', expect: { staus: 200 } } }] })[0],
    /unknown key "staus" — did you mean "status"\?/,
  )
  assert.match(
    problems({ goal: 'g', checks: [{ name: 'a', browser: { base_url: 'http://x.test', visit: '/', flow: [{ clik: 'Go' }] } }] })[0],
    /flow\[0\]: unknown key "clik" — did you mean "click"\?/,
  )
})

test('a check must assert exactly one thing', () => {
  assert.match(problems({ goal: 'g', checks: [{ name: 'a' }] })[0], /no verb — expected one of run, http, file, env, browser/)
  assert.match(
    problems({ goal: 'g', checks: [{ name: 'a', run: 'true', file: 'x' }] })[0],
    /2 verbs \(run, file\) — a check asserts one thing/,
  )
})

test('verbs missing their required target are rejected', () => {
  assert.match(problems({ goal: 'g', checks: [{ name: 'a', http: { method: 'GET' } }] })[0], /needs a `path` or `url`/)
  assert.match(problems({ goal: 'g', checks: [{ name: 'a', env: {} }] })[0], /needs a variable name/)
  assert.match(problems({ goal: 'g', checks: [{ name: 'a', browser: {} }] })[0], /needs a `visit` or a `flow`/)
  assert.match(problems({ goal: 'g', serve: { run: 'x' }, checks: [{ name: 'a', run: 'true' }] })[0], /needs a `ready_url`/)
  assert.match(
    problems({ goal: 'g', checks: [{ name: 'a', browser: { flow: [{ expect_request: { method: 'POST' } }] } }] })[0],
    /expect_request: needs a `path`, `path_matches` or `url` to match/,
  )
})

test('user-defined key spaces stay opaque', () => {
  ok({
    goal: 'g',
    checks: [
      { name: 'a', http: { url: 'http://x.test/x', headers: { 'X-Weird-Header': '1' }, body: { anyField: true, nested: { ok: 1 } } } },
      { name: 'b', browser: { base_url: 'http://x.test', visit: '/', flow: [{ fill: { 'not-a-schema-key': 'v', '#css-selector': 'v' } }] } },
    ],
  })
})

test('a fully-featured valid contract passes clean', () => {
  ok({
    goal: 'everything',
    requirement: 'long form text',
    serve: { run: 'npm run dev', ready_url: 'http://localhost:3000', timeout: 60 },
    checks: [
      { name: 'build', run: 'npm run build', expect_exit: 0, expect_output: 'done', timeout: 120 },
      { name: 'api', http: { method: 'POST', path: '/a', expect: { status: 200, body_contains: 'ok' } } },
      { name: 'file', file: { path: 'x', exists: true, contains: 'y' } },
      { name: 'file short', file: 'x' },
      { name: 'env', env: { name: 'A', matches: '^s' } },
      { name: 'env short', env: 'B' },
      {
        name: 'flow',
        browser: {
          base_url: 'http://x',
          visit: '/a',
          expect_no_console_errors: true,
          flow: [
            { fill: { email: 'a@b.c' } },
            { click: 'Go' },
            { expect_request: { method: 'POST', path: '/a', timeout_ms: 1000 } },
            { expect_text: 'hi' },
            { expect_url: '/b' },
            { wait: 100 },
          ],
        },
      },
    ],
  })
})

test('loadSpec reports every problem at once, and distinguishes missing from broken', () => {
  process.chdir(mkdtempSync(join(tmpdir(), 'proof-validate2-')))
  mkdirSync('.proof')

  const missing = (() => { try { loadSpec() } catch (e) { return e } })()
  assert.equal(missing.code, 'ENOSPEC')

  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'g',
    checks: [{ name: 'a', http: { url: 'http://x.test/', expect_status: 1 } }, { name: 'b' }],
  }))
  const broken = (() => { try { loadSpec() } catch (e) { return e } })()
  assert.notEqual(broken.code, 'ENOSPEC')
  assert.match(broken.message, /expect_status/)
  assert.match(broken.message, /no verb/)

  writeFileSync('.proof/spec.yaml', 'goal: [unclosed\n')
  assert.throws(() => loadSpec(), /is not valid YAML/)
})

test('suggest stays quiet when nothing is close', () => {
  assert.equal(suggest('completely_different', ['status', 'body_contains']), null)
  assert.equal(suggest('stat', ['status', 'body_contains']), 'status')
})
