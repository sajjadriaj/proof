import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { validateSpec } from '../src/validate.js'

const PAGE = `<!doctype html><meta charset=utf-8><title>t</title>
<button id=go>Send reset link</button>
<script>
document.getElementById('go').addEventListener('click', () => {
  fetch('/api/password-reset', {method:'POST'}).catch(() => {})
})
</script>`

const serve = status => new Promise(resolve => {
  const s = createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      res.writeHead(status, { 'content-type': 'application/json' })
      return res.end(status >= 400 ? '{"error":"database unavailable"}' : '{"ok":true}')
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async (url, expectRequest) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-outcome-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'requesting a password reset calls the API',
    checks: [{
      name: 'reset flow',
      timeout: 20,
      browser: {
        base_url: url,
        visit: '/forgot-password',
        flow: [{ click: 'Send reset link' }, { expect_request: expectRequest }],
      },
    }],
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
      bundle: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/browser-reset-flow.json'), 'utf8')),
    }
  } finally { console.log = real }
}

const WANT = { method: 'POST', path: '/api/password-reset', timeout_ms: 3000 }

test('the regression: a request that fired and then failed is reported', async () => {
  const { s, url } = await serve(500)
  try {
    const { code, out, result } = await run(url, WANT)

    assert.equal(code, 0, 'still a pass — the request was made, which is what was asserted')
    assert.ok(result.warnings.some(w => /\/api\/password-reset was sent but answered status 500/.test(w)))
    assert.match(out, /OBSERVED BUT NOT GATED/)
    // warnings wrap, so read them the way a person does
    assert.match(out.replace(/\s+/g, ' '), /add `status:` to expect_request/)
  } finally { s.close() }
})

test('asserting the status turns that into a real failure', async () => {
  const { s, url } = await serve(500)
  try {
    const { code, result } = await run(url, { ...WANT, status: 200 })
    assert.equal(code, 1)
    assert.equal(result.failures[0].expected, 'status 200')
    assert.equal(result.failures[0].observed, 'Expect POST /api/password-reset → status 500')
  } finally { s.close() }
})

test('a healthy response satisfies the status assertion and warns about nothing', async () => {
  const { s, url } = await serve(200)
  try {
    const { code, result } = await run(url, { ...WANT, status: 200 })
    assert.equal(code, 0)
    assert.deepEqual(result.warnings, [])
  } finally { s.close() }
})

test('the response status is recorded in the evidence bundle either way', async () => {
  const { s, url } = await serve(500)
  try {
    const { bundle } = await run(url, WANT)
    const api = bundle.requests.find(r => r.url.includes('/api/password-reset'))
    assert.equal(api.status, 500)
    assert.equal(api.failed, false)
  } finally { s.close() }
})

test('a 2xx response produces no warning without an explicit status', async () => {
  const { s, url } = await serve(200)
  try {
    const { code, result } = await run(url, WANT)
    assert.equal(code, 0)
    assert.deepEqual(result.warnings, [])
  } finally { s.close() }
})

test('expect_request.status is type-checked', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [{
      name: 'a',
      browser: { base_url: 'http://x.test', visit: '/', flow: [{ expect_request: { path: '/a', status: '200' } }] },
    }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /expect_request › status: must be a number, got string/)
})
