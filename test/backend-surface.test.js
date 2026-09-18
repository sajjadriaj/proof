import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHttp } from '../src/check.js'
import { validateSpec } from '../src/validate.js'

// Two things a backend contract has to say that it could not say. A response header carries
// half of what an API promises — where the thing it created lives, whether the session cookie
// is safe to hand a browser, what it encoded the body as — and work an app does *after* it
// answers is invisible to a single request.

const serve = handler => new Promise(resolve => {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(r => server.close(r)),
  }))
})

const ctx = base => ({ baseUrl: base, runDir: mkdtempSync(join(tmpdir(), 'proof-backend-')), cookies: new Map() })
const spec = check => ({ goal: 'g', serve: { run: 'x', ready_url: 'http://localhost:3000' }, checks: [check] })

// --- response headers --------------------------------------------------------

test('a header is asserted as a substring, so a charset or a flag cannot break the check', async () => {
  const { base, close } = await serve((q, s) => {
    s.writeHead(201, {
      'content-type': 'application/json; charset=utf-8',
      location: '/orders/17',
      'cache-control': 'no-store, max-age=0',
    })
    s.end('{}')
  })

  try {
    const r = await runHttp({
      name: 'created',
      http: { path: '/orders', expect: { status: 201, headers: { location: '/orders/', 'content-type': 'application/json', 'cache-control': 'no-store' } } },
    }, ctx(base))
    assert.equal(r.status, 'passed', r.observed)
  } finally { await close() }
})

test('the security assertion this exists for: HttpOnly on the session cookie', async () => {
  const { base, close } = await serve((q, s) => {
    s.writeHead(200, { 'set-cookie': ['other=1; Path=/', 'sid=abc; HttpOnly; SameSite=Strict'] })
    s.end('{}')
  })

  try {
    const ok = await runHttp({ name: 'login', http: { path: '/login', expect: { headers: { 'set-cookie': 'HttpOnly' } } } }, ctx(base))
    assert.equal(ok.status, 'passed', ok.observed)

    const missing = await runHttp({ name: 'login', http: { path: '/login', expect: { headers: { 'set-cookie': 'Secure' } } } }, ctx(base))
    assert.equal(missing.status, 'failed')
    assert.match(missing.expected, /header set-cookie contains "Secure"/)
  } finally { await close() }
})

test('several Set-Cookie headers stay several, so a flag on one is not read as a flag on another', async () => {
  // Joined into one comma-separated value, `tracker=1` would appear to carry the HttpOnly
  // that belongs to the session cookie — and that is the assertion people write here.
  const { base, close } = await serve((q, s) => {
    s.writeHead(200, { 'set-cookie': ['sid=abc; HttpOnly', 'tracker=1; Path=/'] })
    s.end('{}')
  })

  try {
    const r = await runHttp({ name: 'c', http: { path: '/', expect: { headers: { 'set-cookie': 'tracker=1; Path=/; HttpOnly' } } } }, ctx(base))
    assert.equal(r.status, 'failed', 'the flag belongs to the other cookie')
  } finally { await close() }
})

test('an absent header is named rather than reported as a mismatch', async () => {
  const { base, close } = await serve((q, s) => { s.writeHead(200); s.end('{}') })
  try {
    const r = await runHttp({ name: 'c', http: { path: '/', expect: { headers: { 'x-request-id': 'req-' } } } }, ctx(base))
    assert.equal(r.status, 'failed')
    assert.match(r.observed, /no x-request-id header/)
  } finally { await close() }
})

test('the header name is matched however it is spelled in the contract', async () => {
  const { base, close } = await serve((q, s) => { s.writeHead(200, { 'x-total-count': '42' }); s.end('{}') })
  try {
    const r = await runHttp({ name: 'c', http: { path: '/', expect: { headers: { 'X-Total-Count': '42' } } } }, ctx(base))
    assert.equal(r.status, 'passed', r.observed)
  } finally { await close() }
})

test('a header assertion that asserts nothing is refused', () => {
  assert.match(validateSpec(spec({ name: 'c', http: { path: '/a', expect: { headers: { etag: '' } } } }))[0],
    /is empty, so it matches anything/)
  assert.match(validateSpec(spec({ name: 'c', http: { path: '/a', expect: { headers: { status: 200 } } } }))[0],
    /must be a string/)
  assert.match(validateSpec(spec({ name: 'c', http: { path: '/a', expect: { headers: 'location' } } }))[0],
    /must be a mapping of header name to the text it must contain/)
})

// --- concurrency -------------------------------------------------------------

test('the classic race: check-then-set across an await lets every request win', async () => {
  // A sequence of requests can never show this. Both succeed, and asking twice in a row
  // gives 201 then 409 — exactly the answer a broken lock also gives.
  const build = locked => {
    let claimed = false
    return async (q, s) => {
      if (locked) {
        if (claimed) { s.writeHead(409); return s.end('{}') }
        claimed = true
        s.writeHead(201); return s.end('{}')
      }
      const seen = claimed
      await new Promise(r => setTimeout(r, 20))
      if (seen) { s.writeHead(409); return s.end('{}') }
      claimed = true
      s.writeHead(201); s.end('{}')
    }
  }
  const check = { name: 'claim', http: { method: 'POST', path: '/claim', concurrent: 5, expect: { statuses: { 201: 1, 409: 4 } } } }

  const broken = await serve(build(false))
  try {
    const r = await runHttp(check, ctx(broken.base))
    assert.equal(r.status, 'failed')
    assert.equal(r.expected, '5 at once: 1×201, 4×409')
    assert.equal(r.observed, '5 at once: 5×201')
  } finally { await broken.close() }

  const fixed = await serve(build(true))
  try {
    const r = await runHttp(check, ctx(fixed.base))
    assert.equal(r.status, 'passed', r.observed)
    assert.equal(r.observed, '5 at once: 1×201, 4×409')
  } finally { await fixed.close() }
})

test('a request that never completes is reported as that, not folded into the tally', async () => {
  const { base, close } = await serve(() => { /* never answers */ })
  try {
    const r = await runHttp({
      name: 'c',
      timeout: 1,
      http: { path: '/', concurrent: 2, expect: { statuses: { 200: 2 } } },
    }, ctx(base))
    assert.equal(r.status, 'failed')
    assert.match(r.observed, /2 of 2 request\(s\) never completed/)
  } finally { await close() }
})

test('the tally has to account for every request', () => {
  // The ones it says nothing about are exactly where a broken lock shows up.
  const problems = validateSpec(spec({ name: 'c', http: { path: '/a', concurrent: 5, expect: { statuses: { 201: 1, 409: 2 } } } }))
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /accounts for 3 request\(s\) but 5 are sent/)
})

test('concurrent and statuses each require the other', () => {
  assert.match(validateSpec(spec({ name: 'c', http: { path: '/a', concurrent: 3 } }))[0],
    /statuses: needed with `concurrent`/)
  assert.match(validateSpec(spec({ name: 'c', http: { path: '/a', expect: { statuses: { 200: 1 } } } }))[0],
    /needs `concurrent: <n>`/)
})

test('a single-response assertion alongside concurrent is refused, never applied to one of them', () => {
  const problems = validateSpec(spec({
    name: 'c',
    http: { path: '/a', concurrent: 3, expect: { statuses: { 200: 3 }, body_contains: 'ok' } },
  }))
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /body_contains: cannot be asserted alongside `concurrent`/)
  assert.match(problems[0], /Assert the outcome with `statuses`/)
})

test('capture is refused with concurrent, since there is no single response', () => {
  assert.match(validateSpec(spec({
    name: 'c',
    http: { path: '/a', concurrent: 3, expect: { statuses: { 200: 3 } } },
    capture: { id: 'json.id' },
  }))[0], /`concurrent` and `capture` cannot both hold/)
})

test('one request is not a race, and a flood is not a check', () => {
  assert.match(validateSpec(spec({ name: 'c', http: { path: '/a', concurrent: 1, expect: { statuses: { 200: 1 } } } }))[0],
    /must be a whole number of 2 or more/)
  assert.match(validateSpec(spec({ name: 'c', http: { path: '/a', concurrent: 500, expect: { statuses: { 200: 500 } } } }))[0],
    /at most 50/)
})

// --- retry -------------------------------------------------------------------

test('a check can wait for work the app does after it answers', async () => {
  // A queued job, a webhook, a read replica catching up. Without this the only way to verify
  // any of it was a `run:` check shelling out to a sleep loop.
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { execFile } = await import('node:child_process')
  const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')
  // Async, not spawnSync: the fixture server below lives in this process, and blocking the
  // event loop would stop it answering the very requests the check is retrying.
  const run = cwd => new Promise(resolve => {
    execFile(process.execPath, [CLI, 'check'], { cwd }, (e, stdout, stderr) => resolve(stdout + stderr))
  })

  let ready = false
  setTimeout(() => { ready = true }, 700).unref()
  const { base, close } = await serve((q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' })
    s.end(JSON.stringify({ state: ready ? 'done' : 'running' }))
  })

  const dir = mkdtempSync(join(tmpdir(), 'proof-retry-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), `goal: the worker drains the queue
checks:
  - name: one request cannot see it
    http: {url: "${base}/jobs/1", expect: {json: {state: done}}}
    skip: "asserted below instead"
  - name: the worker finishes it
    http: {url: "${base}/jobs/1", expect: {status: 200, json: {state: done}}}
    retry_for_ms: 8000
  - name: and one that never finishes says how long it waited
    http: {url: "${base}/jobs/1", expect: {json: {state: never-happens}}}
    retry_for_ms: 700
`)

  try {
    const out = await run(dir)
    assert.match(out, /the worker finishes it\s+PASS/, out)
    assert.match(out.replace(/\s+/g, ' '), /still failing after 700ms \(\d+ attempt\(s\)\)/)
    // the assertion records that it waited, so a run can be read back
    assert.match(out.replace(/\s+/g, ' '), /and one that never finishes/)
  } finally { await close() }
})

test('retry_for_ms and expect_under_ms contradict each other and are refused together', () => {
  const problems = validateSpec(spec({ name: 'c', run: 'true', retry_for_ms: 1000, expect_under_ms: 100 }))
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /contradict each other/)
})

test('retry_for_ms must be a positive number', () => {
  assert.match(validateSpec(spec({ name: 'c', run: 'true', retry_for_ms: 0 }))[0], /must be greater than 0/)
  assert.match(validateSpec(spec({ name: 'c', run: 'true', retry_for_ms: '5s' }))[0], /must be a number/)
})
