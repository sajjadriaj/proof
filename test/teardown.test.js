import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, createServer } from 'node:net'
import YAML from 'yaml'
import { check } from '../src/check.js'

// `sh -c "<cmd> ; true"` forces the shell to fork rather than exec, so the node
// process is a grandchild — exactly the case a plain p.kill() would orphan.
const LISTENER = port =>
  `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port});setInterval(()=>{},1e4)" ; true`

// Test files run in parallel, so ports must be genuinely allocated, not guessed.
const freePort = () => new Promise(resolve => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

const portHeld = port => new Promise(resolve => {
  const s = connect({ port, host: '127.0.0.1' })
  s.on('connect', () => { s.destroy(); resolve(true) })
  s.on('error', () => resolve(false))
  setTimeout(() => { s.destroy(); resolve(false) }, 1500)
})

const spec = obj => {
  process.chdir(mkdtempSync(join(tmpdir(), 'proof-teardown-')))
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(obj))
}

const settle = () => new Promise(r => setTimeout(r, 300))

test('a timed-out run check kills its grandchildren, not just the shell', async () => {
  const port = await freePort()
  spec({ goal: 'teardown', checks: [{ name: 'hangs', timeout: 2, run: LISTENER(port) }] })

  assert.equal(await check({ json: true }), 1)
  await settle()
  assert.equal(await portHeld(port), false, `port ${port} still held — the listener was orphaned`)
})

test('serve is torn down after the run, freeing its port', async () => {
  const port = await freePort()
  spec({
    goal: 'teardown',
    serve: { run: LISTENER(port), ready_url: `http://127.0.0.1:${port}`, timeout: 15 },
    checks: [{ name: 'ok', run: 'true' }],
  })

  assert.equal(await check({ json: true }), 0)
  await settle()
  assert.equal(await portHeld(port), false, `port ${port} still held — serve was not torn down`)
})

test('serve that never becomes ready is torn down too', async () => {
  const port = await freePort()
  spec({
    goal: 'teardown',
    // listens on `port` but we poll a port nothing answers on, so readiness times out
    serve: { run: LISTENER(port), ready_url: `http://127.0.0.1:${port + 1000}`, timeout: 2 },
    checks: [{ name: 'never runs', run: 'true' }],
  })

  assert.equal(await check({ json: true }), 1)
  await settle()
  assert.equal(await portHeld(port), false, `port ${port} still held — a never-ready serve leaked`)
})

test('a failed boot is reported as a check failure, not a crash', async () => {
  spec({
    goal: 'teardown',
    serve: { run: 'exit 1', ready_url: 'http://127.0.0.1:1', timeout: 5 },
    checks: [{ name: 'never runs', run: 'true' }],
  })
  assert.equal(await check({ json: true }), 1)
})
