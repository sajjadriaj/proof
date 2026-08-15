import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * "You broke this" and "you have not finished this" rendered identically, and only one of
 * them is about the change just made. In an agent loop that is the most actionable fact in
 * the output.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { exit: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-regression-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: g\nchecks:\n'
    + '  - name: worked before\n    run: sh -c "exit $WORKED"\n'
    + '  - name: never worked\n    run: "false"\n')
  return dir
}

const run = (dir, worked) => {
  const r = spawnSync(process.execPath, [CLI, 'check', '--json'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, WORKED: worked } })
  return JSON.parse(r.stdout)
}
const failure = (out, name) => out.failures.find(f => f.check === name)

test('a check that passed in the previous run is marked as a regression', () => {
  const dir = project()
  run(dir, '0')                       // run 0001: "worked before" passes
  const out = run(dir, '1')           // run 0002: it now fails

  const f = failure(out, 'worked before')
  assert.equal(f.was, 'passed')
  assert.equal(f.since, '0001')
})

test('and one that never passed is marked as not new', () => {
  const dir = project()
  run(dir, '0')
  const out = run(dir, '1')

  const f = failure(out, 'never worked')
  assert.equal(f.was, 'failed')
  assert.equal(f.since, '0001')
})

test('the human output distinguishes them, since that is where it matters', () => {
  const dir = project()
  run(dir, '0')
  const r = spawnSync(process.execPath, [CLI, 'check'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, WORKED: '1' } })

  assert.match(r.stdout, /Regression:\n {4}passed in run 0001, fails now/)
  assert.match(r.stdout, /Not new:\n {4}also failed in run 0001/)
})

test('the first run has no baseline and claims none', () => {
  const dir = project()
  const out = run(dir, '1')

  assert.equal(failure(out, 'never worked').was, null)
  assert.equal(failure(out, 'never worked').since, null)
})

test('a check absent from the previous run is null, not assumed passing', () => {
  const dir = project()
  run(dir, '0')
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: g\nchecks:\n  - name: brand new\n    run: "false"\n')

  const out = run(dir, '0')
  assert.equal(failure(out, 'brand new').was, null)
  assert.equal(failure(out, 'brand new').since, null)
})

test('the baseline is the previous run, not this one', () => {
  // reading the runs directory after the current run is recorded would compare a run to itself
  const dir = project()
  run(dir, '0')
  run(dir, '1')
  const third = run(dir, '1')

  assert.equal(failure(third, 'worked before').was, 'failed', 'run 0002 also failed')
  assert.equal(failure(third, 'worked before').since, '0002')
})

test('an unreadable previous run is skipped, not used as the baseline', () => {
  const dir = project()
  run(dir, '0')
  // a run interrupted part-way through: parses, but is not a run record
  mkdirSync(join(dir, '.proof/runs/0002'), { recursive: true })
  writeFileSync(join(dir, '.proof/runs/0002/result.json'), '{"status":"passed"}')

  const out = run(dir, '1')
  assert.equal(failure(out, 'worked before').since, '0001', 'looked further back')
  assert.equal(failure(out, 'worked before').was, 'passed')
})

test('it never changes the verdict or the exit code', () => {
  const dir = project()
  const first = spawnSync(process.execPath, [CLI, 'check'], { cwd: dir, encoding: 'utf8', env: { ...process.env, WORKED: '0' } })
  assert.equal(first.status, 1, 'never worked still fails')

  const second = spawnSync(process.execPath, [CLI, 'check'], { cwd: dir, encoding: 'utf8', env: { ...process.env, WORKED: '0' } })
  assert.equal(second.status, 1)
})

test('the run in flight is never its own baseline', () => {
  // it excludes itself because result.json is written last, not because of call ordering —
  // a directory without one is not a finished run
  const dir = project()
  run(dir, '0')
  const out = run(dir, '1')

  assert.equal(failure(out, 'worked before').since, '0001', 'not 0002, the run producing this')
})

test('report.md carries the marker — it is read away from the terminal', () => {
  const dir = project()
  run(dir, '0')
  run(dir, '1')
  proof(dir, 'report')

  const md = readFileSync(join(dir, '.proof/runs/0002/report.md'), 'utf8')
  assert.match(md, /\*\*Regression:\*\* passed in run 0001, fails now/)
  assert.match(md, /\*\*Not new:\*\* also failed in run 0001/)
})

/**
 * A check keeps its name when its assertion is edited. Comparing by name alone called that
 * a regression — pointing at code that never moved.
 */
const withCheck = (dir, body) =>
  writeFileSync(join(dir, '.proof/spec.yaml'), `goal: g\nchecks:\n  - name: pricing is right\n    ${body}\n`)

test('a check edited between runs is not comparable, not a regression', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-notsame-'))
  mkdirSync(join(dir, '.proof'))
  withCheck(dir, 'run: "true"')
  proof(dir, 'check')                       // run 0001 passes
  withCheck(dir, 'run: "false"')            // the code never changed; the check did

  // one run, both readings: a second `check` would compare against run 0002, where the
  // edited check already failed
  const human = proof(dir, 'check')
  assert.match(human.out, /Not comparable:\n {4}this check asserted something else in run 0001/)

  const recorded = JSON.parse(readFileSync(join(dir, '.proof/runs/0002/result.json'), 'utf8'))
  const f = recorded.failures.find(x => x.check === 'pricing is right')
  assert.equal(f.was, 'changed')
  assert.equal(f.since, '0001')
})

test('an unchanged check still reports a real regression', () => {
  // the command is identical across both runs; only the world it runs against moved
  const dir = project()
  run(dir, '0')
  const out = run(dir, '1')

  assert.equal(failure(out, 'worked before').was, 'passed')
})

test('report.md carries the not-comparable line too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-notsame-md-'))
  mkdirSync(join(dir, '.proof'))
  withCheck(dir, 'run: "true"')
  proof(dir, 'check')
  withCheck(dir, 'run: "false"')
  proof(dir, 'check')
  proof(dir, 'report')

  const md = readFileSync(join(dir, '.proof/runs/0002/report.md'), 'utf8')
  assert.match(md, /\*\*Not comparable:\*\* this check asserted something else in run 0001/)
  assert.doesNotMatch(md, /Regression:/)
})
