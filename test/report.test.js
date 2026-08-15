import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check } from '../src/check.js'
import { report, resolveRun, listRuns } from '../src/report.js'

const withSpec = yaml => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-report-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', yaml)
  return dir
}

const quiet = fn => {
  const real = console.log
  console.log = () => {}
  try { return fn() } finally { console.log = real }
}

test('report renders the latest run and writes report.md', async () => {
  const dir = withSpec(`
goal: reset password works
checks:
  - name: green
    run: "true"
  - name: red
    run: exit 2
`)
  await quiet(() => check({ json: true }))
  const code = quiet(() => report({}))

  assert.equal(code, 1)
  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
  assert.match(md, /\*\*Verdict:\*\* NOT DONE/)
  assert.match(md, /\*\*Requirement:\*\* reset password works/)
  assert.match(md, /\| green \| `true`, exit 0 \| PASS \|/, 'the table says what the check asserted')
  assert.match(md, /\| red \| `exit 2`, exit 0 \| FAIL \|/, 'a failure shows what it should have done')
  assert.match(md, /### red/)
  assert.match(md, /result\.json/)
})

test('report defaults to the newest run and accepts an explicit id', async () => {
  withSpec(`
goal: two runs
checks:
  - name: ok
    run: "true"
`)
  await quiet(() => check({ json: true }))
  await quiet(() => check({ json: true }))

  assert.deepEqual(listRuns(), ['0001', '0002'])
  assert.equal(resolveRun(), join('.proof', 'runs', '0002'))
  assert.equal(resolveRun('1'), join('.proof', 'runs', '0001'))
  assert.equal(quiet(() => report({})), 0)
  assert.throws(() => resolveRun('9'), /no run "9"/)
})

test('report errors when nothing has been verified yet', () => {
  withSpec('goal: none\nchecks: [{name: ok, run: "true"}]\n')
  assert.throws(() => report({}), /no runs yet/)
})

test('report --json emits the raw evidence without rewriting report.md', async () => {
  const dir = withSpec('goal: json\nchecks: [{name: ok, run: "true"}]\n')
  await quiet(() => check({ json: true }))
  let printed = ''
  const real = console.log
  console.log = s => { printed += s }
  try { report({ json: true }) } finally { console.log = real }

  assert.equal(JSON.parse(printed).status, 'passed')
  assert.equal(existsSync(join(dir, '.proof/runs/0001/report.md')), false)
})
