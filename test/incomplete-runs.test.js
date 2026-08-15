import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { report, listRuns, listRunsDetailed, resolveRun, completeRuns } from '../src/report.js'

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

// two good runs, one killed before writing a verdict, one with a truncated verdict
const project = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-incomplete-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'list completeness',
    checks: [{ name: 'alpha', run: 'true' }],
  }))
  await quiet(() => check({ json: true }))
  await quiet(() => check({ json: true }))

  mkdirSync('.proof/runs/0003')
  writeFileSync('.proof/runs/0003/commands.log', 'partial output\n')

  await quiet(() => check({ json: true }))
  writeFileSync('.proof/runs/0004/result.json', '{"status":"pas')
  return dir
}

test('the regression: a run killed mid-flight is listed, not hidden', async () => {
  await project()
  const out = await captured(() => report({ list: true }))

  assert.match(out, /^ {2}0003 .*did not finish$/m, `got:\n${out}`)
  assert.deepEqual(listRuns(), ['0001', '0002', '0003', '0004'], 'no gap in the sequence')
})

test('an unreadable verdict says so rather than showing question marks', async () => {
  await project()
  const out = await captured(() => report({ list: true }))
  assert.match(out, /^ {2}0004 .*result\.json could not be read$/m)
})

test('the footer counts the runs without a verdict', async () => {
  await project()
  const out = await captured(() => report({ list: true }))
  assert.match(out, /4 run\(s\), 2 without a verdict/)
})

test('statuses reach agents through --json', async () => {
  await project()
  const { runs } = JSON.parse(await captured(() => report({ list: true, json: true })))

  assert.deepEqual(runs.map(r => [r.id, r.status]), [
    ['0001', 'passed'],
    ['0002', 'passed'],
    ['0003', 'incomplete'],
    ['0004', 'unreadable'],
  ])
})

test('asking for an unfinished run says why, not "no such run"', async () => {
  await project()
  assert.throws(() => resolveRun('0003'), /run 0003 did not finish — it has no result\.json/)
  assert.throws(() => resolveRun('0099'), /no run "0099"/)
})

test('the default run skips past an unfinished one to the last real verdict', async () => {
  const dir = await project()
  rmSync(join(dir, '.proof/runs/0004'), { recursive: true })

  // 0003 is the newest directory but has no verdict; 0002 is the newest that does
  assert.deepEqual(listRuns(), ['0001', '0002', '0003'])
  assert.deepEqual(completeRuns(), ['0001', '0002'])
  assert.equal(resolveRun(), join('.proof', 'runs', '0002'))
})

test('a tree with only unfinished runs says that plainly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-incomplete2-'))
  process.chdir(dir)
  mkdirSync('.proof/runs/0001', { recursive: true })

  assert.throws(() => resolveRun(), /no finished runs yet/)
})

test('healthy runs are unaffected', async () => {
  await project()
  const detailed = listRunsDetailed()
  assert.equal(detailed[0].status, 'passed')
  assert.equal(detailed[0].checks, 1)
  assert.ok(detailed[0].bytes > 0)
})

test('the regression: the run id proof prints is one it accepts back', async () => {
  // Every run's Evidence section prints `.proof/runs/0001/result.json`, and shells complete
  // `.proof/runs/0001/` with a trailing slash. Both came back as "no run" — for a path the
  // tool itself had just handed the reader.
  const { check } = await import('../src/check.js')
  const { resolveRun } = await import('../src/report.js')
  const dir = mkdtempSync(join(tmpdir(), 'proof-runid-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')

  const real = console.log
  console.log = () => {}
  try { await check({ json: true }); await check({ json: true }) } finally { console.log = real }

  const expected = join('.proof', 'runs', '0002')
  for (const form of [
    '0002', '2', '002',
    '0002/',
    '.proof/runs/0002',
    '.proof/runs/0002/',
    '.proof/runs/0002/result.json',
  ]) {
    assert.equal(resolveRun(form), expected, `proof report ${form}`)
  }
})

test('a run that does not exist is still refused, whatever form it takes', async () => {
  // The rule must not turn every string into some run.
  const { check } = await import('../src/check.js')
  const { resolveRun } = await import('../src/report.js')
  const dir = mkdtempSync(join(tmpdir(), 'proof-runid-missing-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')

  const real = console.log
  console.log = () => {}
  try { await check({ json: true }) } finally { console.log = real }

  for (const form of ['99', 'nonsense', '.proof/runs/0099', '/', '']) {
    assert.throws(() => resolveRun(form || '99'), /no run|did not finish/, `accepted "${form}"`)
  }
})
