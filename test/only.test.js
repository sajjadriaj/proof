import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { report } from '../src/report.js'

const CONTRACT = {
  goal: 'three checks',
  checks: [
    { name: 'build', run: 'true' },
    { name: 'browser flow', run: 'true' },
    { name: 'regression: login', run: 'true' },
  ],
}

const sandbox = (contract = CONTRACT) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-only-'))
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

test('--only runs the matching subset and reports partial, not passed', async () => {
  const dir = sandbox()
  assert.equal(await quiet(() => check({ json: true, only: 'browser' })), 0)

  const r = resultOf(dir)
  assert.equal(r.status, 'partial')
  assert.equal(r.partial, true)
  assert.equal(r.only, 'browser')
  assert.deepEqual(Object.keys(r.checks), ['browser flow'])
  assert.equal(r.contract_checks, 3)
  assert.equal(r.selected_checks, 1)
  assert.equal(r.ran_checks, 1)
})

test('a full run is passed, never partial', async () => {
  const dir = sandbox()
  assert.equal(await quiet(() => check({ json: true })), 0)

  const r = resultOf(dir)
  assert.equal(r.status, 'passed')
  assert.equal(r.partial, false)
  assert.equal(r.only, null)
})

test('--only matching several checks selects all of them, case-insensitively', async () => {
  const dir = sandbox()
  await quiet(() => check({ json: true, only: 'REGRESSION' }))
  assert.deepEqual(Object.keys(resultOf(dir).checks), ['regression: login'])

  const dir2 = sandbox({ goal: 'g', checks: [{ name: 'api a', run: 'true' }, { name: 'api b', run: 'true' }] })
  await quiet(() => check({ json: true, only: 'api' }))
  assert.deepEqual(Object.keys(resultOf(dir2).checks), ['api a', 'api b'])
})

test('a failing check in a subset still exits 1 and reports failed', async () => {
  const dir = sandbox({ goal: 'g', checks: [{ name: 'ok', run: 'true' }, { name: 'broken', run: 'exit 4' }] })
  assert.equal(await quiet(() => check({ json: true, only: 'broken' })), 1)

  const r = resultOf(dir)
  assert.equal(r.status, 'failed') // failure outranks partial — never hide a real failure
  assert.equal(r.partial, true)
})

test('--only with no match is a configuration error listing the real names', async () => {
  sandbox()
  await assert.rejects(() => check({ json: true, only: 'nonsense' }), /no check matches "nonsense".*build, browser flow/s)
})

test('report renders the partial verdict and exits 0', async () => {
  const dir = sandbox()
  await quiet(() => check({ json: true, only: 'build' }))
  assert.equal(await quiet(() => report({})), 0)

  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
  assert.match(md, /\*\*Verdict:\*\* INCOMPLETE/)
  assert.match(md, /Subset run/)
  assert.doesNotMatch(md, /skipped — the app never booted/)
})
