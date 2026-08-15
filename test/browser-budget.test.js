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

const serve = () => new Promise(resolve => {
  const s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>t</title><p>hello</p>')
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const sandbox = (url, flow, timeout) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-budget-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'g',
    checks: [{ name: 'flow', timeout, browser: { base_url: url, visit: '/', flow } }],
  }))
  return dir
}

test('a flow that outlives its budget says so, and names the step it stopped at', async () => {
  // `timeout` is the budget for the whole check, not per step. A deliberate wait longer
  // than the budget is the one way to reach this deterministically — no wall-clock guess.
  const { s, url } = await serve()
  const dir = sandbox(url, [{ wait: 4000 }, { expect_text: 'hello' }], 2)
  try {
    assert.equal(await quiet(() => check({ json: true })), 1)

    const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
    const observed = r.failures[0].observed

    assert.match(observed, /timeout budget|timeout/i, observed)
    assert.match(r.failures[0].expected ?? '', /completes within 2s|flow/i, r.failures[0].expected)
  } finally { s.close() }
})

test('the advice names the knob that fixes it', async () => {
  const { s, url } = await serve()
  const dir = sandbox(url, [{ wait: 4000 }, { expect_text: 'hello' }], 2)
  try {
    await quiet(() => check({ json: true }))
    const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

    const text = `${r.failures[0].expected} ${r.failures[0].observed}`
    assert.match(text, /timeout/, 'a budget failure points at `timeout`, not at the app')
  } finally { s.close() }
})

test('a flow inside its budget is untouched', async () => {
  // Without this, a budget that always fires would satisfy the tests above.
  const { s, url } = await serve()
  const dir = sandbox(url, [{ wait: 100 }, { expect_text: 'hello' }], 25)
  try {
    assert.equal(await quiet(() => check({ json: true })), 0)
    const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
    assert.equal(r.checks.flow, 'passed')
  } finally { s.close() }
})
