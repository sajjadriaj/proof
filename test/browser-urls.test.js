import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { urlMatches } from '../src/browser.js'
import { validateSpec } from '../src/validate.js'
import { check } from '../src/check.js'

test('urlMatches compares exactly, ignoring origin', () => {
  assert.equal(urlMatches('http://x.test/dashboard', '/dashboard'), true)
  assert.equal(urlMatches('http://x.test/dashboard-error', '/dashboard'), false)
  assert.equal(urlMatches('http://x.test/dashboard?welcome=1', '/dashboard'), true, 'query ignored unless asserted')
  assert.equal(urlMatches('http://x.test/dashboard?welcome=1', '/dashboard?welcome=1'), true)
  assert.equal(urlMatches('http://x.test/dashboard?welcome=2', '/dashboard?welcome=1'), false)
  assert.equal(urlMatches('http://x.test/a', 'http://x.test/a'), true)
  assert.equal(urlMatches('http://y.test/a', 'http://x.test/a'), false)
})

test('a bare fragment is a contract error, since matching is exact', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [{ name: 'a', browser: { base_url: 'http://x.test', visit: '/', flow: [{ expect_url: 'dashboard' }] } }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /expect_url: must be a path .* or an absolute URL/)
})

const serve = () => new Promise(resolve => {
  const html = b => ({ 'content-type': 'text/html' })
  const s = createServer((req, res) => {
    if (req.url === '/admin') { res.writeHead(302, { location: '/login' }); return res.end() }
    if (req.url === '/login') { res.writeHead(200, html()); return res.end('<h1>Sign in</h1>') }
    if (req.url === '/dashboard-error') { res.writeHead(200, html()); return res.end('<h1>Went wrong</h1>') }
    res.writeHead(200, html())
    res.end('<h1>Home</h1><a id=go href="/dashboard-error">go</a>')
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async (url, browser) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-burl-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'browser urls',
    checks: [{ name: 'flow', timeout: 20, browser: { base_url: url, ...browser } }],
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

test('the regression: expect_url is no longer satisfied by a longer path', async () => {
  const { s, url } = await serve()
  try {
    const { code, result } = await run(url, { visit: '/', flow: [{ click: 'go' }, { expect_url: '/dashboard' }] })
    assert.equal(code, 1, '/dashboard-error must not satisfy /dashboard')
    assert.match(result.failures[0].observed, /URL is .*\/dashboard-error/)
  } finally { s.close() }
})

test('the matching URL still passes', async () => {
  const { s, url } = await serve()
  try {
    const { code } = await run(url, { visit: '/', flow: [{ click: 'go' }, { expect_url: '/dashboard-error' }] })
    assert.equal(code, 0)
  } finally { s.close() }
})

test('the regression: a visit that redirects is reported, not passed silently', async () => {
  const { s, url } = await serve()
  try {
    const { code, out, result } = await run(url, { visit: '/admin' })
    assert.equal(code, 0, 'still a pass, as with the http verb')
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /\/admin did not load directly — it redirected to .*\/login/)
    assert.match(out, /OBSERVED BUT NOT GATED/)
  } finally { s.close() }
})

test('a direct load carries no redirect warning', async () => {
  const { s, url } = await serve()
  try {
    const { code, result } = await run(url, { visit: '/login' })
    assert.equal(code, 0)
    assert.deepEqual(result.warnings, [])
  } finally { s.close() }
})
