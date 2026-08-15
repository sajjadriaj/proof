import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import YAML from 'yaml'
import { check } from '../src/check.js'

const freePort = () => new Promise(resolve => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

// logs its failure shortly AFTER responding, the way a real worker does
const SERVER = port => `require('http').createServer((q,s)=>{
  if (q.url === '/boom') { s.writeHead(200); s.end('ok'); setTimeout(()=>console.error('ERROR: unhandled rejection in payment worker'), 20); return }
  s.writeHead(200); s.end('ok')
}).listen(${port},()=>console.log('up'));setInterval(()=>{},1e4)`

const sandbox = async (extraServe = {}) => {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'proof-drain-'))
  process.chdir(dir)
  writeFileSync('srv.js', SERVER(port))
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'checkout must not log unhandled rejections',
    serve: { run: 'node srv.js', ready_url: `http://127.0.0.1:${port}/`, timeout: 20, ...extraServe },
    checks: [{ name: 'trigger checkout', http: { path: '/boom', expect: { status: 200 } } }],
  }))
  return dir
}

const resultOf = dir => JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

test('the regression: the log gate sees output that arrives after the last check', async () => {
  const dir = await sandbox({ log_must_not_match: 'unhandled rejection' })

  assert.equal(await quiet(() => check({ json: true })), 1, 'the gate must catch the late error')
  const r = resultOf(dir)
  assert.equal(r.checks['app logs clean'], 'failed')
  assert.match(
    r.failures.find(f => f.check === 'app logs clean').observed,
    /unhandled rejection in payment worker/,
  )
})

test('serve.log keeps the last lines, which are the ones that explain a failure', async () => {
  const dir = await sandbox()
  await quiet(() => check({ json: true }))

  const log = readFileSync(join(dir, '.proof/runs/0001/serve.log'), 'utf8')
  assert.match(log, /^up/m, 'startup line present')
  assert.match(log, /unhandled rejection in payment worker/, 'late line present too')
})

test('a genuinely clean log still passes', async () => {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'proof-drain-clean-'))
  process.chdir(dir)
  writeFileSync('srv.js',
    `require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(${port},()=>console.log('up'));setInterval(()=>{},1e4)`)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'clean',
    serve: { run: 'node srv.js', ready_url: `http://127.0.0.1:${port}/`, timeout: 20, log_must_not_match: 'unhandled rejection' },
    checks: [{ name: 'ping', http: { path: '/', expect: { status: 200 } } }],
  }))

  assert.equal(await quiet(() => check({ json: true })), 0)
  assert.equal(resultOf(dir).checks['app logs clean'], 'passed')
})

test('liveness is still judged while the app is up, not after teardown', async () => {
  const dir = await sandbox()
  assert.equal(await quiet(() => check({ json: true })), 0)

  const r = resultOf(dir)
  assert.equal(r.checks['app still running'], 'passed', 'stopping the server ourselves must not read as a crash')
})
