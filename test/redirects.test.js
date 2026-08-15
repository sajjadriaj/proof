import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { validateSpec } from '../src/validate.js'

// /admin bounces to a sign-in page that answers 200
const serve = () => new Promise(resolve => {
  const s = createServer((req, res) => {
    if (req.url === '/admin') { res.writeHead(302, { location: '/login' }); return res.end() }
    if (req.url === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>Sign in</h1>') }
    res.writeHead(200); res.end('ok')
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async (base, http) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-redirect-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'the admin dashboard is reachable',
    checks: [{ name: 'admin dashboard', http: { url: `${base}${http.path ?? ''}`, ...http, path: undefined } }],
  }))
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try {
    const code = await check({})
    return {
      code,
      out: lines.join('\n'),
      result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
    }
  } finally { console.log = real }
}

test('the regression: a check satisfied by a redirect says so instead of passing silently', async () => {
  const { s, url } = await serve()
  try {
    const { code, out, result } = await run(url, { path: '/admin', expect: { status: 200 } })

    assert.equal(code, 0, 'still a pass — many APIs redirect legitimately')
    assert.match(result.results[0].observed, /redirected to .*\/login/)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /\/admin did not answer directly/)
    assert.match(out, /OBSERVED BUT NOT GATED/)
  } finally { s.close() }
})

test('follow_redirects: false makes the redirect itself assertable', async () => {
  const { s, url } = await serve()
  try {
    const { code, result } = await run(url, {
      path: '/admin',
      follow_redirects: false,
      expect: { status: 302 },
    })
    assert.equal(code, 0)
    assert.deepEqual(result.warnings, [], 'not a redirect surprise when you asked for the 302')
  } finally { s.close() }
})

test('without following, a contract still demanding 200 fails as it should', async () => {
  const { s, url } = await serve()
  try {
    const { code, result } = await run(url, {
      path: '/admin',
      follow_redirects: false,
      expect: { status: 200 },
    })
    assert.equal(code, 1)
    assert.match(result.failures[0].observed, /status 302/)
  } finally { s.close() }
})

test('a direct answer carries no redirect noise', async () => {
  const { s, url } = await serve()
  try {
    const { code, result } = await run(url, { path: '/login', expect: { status: 200 } })
    assert.equal(code, 0)
    assert.deepEqual(result.warnings, [])
    assert.doesNotMatch(result.results[0].observed, /redirected/)
  } finally { s.close() }
})

test('a failing status names the redirect too, so the diagnosis is not misleading', async () => {
  const { s, url } = await serve()
  try {
    const { result } = await run(url, { path: '/admin', expect: { status: 404 } })
    assert.match(result.failures[0].observed, /status 200 \(redirected to .*\/login\)/)
  } finally { s.close() }
})

test('follow_redirects is type-checked like every other assertion-bearing key', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [{ name: 'a', http: { url: 'http://x.test/', follow_redirects: 'no' } }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /follow_redirects: must be a boolean, got string/)
})
