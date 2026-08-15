import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check } from '../src/check.js'
import { evidenceGrowth } from '../src/runs.js'

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

/** Fabricated prior runs — a scale test should not take a hundred real runs to set up. */
const withPriorRuns = (count, bytesEach = 40_000) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-growth-'))
  process.chdir(dir)
  mkdirSync('.proof/runs', { recursive: true })
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: echo ok\n')

  for (let i = 1; i <= count; i++) {
    const n = String(i).padStart(4, '0')
    mkdirSync(join('.proof/runs', n), { recursive: true })
    writeFileSync(join('.proof/runs', n, 'result.json'), '{"status":"passed"}')
    writeFileSync(join('.proof/runs', n, 'commands.log'), 'x'.repeat(bytesEach))
  }
  return dir
}

test('the regression: a loop that never stops running check is told what it is accumulating', async () => {
  // A run costs a few hundred kilobytes and nothing prunes them. The only place the total
  // was ever shown is `report --list`, which nobody in an agent loop runs.
  withPriorRuns(99)
  const out = await captured(() => check({}))

  assert.match(out, /100 runs/)
  assert.match(out, /have collected in/)
  assert.match(out, /Nothing prunes them/)
})

test('below the threshold it says nothing', async () => {
  withPriorRuns(50)
  const out = await captured(() => check({}))
  assert.match(out, /VERDICT/, 'the run happened at all')
  assert.doesNotMatch(out, /have collected/)
})

test('the notice is advisory — the verdict and exit code are untouched', async () => {
  withPriorRuns(120)
  const code = await quiet(() => check({}))
  assert.equal(code, 0, 'a passing run still passes')

  const out = await captured(() => check({}))
  assert.match(out, /VERDICT\n  DONE/)
})

test('--json is unchanged: this is about proof, not about the code under test', async () => {
  withPriorRuns(120)
  const out = await captured(() => check({ json: true }))
  const parsed = JSON.parse(out)

  assert.equal(parsed.status, 'passed')
  assert.equal(parsed.warnings.length, 0, 'not smuggled into warnings, which are about the run')
})

test('the size reported is the size on disk', async () => {
  withPriorRuns(100, 100_000)
  // 100 runs x 100 KB is comfortably into megabytes; the exact total depends on the
  // filesystem, so assert the unit rather than a number that would be machine-specific.
  assert.match(evidenceGrowth('.proof/runs') ?? '', /\d+\.\d MB/)
})

test('a directory that is not a run is not counted as one', async () => {
  withPriorRuns(99)
  mkdirSync(join('.proof/runs', 'scratch'), { recursive: true })
  mkdirSync(join('.proof/runs', 'notes-from-2024'), { recursive: true })

  assert.equal(evidenceGrowth('.proof/runs'), null, '99 runs plus two stray directories is still 99 runs')
})

test('no runs directory at all is not an error', () => {
  mkdtempSync(join(tmpdir(), 'proof-growth-empty-'))
  assert.equal(evidenceGrowth('.proof/runs-that-do-not-exist'), null)
})
