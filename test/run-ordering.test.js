import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRuns, resolveRun, listRunsDetailed } from '../src/report.js'

// a result.json is all a run directory needs to count as finished
const fabricate = ids => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-ordering-'))
  process.chdir(dir)
  for (const id of ids) {
    mkdirSync(join('.proof/runs', String(id)), { recursive: true })
    writeFileSync(join('.proof/runs', String(id), 'result.json'), JSON.stringify({
      status: 'passed',
      goal: `run ${id}`,
      at: '2026-01-01T00:00:00.000Z',
      results: [],
      failures: [],
    }))
  }
  return dir
}

test('the regression: runs past four digits keep their order', () => {
  fabricate(['9998', '9999', '10000', '10001'])
  assert.deepEqual(listRuns(), ['9998', '9999', '10000', '10001'])
})

test('the regression: the latest run is the newest, not the lexicographically last', () => {
  fabricate(['9998', '9999', '10000', '10001'])
  assert.equal(resolveRun(), join('.proof', 'runs', '10001'))
})

test('ordinary four-digit ids are unaffected', () => {
  fabricate(['0001', '0002', '0010', '0100'])
  assert.deepEqual(listRuns(), ['0001', '0002', '0010', '0100'])
  assert.equal(resolveRun(), join('.proof', 'runs', '0100'))
})

test('a run can be named by value, however it is written', () => {
  fabricate(['0001', '0002'])
  for (const id of ['1', '01', '0001', '00001']) {
    assert.equal(resolveRun(id), join('.proof', 'runs', '0001'), `"${id}" should name run 0001`)
  }
})

test('a five-digit id can be named directly', () => {
  fabricate(['9999', '10000'])
  assert.equal(resolveRun('10000'), join('.proof', 'runs', '10000'))
  assert.equal(resolveRun('9999'), join('.proof', 'runs', '9999'))
})

test('an id that names nothing still errors', () => {
  fabricate(['0001'])
  assert.throws(() => resolveRun('42'), /no run "42"/)
})

test('--list renders in the same numeric order', () => {
  fabricate(['9999', '10000', '10001'])
  assert.deepEqual(listRunsDetailed().map(r => r.id), ['9999', '10000', '10001'])
})

test('the id column stays aligned when ids widen', async () => {
  const { report } = await import('../src/report.js')
  fabricate(['9999', '10000', '10001'])

  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { report({ list: true }) } finally { console.log = real }

  const rows = lines.join('\n').split('\n').filter(l => /\b(PASS|FAIL|PART)\b/.test(l))
  assert.equal(rows.length, 3)
  const tagColumns = rows.map(l => l.indexOf('PASS'))
  assert.equal(new Set(tagColumns).size, 1, `verdict column drifts: ${JSON.stringify(tagColumns)}`)
})
