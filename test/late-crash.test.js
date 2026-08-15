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

// the request succeeds, then the process dies shortly after — an unhandled rejection's shape
const SERVER = (port, dieAfterMs) => `node -e "require('http').createServer((q,s)=>{`
  + `if(q.url==='/checkout'){s.writeHead(200);s.end('ok');`
  + (dieAfterMs === null ? '' : `setTimeout(()=>{console.error('FATAL: worker died');process.exit(1)},${dieAfterMs});`)
  + `return}`
  + `s.writeHead(200);s.end('ok')}).listen(${port});setInterval(()=>{},1e4)" ; true`

const run = async (dieAfterMs, extraServe = {}) => {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'proof-latecrash-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'checkout works and the app survives it',
    serve: { run: SERVER(port, dieAfterMs), ready_url: `http://127.0.0.1:${port}/`, timeout: 20, ...extraServe },
    checks: [{ name: 'checkout', http: { path: '/checkout', expect: { status: 200 } } }],
  }))
  const code = await quiet(() => check({ json: true }))
  return {
    code,
    result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
    log: readFileSync(join(dir, '.proof/runs/0001/serve.log'), 'utf8'),
  }
}

test('the regression: an app killed by the run is not reported as still running', async () => {
  const { code, result, log } = await run(150)

  assert.match(log, /FATAL: worker died/, 'the app really did die')
  assert.equal(result.checks['app still running'], 'failed')
  assert.equal(code, 1, 'a run that kills the app is not DONE')
})

test('the failure says the app stopped answering', async () => {
  const { result } = await run(150)
  const failure = result.failures.find(f => f.check === 'app still running')
  assert.match(failure.observed, /no longer responding at http/)
})

test('the check that triggered it still passes on its own terms', async () => {
  const { result } = await run(150)
  assert.equal(result.checks.checkout, 'passed', 'the request itself did succeed')
})

test('an app that survives is still reported as healthy', async () => {
  const { code, result } = await run(null)
  assert.equal(code, 0)
  assert.equal(result.checks['app still running'], 'passed')
})

test('a late crash and its log are both caught in the same run', async () => {
  const { result } = await run(150, { log_must_not_match: 'FATAL' })

  assert.equal(result.checks['app still running'], 'failed')
  assert.equal(result.checks['app logs clean'], 'failed', 'the log gate sees the crash line too')
})
