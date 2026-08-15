import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { normalizeFlow, describeStep, matchRequest, fieldSelectors, slug } from '../src/browser.js'
import { check } from '../src/check.js'

test('normalizeFlow hoists visit and rejects unknown verbs', () => {
  assert.deepEqual(normalizeFlow({ visit: '/a', flow: [{ click: 'Go' }] }), [{ visit: '/a' }, { click: 'Go' }])
  assert.throws(() => normalizeFlow({ flow: [{ frobnicate: 1 }] }), /no known verb/)
  assert.throws(() => normalizeFlow({}), /needs a visit or a flow/)
})

test('describeStep renders the spec-style action line', () => {
  assert.equal(describeStep({ click: 'Send reset link' }), 'Click "Send reset link"')
  assert.equal(describeStep({ expect_request: { method: 'post', path: '/api/password-reset' } }), 'Expect POST /api/password-reset')
})

test('matchRequest compares method and pathname, ignoring origin and query', () => {
  const req = { method: 'POST', url: 'http://x.test/api/password-reset?a=1' }
  assert.ok(matchRequest(req, { method: 'post', path: '/api/password-reset' }))
  assert.ok(!matchRequest(req, { method: 'GET', path: '/api/password-reset' }))
  assert.ok(!matchRequest(req, { path: '/api/login' }))
})

test('fieldSelectors passes explicit selectors through untouched', () => {
  assert.deepEqual(fieldSelectors('#email'), ['#email'])
  assert.ok(fieldSelectors('email').includes('[name="email"]'))
  assert.equal(slug('Password reset flow'), 'password-reset-flow')
})

// --- end-to-end against a real browser ---------------------------------------

const PAGE = wired => `<!doctype html><meta charset=utf-8><title>Forgot</title>
<h1>Forgot password</h1>
<form onsubmit="return false">
  <input name="email" type="email" placeholder="Email">
  <button id="send">Send reset link</button>
</form>
<div id="out"></div>
<script>
document.getElementById('send').addEventListener('click', () => {
  ${wired
    ? `fetch('/api/password-reset', {method:'POST'}).then(() => { document.getElementById('out').textContent = 'Check your email' })`
    : `resetPassword()` /* the bug: function never defined */}
})
</script>`

const serve = wired => new Promise(resolve => {
  const s = createServer((req, res) => {
    if (req.url.startsWith('/api/password-reset')) { res.writeHead(200); return res.end('{}') }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE(wired))
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const sandboxSpec = (url, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-browser-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'Password reset works end-to-end',
    checks: [{
      name: 'password reset flow',
      timeout: 20,
      browser: {
        base_url: url,
        visit: '/forgot-password',
        flow: [
          { fill: { email: 'user@example.com' } },
          { click: 'Send reset link' },
          { expect_request: { method: 'POST', path: '/api/password-reset', timeout_ms: 2000 } },
          { expect_text: 'Check your email' },
        ],
        ...extra,
      },
    }],
  }))
  return dir
}

test('browser flow passes against a wired-up page', async () => {
  const { s, url } = await serve(true)
  const dir = sandboxSpec(url)
  try {
    assert.equal(await check({ json: true }), 0)
    const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
    assert.equal(r.checks['password reset flow'], 'passed')
    assert.ok(existsSync(join(dir, '.proof/runs/0001/screenshots/password-reset-flow.png')))
  } finally { s.close() }
})

test('a button that fires no request fails with the console error that explains it', async () => {
  const { s, url } = await serve(false)
  const dir = sandboxSpec(url)
  try {
    assert.equal(await check({ json: true }), 1)
    const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
    const [f] = r.failures

    assert.equal(f.check, 'password reset flow')
    assert.equal(f.expected, 'POST /api/password-reset')
    assert.match(f.observed, /Expect POST \/api\/password-reset/)
    assert.match(f.observed, /no network request was generated/)
    assert.match(f.output, /resetPassword is not (a function|defined)/)

    const bundle = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/browser-password-reset-flow.json'), 'utf8'))
    assert.ok(bundle.requests.length > 0, 'page load requests are still recorded')
    assert.ok(bundle.consoleErrors.length > 0)
    assert.ok(existsSync(bundle.screenshot))
  } finally { s.close() }
})

test('expect_no_console_errors gates an otherwise passing flow', async () => {
  const { s, url } = await serve(true)
  sandboxSpec(url, { expect_no_console_errors: true, flow: [{ visit: '/x' }] })
  try {
    // wired page logs no errors, so the gate passes
    assert.equal(await check({ json: true }), 0)
  } finally { s.close() }
})
