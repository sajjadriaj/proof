import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { validateSpec } from '../src/validate.js'
import { check } from '../src/check.js'

const sandbox = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-baseurl-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(contract))
  return dir
}

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

test('the regression: a relative path with no serve block is a contract error', () => {
  const p = validateSpec({
    goal: 'no serve block',
    checks: [{ name: 'api works', http: { path: '/api/thing', expect: { status: 200 } } }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /http › path: relative, but the spec has no `serve.ready_url`/)
  assert.match(p[0], /add a serve block, a browser.base_url, or use an absolute URL/)
})

test('proof check refuses to run such a contract instead of hitting a stray local server', async () => {
  sandbox({ goal: 'no serve', checks: [{ name: 'api', http: { path: '/api/thing', expect: { status: 200 } } }] })
  await assert.rejects(() => check({ json: true }), /no `serve.ready_url`/)
})

test('a relative browser visit with no base is caught the same way', () => {
  const p = validateSpec({
    goal: 'no serve block',
    checks: [{ name: 'flow', browser: { visit: '/login', flow: [{ click: 'Go' }] } }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /browser › visit: relative, but the spec has no `serve.ready_url`/)
})

test('an absolute url, a browser base_url, or a serve block each satisfy it', () => {
  assert.deepEqual(validateSpec({
    goal: 'absolute url',
    checks: [{ name: 'a', http: { url: 'https://api.example.com/thing' } }],
  }), [])

  assert.deepEqual(validateSpec({
    goal: 'browser base',
    checks: [{ name: 'a', browser: { base_url: 'http://127.0.0.1:9', visit: '/login' } }],
  }), [])

  assert.deepEqual(validateSpec({
    goal: 'serve block',
    serve: { run: 'npm run dev', ready_url: 'http://localhost:3000' },
    checks: [
      { name: 'a', http: { path: '/api/thing' } },
      { name: 'b', browser: { visit: '/login' } },
    ],
  }), [])

  assert.deepEqual(validateSpec({
    goal: 'absolute visit needs no base',
    checks: [{ name: 'a', browser: { visit: 'https://example.com/login' } }],
  }), [])
})

test('a relative http.url is rejected — that key is for absolute URLs', () => {
  const p = validateSpec({ goal: 'g', checks: [{ name: 'a', http: { url: '/api/thing' } }] })
  assert.equal(p.length, 1)
  assert.match(p[0], /http › url: must be absolute .* use `path` for a relative one/)
})

test('a real serve block still resolves relative paths correctly', async () => {
  const server = createServer((_, res) => { res.writeHead(200); res.end('ok') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  server.close()

  sandbox({
    goal: 'resolves against serve',
    serve: {
      run: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port});setInterval(()=>{},1e4)" ; true`,
      ready_url: `http://127.0.0.1:${port}/`,
      timeout: 15,
    },
    checks: [{ name: 'api', http: { path: '/api/thing', expect: { status: 200 } } }],
  })
  assert.equal(await quiet(() => check({ json: true })), 0)
})
