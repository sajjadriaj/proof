import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

// /login sets a session; /me requires it; /logout clears it
const serve = () => new Promise(resolve => {
  const seen = []
  const s = createServer((req, res) => {
    const url = req.url.split('?')[0]
    seen.push({ url, cookie: req.headers.cookie ?? null })
    const json = { 'content-type': 'application/json' }

    if (url === '/login') {
      res.writeHead(200, { ...json, 'set-cookie': ['sid=abc123; Path=/', 'theme=dark; Path=/'] })
      return res.end('{"ok":true}')
    }
    if (url === '/logout') {
      res.writeHead(200, { ...json, 'set-cookie': 'sid=; Path=/; Max-Age=0' })
      return res.end('{"ok":true}')
    }
    if (url === '/me') {
      const authed = (req.headers.cookie ?? '').includes('sid=abc123')
      res.writeHead(authed ? 200 : 401, json)
      return res.end(authed ? '{"user":"buyer"}' : '{"error":"unauthenticated"}')
    }
    res.writeHead(200, json)
    res.end('{}')
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, seen, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async (url, checks) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-session-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'a signed-in user can read their profile',
    checks: checks.map(c => ({ ...c, http: { ...c.http, url: `${url}${c.http.path}`, path: undefined } })),
  }))
  const code = await quiet(() => check({ json: true }))
  return { code, result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')) }
}

test('the regression: a session established by one check is carried to the next', async () => {
  const { s, url } = await serve()
  try {
    const { code, result } = await run(url, [
      { name: 'log in', http: { method: 'POST', path: '/login', expect: { status: 200 } } },
      { name: 'read profile', http: { path: '/me', expect: { status: 200, json: { user: 'buyer' } } } },
    ])
    assert.equal(code, 0)
    assert.equal(result.checks['read profile'], 'passed')
  } finally { s.close() }
})

test('cookie names are recorded as evidence; values never are', async () => {
  const { s, url } = await serve()
  try {
    const { result } = await run(url, [
      { name: 'log in', http: { method: 'POST', path: '/login', expect: { status: 200 } } },
    ])
    assert.deepEqual(result.results[0].cookies_set, ['sid', 'theme'])
    assert.doesNotMatch(JSON.stringify(result), /abc123/, 'a session value is a credential')
  } finally { s.close() }
})

test('a cleared cookie is dropped, so a logged-out check sees no session', async () => {
  const { s, url } = await serve()
  try {
    const { code, result } = await run(url, [
      { name: 'log in', http: { method: 'POST', path: '/login', expect: { status: 200 } } },
      { name: 'log out', http: { method: 'POST', path: '/logout', expect: { status: 200 } } },
      { name: 'profile is now refused', http: { path: '/me', expect: { status: 401 } } },
    ])
    assert.equal(code, 0, 'the 401 after logout is what the contract asked for')
    assert.equal(result.checks['profile is now refused'], 'passed')
  } finally { s.close() }
})

test('a check that sets its own Cookie header keeps control of it', async () => {
  const { s, seen, url } = await serve()
  try {
    await run(url, [
      { name: 'log in', http: { method: 'POST', path: '/login', expect: { status: 200 } } },
      { name: 'explicit cookie', http: { path: '/me', headers: { cookie: 'sid=someone-else' }, expect: { status: 401 } } },
    ])
    const profileRequest = seen.find(r => r.url === '/me')
    assert.equal(profileRequest.cookie, 'sid=someone-else', 'the contract wins over the jar')
  } finally { s.close() }
})

test('the jar does not leak between runs', async () => {
  const { s, url } = await serve()
  try {
    await run(url, [{ name: 'log in', http: { method: 'POST', path: '/login', expect: { status: 200 } } }])

    // a fresh run, no login: the profile must still be refused
    const { code } = await run(url, [
      { name: 'read profile', http: { path: '/me', expect: { status: 200 } } },
    ])
    assert.equal(code, 1, 'each run starts with no session')
  } finally { s.close() }
})

test('the regression: a session cookie does not cross to another origin', async () => {
  // A single jar sent the cookie set by your app to every other host the contract touched —
  // a payment sandbox, a webhook endpoint, a status page — handing a credential somewhere
  // the author never meant it to go. A browser would not do this.
  const http = await import('node:http')
  const received = []

  const auth = http.createServer((q, s) => {
    s.writeHead(200, { 'set-cookie': 'session=secret-token; Path=/' })
    s.end('logged in')
  })
  const other = http.createServer((q, s) => {
    if (q.url === '/collect') received.push(q.headers.cookie ?? '(none)')
    s.writeHead(200)
    s.end('ok')
  })
  await new Promise(r => auth.listen(0, '127.0.0.1', r))
  await new Promise(r => other.listen(0, '127.0.0.1', r))

  const authUrl = `http://127.0.0.1:${auth.address().port}`
  const otherUrl = `http://127.0.0.1:${other.address().port}`

  const dir = mkdtempSync(join(tmpdir(), 'proof-xorigin-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    `goal: g\nserve:\n  run: sleep 30\n  ready_url: ${authUrl}/\n  reuse_existing: true\n`
    + `checks:\n  - name: log in\n    http: {url: "${authUrl}/login"}\n`
    + `  - name: third party\n    http: {url: "${otherUrl}/collect"}\n`)

  try {
    const real = console.log
    console.log = () => {}
    try { await check({ json: true }) } finally { console.log = real }

    assert.deepEqual(received, ['(none)'], `the third party received: ${JSON.stringify(received)}`)
  } finally {
    auth.close()
    other.close()
  }
})

test('and still travels within its own origin', async () => {
  // The fix must not break the session sharing the feature exists for.
  const http = await import('node:http')
  const seen = []
  const app = http.createServer((q, s) => {
    if (q.url === '/login') {
      s.writeHead(200, { 'set-cookie': 'session=abc; Path=/' })
      return s.end('ok')
    }
    if (q.url === '/profile') seen.push(q.headers.cookie ?? '(none)')
    s.writeHead(200)
    s.end('ok')
  })
  await new Promise(r => app.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${app.address().port}`

  const dir = mkdtempSync(join(tmpdir(), 'proof-sameorigin-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    `goal: g\nserve:\n  run: sleep 30\n  ready_url: ${url}/\n  reuse_existing: true\n`
    + 'checks:\n  - name: log in\n    http: {path: /login}\n  - name: profile\n    http: {path: /profile}\n')

  try {
    const real = console.log
    console.log = () => {}
    try { await check({ json: true }) } finally { console.log = real }

    assert.deepEqual(seen, ['session=abc'], 'the session is still shared within one origin')
  } finally { app.close() }
})
