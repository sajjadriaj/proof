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

// throws well after the last assertion resolves — the shape of a late async failure
const serve = (delayMs, throws = true) => new Promise(resolve => {
  const page = `<!doctype html><meta charset=utf-8><title>t</title><h1>Dashboard</h1>
<script>${throws ? `setTimeout(()=>{ undefinedThing.boom() }, ${delayMs})` : ''}</script>`
  const s = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page) })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async (url, browserExtra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-consolegate-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'the dashboard loads without errors',
    checks: [{
      name: 'dashboard',
      timeout: 25,
      browser: { base_url: url, visit: '/', flow: [{ expect_text: 'Dashboard' }], ...browserExtra },
    }],
  }))
  const code = await quiet(() => check({ json: true }))
  return { code, result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')) }
}

test('the regression: a late error fails the gate that was asked for', async () => {
  const { s, url } = await serve(120)
  try {
    const { code, result } = await run(url, { expect_no_console_errors: true })

    assert.equal(code, 1, 'the contract asked to fail on console errors')
    assert.equal(result.checks.dashboard, 'failed')
    assert.match(result.failures[0].expected, /no console errors/)
    assert.match(result.failures[0].observed, /undefinedThing is not defined/, 'the failure names the error')
  } finally { s.close() }
})

test('the regression: proof never advises setting a flag that is already set', async () => {
  const { s, url } = await serve(120)
  try {
    const { result } = await run(url, { expect_no_console_errors: true })
    assert.deepEqual(result.warnings, [], 'a gated error is a failure, not a warning')
  } finally { s.close() }
})

test('with the gate off, a late error is still reported as a warning', async () => {
  const { s, url } = await serve(120)
  try {
    const { code, result } = await run(url)
    assert.equal(code, 0, 'the gate is opt-in')
    assert.ok(result.warnings.some(w => /console error\(s\) logged/.test(w)))
    assert.match(result.warnings[0], /set `expect_no_console_errors: true`/)
  } finally { s.close() }
})

test('a clean page passes the gate and warns about nothing', async () => {
  const { s, url } = await serve(0, false)
  try {
    const { code, result } = await run(url, { expect_no_console_errors: true })
    assert.equal(code, 0)
    assert.deepEqual(result.warnings, [])
  } finally { s.close() }
})

test('an error that arrives during the flow still fails immediately', async () => {
  const { s, url } = await serve(0)
  try {
    const { code, result } = await run(url, { expect_no_console_errors: true })
    assert.equal(code, 1)
    assert.match(result.failures[0].observed, /console error/)
  } finally { s.close() }
})
