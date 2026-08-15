import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import YAML from 'yaml'

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

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

const wait = ms => new Promise(r => setTimeout(r, ms))

const sandbox = async port => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-interrupt-'))
  writeFileSync(join(dir, 'srv.js'),
    `require('http').createServer((q,s)=>s.end('ok')).listen(${port},()=>console.log('up'));setInterval(()=>{},1e4)\n`)
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), YAML.stringify({
    goal: 'interrupted run',
    serve: { run: 'node srv.js', ready_url: `http://127.0.0.1:${port}/`, timeout: 20 },
    checks: [{ name: 'slow check', timeout: 60, run: 'sleep 30' }],
  }))
  return dir
}

// Run the real CLI as a child so a real signal can be delivered to a real process.
const runAndSignal = async (dir, signal) => {
  const child = spawn(process.execPath, [CLI, 'check'], { cwd: dir, stdio: 'ignore' })
  await wait(4000) // let it boot the server and enter the slow check
  child.kill(signal)
  await new Promise(resolve => child.on('exit', resolve))
  await wait(500)
}

test('the regression: SIGINT tears down the dev server instead of orphaning it', async () => {
  const port = await freePort()
  const dir = await sandbox(port)

  await runAndSignal(dir, 'SIGINT')
  assert.equal(await portHeld(port), false, `port ${port} still held — the dev server outlived the interrupt`)
})

test('SIGTERM tears it down too', async () => {
  const port = await freePort()
  const dir = await sandbox(port)

  await runAndSignal(dir, 'SIGTERM')
  assert.equal(await portHeld(port), false, `port ${port} still held after SIGTERM`)
})

test('an interrupted run does not poison the next one', async () => {
  const port = await freePort()
  const dir = await sandbox(port)

  await runAndSignal(dir, 'SIGINT')

  // the port pre-flight would fail here if the previous run had leaked its server
  const second = spawn(process.execPath, [CLI, 'check', '--only', 'nothing-matches'], { cwd: dir, stdio: 'pipe' })
  let stderr = ''
  second.stderr.on('data', d => { stderr += d })
  await new Promise(resolve => second.on('exit', resolve))

  assert.equal(second.exitCode, 2, 'the second run got as far as selecting checks')
  assert.doesNotMatch(stderr, /already responding/, 'no phantom squatter left by the interrupted run')
})
