import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * `--list` read `r.results?.length ?? 0` and showed a structurally broken run as `PASS 0/0`,
 * while `proof report <id>` refused the same file as unreadable. The listing — the thing the
 * error message tells you to fall back to — was the more trusting of the two.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { exit: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

// every way a run directory can be broken, plus one that is fine
const SHAPES = {
  '0001': '{"status":"passed","results":[],"failures":[]}',   // readable, empty
  '0002': '{"status":"passed","results":[',                   // truncated mid-array
  '0003': '{"status":"passed"}',                              // parses, no arrays
  '0004': null,                                               // no result.json at all
  '0005': '{"status":"passed","results":{},"failures":[]}',   // right key, wrong type
  '0006': 'null',                                             // parses to null
}

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-listcons-'))
  mkdirSync(join(dir, '.proof/runs'), { recursive: true })
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: t\n    run: "true"\n')
  for (const [id, body] of Object.entries(SHAPES)) {
    mkdirSync(join(dir, '.proof/runs', id))
    if (body !== null) writeFileSync(join(dir, '.proof/runs', id, 'result.json'), body)
  }
  return dir
}

test('a row with a verdict is exactly a run report can read', () => {
  const dir = project()
  const { runs } = JSON.parse(proof(dir, 'report', '--list', '--json').stdout)
  assert.equal(runs.length, Object.keys(SHAPES).length)

  for (const row of runs) {
    const readable = proof(dir, 'report', row.id).exit === 0
    const claimsVerdict = row.status !== 'unreadable' && row.status !== 'incomplete'

    assert.equal(claimsVerdict, readable,
      `run ${row.id}: --list says ${row.status}, but report exits ${readable ? 0 : 'non-zero'}`)
  }
})

test('every broken shape is labelled, none silently counted as passing', () => {
  const dir = project()
  const { runs } = JSON.parse(proof(dir, 'report', '--list', '--json').stdout)
  const status = Object.fromEntries(runs.map(r => [r.id, r.status]))

  assert.equal(status['0001'], 'passed')
  assert.equal(status['0002'], 'unreadable')
  assert.equal(status['0003'], 'unreadable', 'parses, but has no results array')
  assert.equal(status['0004'], 'incomplete')
  assert.equal(status['0005'], 'unreadable', 'results is an object, not an array')
  assert.equal(status['0006'], 'unreadable')
})

test('and the count of runs without a verdict matches', () => {
  const dir = project()
  const r = proof(dir, 'report', '--list')
  assert.match(r.out, /5 without a verdict/)
})

test('a check count is never reported for a run whose checks could not be read', () => {
  const dir = project()
  const { runs } = JSON.parse(proof(dir, 'report', '--list', '--json').stdout)

  for (const row of runs.filter(r => r.status === 'unreadable')) {
    assert.equal(row.checks, 0)
    assert.equal(row.failed, 0)
  }
})
