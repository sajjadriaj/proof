import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { report, listRunsDetailed } from '../src/report.js'
import { humanBytes } from '../src/runs.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const captured = async fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { await fn() } finally { console.log = real }
  return lines.join('\n')
}

const project = async runs => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-size-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'evidence size',
    checks: [{ name: 'noisy', run: `for i in $(seq 1 200); do echo "line $i of output"; done` }],
  }))
  for (let i = 0; i < runs; i++) await quiet(() => check({ json: true }))
  return dir
}

test('the regression: --list reports what the evidence is costing', async () => {
  await project(3)
  const out = await captured(() => report({ list: true }))

  assert.match(out, /3 run\(s\), \d+(\.\d+)? (B|KB|MB) in \.proof\/runs/, `got: ${out.split('\n').pop()}`)
})

test('each run carries its own size, and they sum to the total', async () => {
  await project(3)
  const runs = listRunsDetailed()

  assert.equal(runs.length, 3)
  for (const r of runs) assert.ok(r.bytes > 0, `${r.id} should have measurable evidence`)

  const out = await captured(() => report({ list: true }))
  const total = runs.reduce((n, r) => n + r.bytes, 0)
  assert.match(out, new RegExp(humanBytes(total).replace('.', '\\.')), 'the footer total matches the parts')
})

test('sizes reach agents through --json', async () => {
  await project(2)
  const { runs } = JSON.parse(await captured(() => report({ list: true, json: true })))

  assert.equal(runs.length, 2)
  for (const r of runs) assert.equal(typeof r.bytes, 'number')
})

test('humanBytes scales its units', () => {
  assert.equal(humanBytes(512), '512 B')
  assert.equal(humanBytes(2048), '2 KB')
  assert.equal(humanBytes(5 * 1024 * 1024), '5.0 MB')
})

test('an empty runs directory still reports cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-size-empty-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({ goal: 'g', checks: [{ name: 'a', run: 'true' }] }))

  assert.match(await captured(() => report({ list: true })), /No runs yet/)
})
