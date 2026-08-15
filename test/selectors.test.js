import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'

// A newsletter box whose placeholder mentions "email" sits BEFORE the real login field,
// and a paragraph mentions the button label BEFORE the real button. Both decoys win on
// DOM order, so anything resolving by document position targets the wrong element.
const PAGE = `<!doctype html><meta charset=utf-8><title>t</title>
<form id="newsletter"><input id="newsletter-input" placeholder="Your email address"></form>
<p>Click Send reset link below to continue.</p>
<form id="login" onsubmit="return false">
  <input id="login-input" name="email">
  <button id="real-button">Send reset link</button>
</form>
<div id="out"></div>
<script>
document.getElementById('real-button').addEventListener('click', () => {
  fetch('/api/password-reset', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify({ email: document.getElementById('login-input').value }),
  }).then(() => { document.getElementById('out').textContent = 'Check your email' })
})
</script>`

const serve = () => new Promise(resolve => {
  const seen = []
  const s = createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      let body = ''
      req.on('data', d => { body += d })
      return req.on('end', () => { seen.push(body); res.writeHead(200); res.end('{}') })
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, seen, url: `http://127.0.0.1:${s.address().port}` }))
})

const runFlow = async (url, flow) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-selectors-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'selector priority',
    checks: [{ name: 'flow', timeout: 8, browser: { base_url: url, visit: '/', flow } }],
  }))
  const real = console.log
  console.log = () => {}
  try {
    const code = await check({ json: true })
    return {
      code,
      result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
      bundle: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/browser-flow.json'), 'utf8')),
    }
  } finally { console.log = real }
}

test('the regression: fill and click target the real field and button, not earlier decoys', async () => {
  const { s, seen, url } = await serve()
  try {
    const { code, bundle } = await runFlow(url, [
      { fill: { email: 'user@example.com' } },
      { click: 'Send reset link' },
      { expect_request: { method: 'POST', path: '/api/password-reset', timeout_ms: 3000 } },
      { expect_text: 'Check your email' },
    ])

    assert.equal(code, 0)
    // the decoys would have produced an empty body and no request at all
    assert.deepEqual(JSON.parse(seen[0]), { email: 'user@example.com' })

    assert.deepEqual(bundle.resolved.map(r => r.matched_by), ['[name="email"]', 'button role'])
  } finally { s.close() }
})

test('an explicit selector still wins outright', async () => {
  const { s, seen, url } = await serve()
  try {
    const { code, bundle } = await runFlow(url, [
      { fill: { '#newsletter-input': 'nope@example.com', '[name="email"]': 'user@example.com' } },
      { click: 'Send reset link' },
      { expect_request: { method: 'POST', path: '/api/password-reset', timeout_ms: 3000 } },
    ])
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(seen[0]), { email: 'user@example.com' })
    assert.deepEqual(bundle.resolved.map(r => r.matched_by), ['#newsletter-input', '[name="email"]', 'button role'])
  } finally { s.close() }
})

test('a field that does not exist names what was tried instead of timing out silently', async () => {
  const { s, url } = await serve()
  try {
    const { code, result } = await runFlow(url, [{ fill: { nonexistent_field: 'x' } }])
    assert.equal(code, 1)
    assert.match(result.failures[0].observed, /no element found for field "nonexistent_field"/)
    assert.match(result.failures[0].observed, /tried \[name="nonexistent_field"\]/)
  } finally { s.close() }
})
