import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { validateSpec } from '../src/validate.js'

const freePort = () => new Promise(resolve => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

// an unrelated project already holding the port
const squatter = port => new Promise(resolve => {
  const s = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ app: 'SOME OTHER PROJECT' }))
  })
  s.listen(port, '127.0.0.1', () => resolve(s))
})

const OURS = port => `node -e "require('http').createServer((q,s)=>s.end('{\\"app\\":\\"ours\\"}')).listen(${port});setInterval(()=>{},1e4)" ; true`

const sandbox = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-port-'))
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

const contract = (port, serveExtra = {}) => ({
  goal: 'our API is up and healthy',
  serve: { run: OURS(port), ready_url: `http://127.0.0.1:${port}/`, timeout: 10, ...serveExtra },
  checks: [{ name: 'api responds', http: { path: '/health', expect: { status: 200 } } }],
})

test('the regression: an occupied port fails the run instead of verifying a stranger', async () => {
  const port = await freePort()
  const other = await squatter(port)
  const dir = sandbox(contract(port))
  try {
    assert.equal(await quiet(() => check({ json: true })), 1)

    const r = resultOf(dir)
    assert.equal(r.checks['app boots'], 'failed')
    assert.match(r.failures[0].observed, /something is already responding at http/)
    assert.match(r.failures[0].observed, /proof cannot tell whether checks would reach your app/)
    assert.equal(r.results.length, 1, 'no downstream check runs against the wrong app')
  } finally { other.close() }
})

test('a free port boots and verifies normally', async () => {
  const port = await freePort()
  const dir = sandbox(contract(port))

  assert.equal(await quiet(() => check({ json: true })), 0)
  const r = resultOf(dir)
  assert.equal(r.checks['app boots'], 'passed')
  assert.deepEqual(r.warnings, [])
})

test('reuse_existing accepts it deliberately, and says so', async () => {
  const port = await freePort()
  const other = await squatter(port)
  const dir = sandbox(contract(port, { reuse_existing: true }))
  try {
    assert.equal(await quiet(() => check({ json: true })), 0)

    const r = resultOf(dir)
    assert.equal(r.checks['app boots'], 'passed')
    assert.equal(r.warnings.length, 1)
    assert.match(r.warnings[0], /something was already responding/)
    assert.match(r.warnings[0], /a process proof did not start/)
  } finally { other.close() }
})

test('reuse_existing is type-checked', () => {
  const p = validateSpec({
    goal: 'g',
    serve: { run: 'x', ready_url: 'http://x.test', reuse_existing: 'yes' },
    checks: [{ name: 'a', run: 'true' }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /serve › reuse_existing: must be a boolean, got string/)
})
