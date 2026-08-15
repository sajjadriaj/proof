import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { report, listRunsDetailed, LIST_LIMIT } from '../src/report.js'

const fabricate = count => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-listscale-'))
  process.chdir(dir)
  for (let i = 1; i <= count; i++) {
    const id = String(i).padStart(4, '0')
    mkdirSync(join('.proof/runs', id), { recursive: true })
    writeFileSync(join('.proof/runs', id, 'result.json'), JSON.stringify({
      status: 'passed',
      goal: `run ${id}`,
      at: '2026-01-01T00:00:00.000Z',
      results: [{ name: 'a', kind: 'run', status: 'passed', ms: 1 }],
      failures: [],
    }))
    writeFileSync(join('.proof/runs', id, 'commands.log'), 'x'.repeat(500))
  }
  return dir
}

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

test('the regression: a long history does not print a wall of rows', () => {
  fabricate(200)
  const out = captured(() => report({ list: true }))

  const rows = out.split('\n').filter(l => /\bPASS\b/.test(l))
  assert.equal(rows.length, LIST_LIMIT, `printed ${rows.length} rows`)
  assert.match(out, /200 run\(s\).*showing the 20 most recent, `--all` for the rest/)
})

test('the rows shown are the most recent ones', () => {
  fabricate(200)
  const out = captured(() => report({ list: true }))

  assert.match(out, /^ {2}0200 /m, 'the newest run is shown')
  assert.doesNotMatch(out, /^ {2}0001 /m, 'the oldest is not')
})

test('--all shows every run', () => {
  fabricate(50)
  const out = captured(() => report({ list: true, all: true }))

  assert.equal(out.split('\n').filter(l => /\bPASS\b/.test(l)).length, 50)
  assert.doesNotMatch(out, /showing the/)
})

test('the size total covers the whole directory, not just the rows shown', () => {
  fabricate(200)
  const shown = captured(() => report({ list: true }))
  const all = captured(() => report({ list: true, all: true }))

  const sizeOf = text => text.match(/, (\d+(?:\.\d+)? [A-Z]+) in/)[1]
  assert.equal(sizeOf(shown), sizeOf(all), 'a truncated listing must not understate the footprint')
})

test('only the shown runs are read from disk', () => {
  fabricate(200)
  assert.equal(listRunsDetailed({ limit: LIST_LIMIT }).length, LIST_LIMIT)
  assert.equal(listRunsDetailed().length, 200, 'unbounded by default for programmatic callers')
})

test('--json reports what it showed and what exists', () => {
  fabricate(200)
  const out = JSON.parse(captured(() => report({ list: true, json: true })))

  assert.equal(out.shown, LIST_LIMIT)
  assert.equal(out.total_runs, 200)
  assert.equal(out.runs.length, LIST_LIMIT)
  assert.ok(out.bytes > 0)
})

test('a short history is unaffected', () => {
  fabricate(3)
  const out = captured(() => report({ list: true }))

  assert.equal(out.split('\n').filter(l => /\bPASS\b/.test(l)).length, 3)
  assert.doesNotMatch(out, /showing the/)
  assert.match(out, /3 run\(s\)/)
})
