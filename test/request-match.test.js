import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { matchRequest } from '../src/browser.js'
import { validateSpec } from '../src/validate.js'
import { check } from '../src/check.js'

const req = (method, url) => ({ method, url: `http://x.test${url}` })

test('the regression: a neighbouring path no longer satisfies the assertion', () => {
  assert.equal(matchRequest(req('POST', '/api/user-preferences'), { method: 'POST', path: '/api/user' }), false)
  assert.equal(matchRequest(req('POST', '/v2/api/admin/users'), { method: 'POST', path: '/api/admin' }), false)
  assert.equal(matchRequest(req('POST', '/api/user'), { method: 'POST', path: '/api/user' }), true)
})

test('query strings and origin are ignored, method still matters', () => {
  assert.equal(matchRequest(req('POST', '/api/reset?token=abc'), { method: 'post', path: '/api/reset' }), true)
  assert.equal(matchRequest(req('GET', '/api/reset'), { method: 'POST', path: '/api/reset' }), false)
})

test('path_matches covers dynamic segments', () => {
  const want = { method: 'PATCH', path_matches: '^/api/users/\\d+$' }
  assert.equal(matchRequest(req('PATCH', '/api/users/42'), want), true)
  assert.equal(matchRequest(req('PATCH', '/api/users/42/roles'), want), false)
  assert.equal(matchRequest(req('PATCH', '/api/users/abc'), want), false)
})

test('expect_request needs something to match, and a bad regex is a contract error', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [{
      name: 'a',
      browser: { visit: '/', flow: [{ expect_request: { method: 'POST' } }, { expect_request: { path_matches: '[' } }] },
    }],
  })
  assert.match(p.join('\n'), /needs a `path`, `path_matches` or `url` to match/)
  assert.match(p.join('\n'), /path_matches: invalid regex/)
})

// --- against a real browser ---------------------------------------------------

const PAGE = `<!doctype html><meta charset=utf-8><title>t</title>
<button id="go">Save</button>
<div style="display:none">Saved successfully</div>
<div id="later"></div>
<script>
document.getElementById('go').addEventListener('click', () => {
  fetch('/api/user-preferences', {method:'POST'}).then(() => {
    setTimeout(() => { document.getElementById('later').textContent = 'Saved successfully' }, 200)
  })
})
</script>`

const serve = () => new Promise(resolve => {
  const s = createServer((req, res) => {
    if (req.url.startsWith('/api/')) { res.writeHead(200); return res.end('{}') }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const runFlow = async (url, flow) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-reqmatch-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'request matching',
    checks: [{ name: 'flow', timeout: 20, browser: { base_url: url, visit: '/', flow } }],
  }))
  const real = console.log
  console.log = () => {}
  try {
    const code = await check({ json: true })
    return { code, result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')) }
  } finally { console.log = real }
}

test('asserting the wrong endpoint now fails, and names what was actually called', async () => {
  const { s, url } = await serve()
  try {
    const { code, result } = await runFlow(url, [
      { click: 'Save' },
      { expect_request: { method: 'POST', path: '/api/user', timeout_ms: 2000 } },
    ])
    assert.equal(code, 1)
    assert.match(result.failures[0].observed, /no matching request/)
    assert.match(result.failures[0].observed, /\/api\/user-preferences/, 'the real request is named in the failure')
  } finally { s.close() }
})

test('the correct endpoint passes, and expect_text sees past a hidden duplicate', async () => {
  const { s, url } = await serve()
  try {
    const { code } = await runFlow(url, [
      { click: 'Save' },
      { expect_request: { method: 'POST', path: '/api/user-preferences', timeout_ms: 2000 } },
      { expect_text: 'Saved successfully' },
    ])
    assert.equal(code, 0, 'the visible copy satisfies expect_text even though a hidden one comes first in the DOM')
  } finally { s.close() }
})
