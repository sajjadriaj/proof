import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { validateSpec } from '../src/validate.js'

// Test files run in parallel, so ports must be genuinely allocated, not guessed.
const freePort = () => new Promise(resolve => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

const sandbox = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-health-'))
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

const resultOf = dir => JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

// A server that answers until asked to die, so the run outlives its own app.
const SERVER = (port, dieAfter = false) =>
  `node -e "let n=0;require('http').createServer((q,s)=>{n++;console.log('req '+q.url);` +
  // exit on a timer so stdout flushes and the response completes before the process goes
  (dieAfter ? `if(q.url==='/kill'){s.end('bye');setTimeout(()=>process.exit(3),50);return}` : '') +
  `s.end('ok')}).listen(${port});setInterval(()=>{},1e4)" ; true`

test('a server that dies during the run is reported as a health failure with its log', async () => {
  const port = await freePort()
  const dir = sandbox({
    goal: 'runtime health',
    serve: { run: SERVER(port, true), ready_url: `http://127.0.0.1:${port}/`, timeout: 15 },
    checks: [
      { name: 'kills the app', http: { path: '/kill' } },
      { name: 'settle', run: 'sleep 1' }, // the app is reliably gone by the health probe
    ],
  })

  assert.equal(await quiet(() => check({ json: true })), 1)

  const r = resultOf(dir)
  assert.equal(r.checks['app boots'], 'passed')
  assert.equal(r.checks['app still running'], 'failed')

  const f = r.failures.find(x => x.check === 'app still running')
  assert.match(f.observed, /no longer responding at http/)
  assert.ok(existsSync(join(dir, '.proof/runs/0001/serve.log')), 'serve.log is captured as evidence')
  assert.match(readFileSync(join(dir, '.proof/runs/0001/serve.log'), 'utf8'), /req \/kill/)
})

test('a healthy server passes the liveness check and still records its log', async () => {
  const port = await freePort()
  const dir = sandbox({
    goal: 'runtime health',
    serve: { run: SERVER(port), ready_url: `http://127.0.0.1:${port}/`, timeout: 15 },
    checks: [{ name: 'endpoint', http: { path: '/thing' } }],
  })

  assert.equal(await quiet(() => check({ json: true })), 0)
  const r = resultOf(dir)
  assert.equal(r.checks['app still running'], 'passed')
  assert.match(readFileSync(join(dir, '.proof/runs/0001/serve.log'), 'utf8'), /req \/thing/)
})

test('log_must_not_match fails on a matching runtime log line and names it', async () => {
  const port = await freePort()
  const dir = sandbox({
    goal: 'clean logs',
    serve: {
      run: `node -e "console.error('ERROR: unhandled rejection in worker');require('http').createServer((q,s)=>s.end('ok')).listen(${port});setInterval(()=>{},1e4)" ; true`,
      ready_url: `http://127.0.0.1:${port}/`,
      timeout: 15,
      log_must_not_match: 'unhandled rejection',
    },
    checks: [{ name: 'endpoint', http: { path: '/' } }],
  })

  assert.equal(await quiet(() => check({ json: true })), 1)
  const r = resultOf(dir)
  assert.equal(r.checks['app logs clean'], 'failed')
  assert.match(r.failures.find(x => x.check === 'app logs clean').observed, /unhandled rejection in worker/)
})

test('log_must_not_match passes when the log is clean, and is absent when unconfigured', async () => {
  const port = await freePort()
  const dir = sandbox({
    goal: 'clean logs',
    serve: { run: SERVER(port), ready_url: `http://127.0.0.1:${port}/`, timeout: 15, log_must_not_match: 'FATAL' },
    checks: [{ name: 'endpoint', http: { path: '/' } }],
  })
  assert.equal(await quiet(() => check({ json: true })), 0)
  assert.equal(resultOf(dir).checks['app logs clean'], 'passed')

  const port2 = await freePort()
  const dir2 = sandbox({
    goal: 'no log gate',
    serve: { run: SERVER(port2), ready_url: `http://127.0.0.1:${port2}/`, timeout: 15 },
    checks: [{ name: 'endpoint', http: { path: '/' } }],
  })
  await quiet(() => check({ json: true }))
  assert.equal('app logs clean' in resultOf(dir2).checks, false)
})

test('bad regexes are contract errors, not mid-run crashes', () => {
  const p = validateSpec({
    goal: 'g',
    serve: { run: 'x', ready_url: 'http://x.test', log_must_not_match: '[' },
    checks: [{ name: 'a', env: { name: 'PATH', matches: '(' } }],
  })
  assert.equal(p.length, 2)
  assert.match(p[0], /serve › log_must_not_match: invalid regex/)
  assert.match(p[1], /env › matches: invalid regex/)
})

test('visiting a 404 route fails on the visit, not on a later selector timeout', async () => {
  const server = createServer((_, res) => { res.writeHead(404); res.end('<h1>not found</h1>') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`

  const dir = sandbox({
    goal: 'route must exist',
    checks: [{
      name: 'flow',
      timeout: 20,
      browser: { base_url: url, visit: '/forgot-password', flow: [{ click: 'Send reset link' }] },
    }],
  })

  try {
    const started = Date.now()
    assert.equal(await quiet(() => check({ json: true })), 1)
    const f = resultOf(dir).failures[0]
    assert.match(f.expected, /\/forgot-password loads/)
    assert.match(f.observed, /status 404/)
    assert.ok(Date.now() - started < 15000, 'fails fast rather than waiting out the selector timeout')
  } finally { server.close() }
})
