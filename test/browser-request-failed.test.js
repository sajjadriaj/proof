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

/**
 * A page whose button fires a request at an origin nothing is listening on. The request
 * leaves the browser and dies in the transport — distinct from one that never fires, and
 * from one that answers with an error status.
 */
const PAGE = dead => `<!doctype html>
<title>Reset</title>
<button id="go">Send reset link</button>
<p id="out"></p>
<script>
document.getElementById('go').addEventListener('click', () => {
  fetch('${dead}/api/password-reset', { method: 'POST' })
    .then(() => { document.getElementById('out').textContent = 'sent' })
    .catch(() => { document.getElementById('out').textContent = 'failed' })
})
</script>`

const serve = dead => new Promise(resolve => {
  const s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE(dead))
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const sandbox = url => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-reqfail-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'the reset request reaches the API',
    checks: [{
      name: 'reset flow',
      timeout: 25,
      browser: {
        base_url: url,
        visit: '/',
        flow: [
          { click: 'Send reset link' },
          { expect_request: { method: 'POST', path: '/api/password-reset', timeout_ms: 4000 } },
        ],
      },
    }],
  }))
  return dir
}

test('a request that fires and dies in transport is reported with its reason', async () => {
  // `expect_request` without `status:` asserts that the request fired, and it did. The
  // outcome is carried as a warning rather than a failure — gating it would be gating
  // something the contract did not ask for. What matters is that the reason is named:
  // "no response" would say the app never tried, which is the opposite of what happened.
  const { s, url } = await serve('http://127.0.0.1:47121')
  const dir = sandbox(url)
  try {
    const code = await quiet(() => check({ json: true }))
    assert.equal(code, 0, 'the request fired, which is all this contract asserted')

    const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
    const warning = r.warnings.find(w => w.includes('/api/password-reset'))

    assert.ok(warning, `no warning about the request: ${JSON.stringify(r.warnings)}`)
    assert.match(warning, /net::|ERR_|refused/i, `no transport reason given: ${warning}`)
    assert.doesNotMatch(warning, /no response/, 'it fired — saying otherwise sends the reader to the click handler')
    assert.match(warning, /add `status:` to expect_request/, 'and says how to gate on it')
  } finally { s.close() }
})

test('with `status:` on the expectation, the same failure is gated', async () => {
  const { s, url } = await serve('http://127.0.0.1:47123')
  const dir = mkdtempSync(join(tmpdir(), 'proof-reqfail-gated-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'the reset request reaches the API',
    checks: [{
      name: 'reset flow',
      timeout: 25,
      browser: {
        base_url: url,
        visit: '/',
        flow: [
          { click: 'Send reset link' },
          { expect_request: { method: 'POST', path: '/api/password-reset', status: 200, timeout_ms: 4000 } },
        ],
      },
    }],
  }))

  try {
    assert.equal(await quiet(() => check({ json: true })), 1, 'asking for a status makes it a gate')
    const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

    assert.match(r.failures[0].expected, /status 200/)
    assert.match(r.failures[0].observed, /net::|ERR_|refused/i, `the reason is in the failure too: ${r.failures[0].observed}`)
  } finally { s.close() }
})

test('the browser evidence records the failed request', async () => {
  const { s, url } = await serve('http://127.0.0.1:47122')
  const dir = sandbox(url)
  try {
    await quiet(() => check({ json: true }))
    const bundle = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/browser-reset-flow.json'), 'utf8'))

    const attempt = bundle.requests.find(q => q.url.includes('/api/password-reset'))
    assert.ok(attempt, `the attempt is not in the request log: ${JSON.stringify(bundle.requests)}`)
    assert.equal(attempt.failed, true)
    assert.equal(attempt.status, null, 'it never got a status')
    assert.ok(attempt.failure, 'and the reason is kept')
  } finally { s.close() }
})

test('a request that answers normally is not marked failed', async () => {
  // Without this, "everything is marked failed" would pass the two tests above.
  const { s, url } = await serve('')
  const dir = sandbox(url)
  try {
    await quiet(() => check({ json: true }))
    const bundle = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/browser-reset-flow.json'), 'utf8'))

    const page = bundle.requests.find(q => q.url === `${url}/`)
    assert.ok(page, 'the page load is in the log')
    assert.equal(page.failed, false)
    assert.equal(page.status, 200)
  } finally { s.close() }
})
