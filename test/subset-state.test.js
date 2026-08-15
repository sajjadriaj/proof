import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import { check } from '../src/check.js'

// A real app with a session, because the point is what a subset run loses.
let server
let base

before(async () => {
  const sessions = new Set()
  server = http.createServer((req, res) => {
    if (req.url === '/login') {
      sessions.add('abc')
      res.writeHead(200, { 'set-cookie': 'sid=abc; Path=/' })
      return res.end('logged in')
    }
    if (req.url === '/profile') {
      const ok = (req.headers.cookie ?? '').includes('sid=abc') && sessions.has('abc')
      res.writeHead(ok ? 200 : 401)
      return res.end(ok ? 'welcome back' : 'unauthorised')
    }
    res.writeHead(404)
    res.end('nope')
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

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-subset-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    'goal: a signed-in user sees their profile\n'
    + `serve:\n  run: sleep 30\n  ready_url: ${base}/profile\n  reuse_existing: true\n`
    + 'checks:\n'
    + '  - name: login\n    http: {path: /login, expect: {status: 200}}\n'
    + '  - name: profile\n    http: {path: /profile, expect: {status: 200, body_contains: "welcome back"}}\n')
  return dir
}

const resultOf = dir => JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

test('the whole contract passes — the session carries between checks', async () => {
  const dir = project()
  const code = await quiet(() => check({}))

  assert.equal(code, 0, JSON.stringify(resultOf(dir).failures))
})

test('the regression: a subset that skips earlier checks says so', async () => {
  // `--only profile` fails with a bare 401 because `login` never ran. An agent reads that
  // as an auth bug and changes working code.
  const dir = project()
  await quiet(() => check({ only: 'profile' }))
  const r = resultOf(dir)

  assert.equal(r.status, 'failed')
  const warning = r.warnings.find(w => w.includes('earlier in the contract did not run'))
  assert.ok(warning, `no warning about the skipped check: ${JSON.stringify(r.warnings)}`)
  assert.match(warning, /login/, 'it names the check that did not run')
  assert.match(warning, /may be the subset rather than the code/)
})

test('a subset that skips nothing earlier is not warned about', async () => {
  const dir = project()
  await quiet(() => check({ only: 'login' }))

  const r = resultOf(dir)
  assert.equal(r.status, 'partial', 'a subset never claims completion')
  assert.equal(r.warnings.filter(w => w.includes('did not run')).length, 0)
})

test('a full run is never warned about', async () => {
  const dir = project()
  await quiet(() => check({}))

  assert.equal(resultOf(dir).warnings.filter(w => w.includes('did not run')).length, 0)
})

test('the warning reaches the human output too', async () => {
  project()
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { await check({ only: 'profile' }) } finally { console.log = real }

  const out = lines.join('\n').replace(/\s+/g, ' ')
  assert.match(out, /OBSERVED BUT NOT GATED/)
  assert.match(out, /earlier in the contract did not run \(login\)/)
})

test('the warning does not change the verdict', async () => {
  // It explains a failure; it must not manufacture or mask one.
  const dir = project()
  const code = await quiet(() => check({ only: 'login' }))

  assert.equal(code, 0, 'a passing subset still passes despite the caveat machinery')
  assert.equal(resultOf(dir).status, 'partial')
})

test('the regression: a subset needing no app does not start the serve block', async () => {
  // Booting it anyway meant a dev server that would not start failed the run before the
  // selected check ever ran — someone iterating on one unit test blocked by the server.
  const dir = mkdtempSync(join(tmpdir(), 'proof-subset-boot-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    'goal: g\nserve:\n  run: exit 1\n  ready_url: http://127.0.0.1:8299/\n  timeout: 2\n'
    + 'checks:\n  - name: unit tests\n    run: echo ok\n  - name: the api answers\n    http: {path: /}\n')

  const code = await quiet(() => check({ only: 'unit tests' }))
  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

  assert.equal(r.checks['unit tests'], 'passed', 'the selected check ran')
  assert.equal(r.serve_skipped, true)
  assert.ok(!r.results.some(x => x.kind === 'serve'), 'no synthetic serve checks at all')
  assert.equal(code, 0, 'a broken serve block does not fail a subset that does not need it')
})

test('the run says the serve block was skipped rather than leaving a gap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-subset-boot-said-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    'goal: g\nserve:\n  run: exit 1\n  ready_url: http://127.0.0.1:8299/\n  timeout: 2\n'
    + 'checks:\n  - name: unit tests\n    run: echo ok\n  - name: api\n    http: {path: /}\n')

  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { await check({ only: 'unit tests' }) } finally { console.log = real }

  assert.match(lines.join('\n'), /The serve block was not started: nothing selected needs it/)
})

test('a subset that does need the app still boots it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-subset-boot-needed-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    `goal: g\nserve:\n  run: sleep 30\n  ready_url: ${base}\n  reuse_existing: true\n`
    + 'checks:\n  - name: unit tests\n    run: echo ok\n  - name: api\n    http: {path: /profile}\n')

  await quiet(() => check({ only: 'api' }))
  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

  assert.equal(r.serve_skipped, false)
  assert.ok(r.results.some(x => x.name === 'app boots'))
})

test('a full run always starts it, whatever verbs the contract uses', async () => {
  // `app boots`, `app still running` and the log gate are checks in their own right.
  const dir = mkdtempSync(join(tmpdir(), 'proof-subset-boot-full-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    `goal: g\nserve:\n  run: sleep 30\n  ready_url: ${base}\n  reuse_existing: true\n`
    + 'checks:\n  - name: unit tests\n    run: echo ok\n')

  await quiet(() => check({}))
  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

  assert.equal(r.serve_skipped, false)
  assert.ok(r.results.some(x => x.name === 'app boots'), 'a run-only contract still boots its serve block')
})
