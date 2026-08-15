import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'

const sandbox = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-resilience-'))
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

const serveStatus = status => new Promise(resolve => {
  const s = createServer((_, res) => { res.writeHead(status); res.end(status === 200 ? 'ok' : 'boom') })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

test('a crashing runner fails only its own check and keeps the run evidence', { skip: process.getuid?.() === 0 && 'root ignores file permissions' }, async () => {
  const dir = sandbox({
    goal: 'resilience',
    checks: [
      { name: 'earlier', run: 'echo recorded' },
      // valid contract, existing regular file, but unreadable — throws EACCES in the runner
      { name: 'crasher', file: { path: 'locked.txt', contains: 'anything' } },
      { name: 'later', run: 'echo also recorded' },
    ],
  })

  writeFileSync('locked.txt', 'secret')
  chmodSync('locked.txt', 0o000)

  assert.equal(await quiet(() => check({ json: true })), 1)

  const r = resultOf(dir)
  assert.deepEqual(r.checks, { earlier: 'passed', crasher: 'failed', later: 'passed' })
  assert.match(r.failures[0].observed, /check crashed: EACCES/)
  assert.ok(existsSync(join(dir, '.proof/runs/0001/commands.log')), 'commands.log still written')
})

test('an http check with no expect fails on an error status', async () => {
  const { s, url } = await serveStatus(500)
  const dir = sandbox({ goal: 'reachability', checks: [{ name: 'endpoint', http: { url } }] })
  try {
    assert.equal(await quiet(() => check({ json: true })), 1)
    const r = resultOf(dir)
    assert.match(r.failures[0].expected, /non-error status/)
    assert.match(r.failures[0].observed, /status 500/)
  } finally { s.close() }
})

test('an http check with no expect passes on a normal status', async () => {
  const { s, url } = await serveStatus(200)
  sandbox({ goal: 'reachability', checks: [{ name: 'endpoint', http: { url } }] })
  try {
    assert.equal(await quiet(() => check({ json: true })), 0)
  } finally { s.close() }
})

test('an explicit expect still wins over the default', async () => {
  const { s, url } = await serveStatus(404)
  sandbox({ goal: 'expects a 404', checks: [{ name: 'gone', http: { url, expect: { status: 404 } } }] })
  try {
    assert.equal(await quiet(() => check({ json: true })), 0, '404 is a pass when the contract asks for it')
  } finally { s.close() }
})

test('a broken spec still aborts before any run directory is created', async () => {
  const dir = sandbox({ goal: 'bad', checks: [{ name: 'a', http: { url: 'http://x.test/', expect_status: 200 } }] })
  await assert.rejects(() => check({ json: true }), /unknown key "expect_status"/)
  assert.equal(existsSync(join(dir, '.proof/runs')), false, 'no empty run dir left behind')
})
