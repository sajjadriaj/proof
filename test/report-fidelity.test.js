import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { report, listRunsDetailed } from '../src/report.js'

const sandbox = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fidelity-'))
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

const captured = async fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { await fn() } finally { console.log = real }
  return lines.join('\n')
}

const RUN_ONLY = {
  goal: 'Users can reset a forgotten password',
  checks: [{ name: 'build', run: 'true' }, { name: 'tests', run: 'true' }],
}

test('the regression: a caveat shown by check also appears in the report', async () => {
  const dir = sandbox(RUN_ONLY)
  await quiet(() => check({ json: true }))
  await quiet(() => report({}))

  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
  assert.match(md, /\*\*Verdict:\*\* DONE/)
  assert.match(md, /What this run does not prove/)
  assert.match(md, /Nothing in this contract exercises the running application/)
})

test('a report with real acceptance checks carries no such caveat', async () => {
  const dir = sandbox({
    goal: 'has acceptance checks',
    checks: [{ name: 'tests', run: 'true' }, { name: 'secret', env: 'PATH' }],
  })
  await quiet(() => check({ json: true }))
  await quiet(() => report({}))

  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
  assert.match(md, /## Checks/, 'a report was written')
  assert.doesNotMatch(md, /What this run does not prove/)
})

test('--list shows every run with its verdict, tally and goal', async () => {
  sandbox({ goal: 'first goal', checks: [{ name: 'a', run: 'true' }] })
  await quiet(() => check({ json: true }))

  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'second goal',
    checks: [{ name: 'a', run: 'true' }, { name: 'b', run: 'exit 1' }],
  }))
  await quiet(() => check({ json: true }))

  const runs = listRunsDetailed()
  assert.deepEqual(runs.map(r => [r.id, r.status, r.checks, r.failed]), [
    ['0001', 'passed', 1, 0],
    ['0002', 'failed', 2, 1],
  ])

  const out = await captured(() => report({ list: true }))
  assert.match(out, /0001 {2}PASS/)
  assert.match(out, /0002 {2}FAIL/)
  assert.match(out, /first goal/)
  assert.match(out, /second goal/)
  assert.match(out, /1\/2/, 'shows how many checks passed')
})

test('--list is machine-readable and says so when there is nothing yet', async () => {
  sandbox({ goal: 'g', checks: [{ name: 'a', run: 'true' }] })

  const empty = await captured(() => report({ list: true }))
  assert.match(empty, /No runs yet/)

  await quiet(() => check({ json: true }))
  const out = await captured(() => report({ list: true, json: true }))
  const { runs } = JSON.parse(out)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'passed')
  assert.equal(runs[0].goal, 'g')
})

test('a partial run is labelled as such in the list', async () => {
  sandbox({
    goal: 'g',
    checks: [{ name: 'fast', run: 'true' }, { name: 'slow', run: 'true' }],
  })
  await quiet(() => check({ json: true, only: 'fast' }))

  const out = await captured(() => report({ list: true }))
  assert.match(out, /0001 {2}PART/)
})
