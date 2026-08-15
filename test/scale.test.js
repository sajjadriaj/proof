import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check } from '../src/check.js'

const captured = async fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  let code
  try { code = await fn() } finally { console.log = real }
  return { out: lines.join('\n'), code }
}

/** A contract with `count` checks, of which `failing` indices exit non-zero. */
const bigContract = (count, failing = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-scale-'))
  process.chdir(dir)
  mkdirSync('.proof')

  const checks = Array.from({ length: count }, (_, i) =>
    `  - name: check number ${String(i + 1).padStart(3, '0')}\n    run: ${failing.includes(i + 1) ? 'exit 1' : '"true"'}`)
  writeFileSync('.proof/spec.yaml', `goal: a contract with many checks\nchecks:\n${checks.join('\n')}\n`)
  return dir
}

test('a contract with hundreds of checks runs, and reports the right verdict', async () => {
  const dir = bigContract(400, [50, 200, 399])
  const { code } = await captured(() => check({}))

  assert.equal(code, 1)
  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.equal(r.results.length, 400)
  assert.equal(r.failures.length, 3)
})

test('the regression: the verdict carries a tally', async () => {
  // Nobody counts 400 rows, and by the time the verdict appears the list has scrolled away.
  bigContract(400, [50, 200, 399])
  const { out } = await captured(() => check({}))

  assert.match(out, /VERDICT\n {2}NOT DONE\n {2}397 passed, 3 failed/)
})

test('a passing run tallies without a failure count', async () => {
  bigContract(3)
  const { out } = await captured(() => check({}))

  assert.match(out, /VERDICT\n {2}DONE\n {2}3 passed/)
  assert.doesNotMatch(out, /0 failed/, 'a zero is noise')
})

test('the tally sits under the subset verdict rather than running on from it', async () => {
  // The INCOMPLETE verdict already carries a sentence; appending produced two em-dashes
  // in one line.
  bigContract(3)
  const { out } = await captured(() => check({ only: 'number 001' }))

  assert.match(out, /INCOMPLETE — selected checks passed[^\n]*\n {2}1 passed/)
})

test('every line stays within the terminal width at scale', async () => {
  bigContract(200, [7])
  const { out } = await captured(() => check({}))

  for (const line of out.split('\n')) assert.ok(line.length <= 100, `${line.length}: ${line}`)
})

test('the evidence stays proportionate', async () => {
  // 400 checks that each print nothing should not produce a large bundle.
  const dir = bigContract(400)
  await captured(() => check({}))

  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  const log = readFileSync(join(dir, '.proof/runs/0001/commands.log'), 'utf8')

  assert.equal(r.results.length, 400)
  assert.ok(log.length < 200_000, `commands.log was ${log.length} bytes`)
})

test('the regression: the stored request log is bounded, and says how much it dropped', async () => {
  // Found after overwriting a test file: nothing failed when the cap was disabled, so the
  // guard was unprotected. A browser flow on a media-heavy page makes thousands of requests.
  const { boundEnds, REQUEST_CAP } = await import('../src/browser.js')

  const many = Array.from({ length: REQUEST_CAP * 3 }, (_, i) => ({ n: i }))
  const kept = boundEnds(many, REQUEST_CAP)

  assert.ok(kept.length <= REQUEST_CAP, `kept ${kept.length}`)
  assert.equal(kept[0].n, 0, 'the first requests are kept')
  assert.equal(kept[kept.length - 1].n, many.length - 1, 'and the last')
})

test('a list within the cap is returned untouched', async () => {
  const { boundEnds } = await import('../src/browser.js')
  const few = [{ n: 1 }, { n: 2 }]

  assert.equal(boundEnds(few, 1000), few, 'the same array, not a copy')
})

test('the live list is not modified by bounding what is stored', async () => {
  // `expect_request` slices the live array by index; bounding it in place would break that.
  const { boundEnds, REQUEST_CAP } = await import('../src/browser.js')

  const many = Array.from({ length: REQUEST_CAP * 2 }, (_, i) => ({ n: i }))
  boundEnds(many, REQUEST_CAP)

  assert.equal(many.length, REQUEST_CAP * 2, 'the source is untouched')
})

test('the dropped count is the difference', async () => {
  const { boundEnds } = await import('../src/browser.js')
  const many = Array.from({ length: 100 }, (_, i) => i)
  const kept = boundEnds(many, 10)

  assert.equal(many.length - kept.length, 90)
})
