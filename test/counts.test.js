import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { report } from '../src/report.js'

const freePort = () => new Promise(resolve => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

const captured = async fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { await fn() } finally { console.log = real }
  return lines.join('\n')
}

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const SERVER = port =>
  `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${port});setInterval(()=>{},1e4)" ; true`

const withServe = async () => {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'proof-counts-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'counting',
    serve: { run: SERVER(port), ready_url: `http://127.0.0.1:${port}/`, timeout: 20 },
    checks: [
      // alpha needs the app, so a subset selecting it still boots the serve block — which
      // is what makes the synthetic serve checks part of this test's subject.
      { name: 'alpha', http: { path: '/', expect: { status: 200 } } },
      { name: 'bravo', run: 'true' },
      { name: 'charlie', run: 'true' },
    ],
  }))
  return dir
}

const resultOf = dir => JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

test('the regression: a subset run counts contract checks, not synthetic serve checks', async () => {
  const dir = await withServe()
  const out = await captured(() => check({ only: 'alpha' }))

  assert.match(out, /selected 1 of 3 check\(s\)/, `got: ${out.split('\n').find(l => l.includes('Subset'))}`)

  const r = resultOf(dir)
  assert.equal(r.contract_checks, 3)
  assert.equal(r.selected_checks, 1)
  assert.equal(r.ran_checks, 1, 'app boots and app still running are not contract checks')
  assert.equal(r.results.length, 3, 'but they are still recorded as results')
})

test('the report agrees with the terminal', async () => {
  const dir = await withServe()
  await quiet(() => check({ only: 'alpha' }))
  await quiet(() => report({}))

  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
  assert.match(md, /— 1 of 3 check\(s\)/)
})

test('a full run with serve reports no skipped checks', async () => {
  const dir = await withServe()
  await quiet(() => check({ json: true }))
  await quiet(() => report({}))

  const r = resultOf(dir)
  assert.equal(r.ran_checks, 3)
  assert.equal(r.selected_checks, 3)
  assert.doesNotMatch(readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8'), /never ran/)
})

test('a failed boot reports exactly the contract checks that never ran', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-counts-boot-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'boot fails',
    serve: { run: 'exit 1', ready_url: 'http://127.0.0.1:1/', timeout: 5 },
    checks: [{ name: 'alpha', run: 'true' }, { name: 'bravo', run: 'true' }],
  }))

  assert.equal(await quiet(() => check({ json: true })), 1)
  await quiet(() => report({}))

  const r = resultOf(dir)
  assert.equal(r.ran_checks, 0)
  assert.equal(r.selected_checks, 2)
  assert.match(readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8'), /2 check\(s\) never ran/)
})

test('without a serve block the counts are unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-counts-plain-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'plain',
    checks: [{ name: 'alpha', run: 'true' }, { name: 'bravo', run: 'true' }],
  }))

  await quiet(() => check({ json: true }))
  const r = resultOf(dir)
  assert.equal(r.contract_checks, 2)
  assert.equal(r.ran_checks, 2)
  assert.equal(r.results.length, 2)
})
