import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Runs accumulate forever. The growth notice used to point at `rm` and claim "nothing else
 * reads them" — while `proof report <id>` is exactly a reader.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { exit: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

// Fake run directories: real `check` runs would make this test take a minute.
const withRuns = (n, { finished = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-prune-'))
  mkdirSync(join(dir, '.proof/runs'), { recursive: true })
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: t\n    run: "true"\n')
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(4, '0')
    mkdirSync(join(dir, '.proof/runs', id))
    if (finished) writeFileSync(join(dir, '.proof/runs', id, 'result.json'), '{"status":"passed","checks":[],"results":[],"failures":[]}')
  }
  return dir
}

const ids = dir => readdirSync(join(dir, '.proof/runs')).sort()

test('prune keeps the newest and deletes the rest', () => {
  const dir = withRuns(25)
  const r = proof(dir, 'report', '--prune', '--keep', '5')

  assert.equal(r.exit, 0, r.out)
  assert.deepEqual(ids(dir), ['0021', '0022', '0023', '0024', '0025'])
  assert.match(r.out, /Pruned 20 run\(s\) \(0001–0020\)/)
})

test('it keeps the newest numerically, not lexicographically', () => {
  // ids are padded to four digits, so run 10000 sorts before 9999 as text — pruning by
  // string order would delete the newest runs and keep the oldest
  const dir = mkdtempSync(join(tmpdir(), 'proof-prune-wide-'))
  mkdirSync(join(dir, '.proof/runs'), { recursive: true })
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: t\n    run: "true"\n')
  for (const id of ['9998', '9999', '10000', '10001']) {
    mkdirSync(join(dir, '.proof/runs', id))
    writeFileSync(join(dir, '.proof/runs', id, 'result.json'), '{"status":"passed","checks":[],"results":[],"failures":[]}')
  }

  proof(dir, 'report', '--prune', '--keep', '2')
  assert.deepEqual(ids(dir).sort((a, b) => Number(a) - Number(b)), ['10000', '10001'])
})

test('the kept runs are still readable afterwards', () => {
  const dir = withRuns(25)
  proof(dir, 'report', '--prune', '--keep', '5')

  assert.equal(proof(dir, 'report').exit, 0)
  assert.match(proof(dir, 'report', '--list').out, /0025/)
})

test('pruning twice changes nothing the second time', () => {
  const dir = withRuns(8)
  proof(dir, 'report', '--prune', '--keep', '5')
  const after = ids(dir)

  const second = proof(dir, 'report', '--prune', '--keep', '5')
  assert.equal(second.exit, 0)
  assert.match(second.out, /Nothing to prune/)
  assert.deepEqual(ids(dir), after)
})

test('--json reports what went, what stayed and what was freed', () => {
  const dir = withRuns(10)
  const out = JSON.parse(proof(dir, 'report', '--prune', '--keep', '4', '--json').stdout)

  assert.deepEqual(out.pruned, ['0001', '0002', '0003', '0004', '0005', '0006'])
  assert.equal(out.kept, 4)
  assert.ok(out.freed > 0)
  assert.deepEqual(out.failed, [])
})

test('--keep 0 is refused, so the most recent run survives a typo', () => {
  const dir = withRuns(3)
  const r = proof(dir, 'report', '--prune', '--keep', '0')

  assert.equal(r.exit, 2)
  assert.match(r.out, /--keep must be a positive whole number/)
  assert.equal(ids(dir).length, 3, 'and nothing was deleted')
})

test('pruning with no runs says so rather than reporting a successful no-op', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-prune-empty-'))
  mkdirSync(join(dir, '.proof'), { recursive: true })
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: t\n    run: "true"\n')

  const r = proof(dir, 'report', '--prune')
  assert.equal(r.exit, 2)
  assert.match(r.out, /no runs yet/)
})

test('a run it could not remove is reported, not counted as freed', () => {
  // reporting space that was never reclaimed is the failure mode worth guarding
  const dir = withRuns(6)
  const locked = join(dir, '.proof/runs/0001')
  chmodSync(locked, 0o500)          // no write bit: the child file cannot be unlinked
  try {
    const r = proof(dir, 'report', '--prune', '--keep', '2', '--json')
    const out = JSON.parse(r.stdout)
    if (out.failed.length === 0) return   // running as root: the permission does not bite
    assert.equal(r.exit, 1)
    assert.ok(!out.pruned.includes('0001'))
  } finally { chmodSync(locked, 0o700) }
})

test('the growth notice names the command that solves it', () => {
  const dir = withRuns(101)
  const r = proof(dir, 'check')

  assert.match(r.out, /proof report\s+--prune/, r.out)
  assert.doesNotMatch(r.out, /nothing else\s+reads them/, 'report reads them — that claim was false')
})

test('a run record that parses but is not one is named, not a raw TypeError', () => {
  // a file cut short at a record boundary still parses; the first reader to touch it died
  // with `Cannot read properties of undefined (reading 'length')`
  const dir = mkdtempSync(join(tmpdir(), 'proof-prune-partial-'))
  mkdirSync(join(dir, '.proof/runs/0001'), { recursive: true })
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: t\n    run: "true"\n')
  writeFileSync(join(dir, '.proof/runs/0001/result.json'), '{"status":"passed","results":[]}')

  const r = proof(dir, 'report', '--json')
  assert.equal(r.exit, 2)
  assert.doesNotMatch(r.out, /Cannot read properties/)
  assert.equal(JSON.parse(r.stdout).code, 'EBADRUN')
  assert.match(JSON.parse(r.stdout).error, /`failures` is missing or not an array/)
})
