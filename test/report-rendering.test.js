import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { report, markdown } from '../src/report.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

/** markdown() straight from a result, for shapes a real run will not produce on demand. */
const renderResult = extra => markdown({
  status: 'failed',
  goal: 'g',
  run: '.proof/runs/0001',
  at: 'now',
  results: [],
  failures: [],
  warnings: [],
  ...extra,
})

const renderRun = async contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-render-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(contract))
  await quiet(() => check({ json: true }))
  await quiet(() => report({}))
  return readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
}

// the row for `name` as a markdown renderer would split it
const rowCells = (md, startsWith) => md
  .split('\n')
  .find(l => l.startsWith(`| ${startsWith}`))
  ?.split(/(?<!\\)\|/)
  .slice(1, -1)
  .map(c => c.trim())

test('the regression: a pipe in a check name does not shift the table columns', async () => {
  const md = await renderRun({
    goal: 'rendering fidelity',
    checks: [{ name: 'checkout | refund path', run: 'true' }],
  })

  const cells = rowCells(md, 'checkout')
  assert.equal(cells.length, 4, `row split into ${cells.length} cells: ${JSON.stringify(cells)}`)
  assert.equal(cells[0], 'checkout \\| refund path')
  assert.equal(cells[1], '`true`, exit 0', 'the assertion column is intact, not part of the name')
  assert.equal(cells[2], 'PASS', 'the result is still the result')
})

test('the regression: a fence in the output does not escape the code block', async () => {
  const md = await renderRun({
    goal: 'rendering fidelity',
    checks: [{ name: 'prints a fence', run: "printf 'before\\n```\\nafter\\n'; exit 1" }],
  })

  const fenceLine = md.split('\n').find(l => /^`{4,}$/.test(l))
  assert.ok(fenceLine, 'the block uses a longer fence than the content contains')

  // everything between the opening and closing fence is the captured output, intact
  const lines = md.split('\n')
  const open = lines.indexOf(fenceLine)
  const close = lines.indexOf(fenceLine, open + 1)
  assert.ok(close > open, 'the block is closed by a matching fence')
  const block = lines.slice(open + 1, close).join('\n')
  assert.match(block, /before/)
  assert.match(block, /```/, 'the inner backticks are preserved as content')
  assert.match(block, /after/)
})

test('a goal spanning lines stays on its own line', () => {
  const md = markdown({
    status: 'passed',
    goal: 'first line\nsecond line',
    run: '.proof/runs/0001',
    at: 'now',
    results: [],
    failures: [],
  })
  const line = md.split('\n').find(l => l.startsWith('**Requirement:**'))
  assert.equal(line, '**Requirement:** first line second line')
})

test('backticks in a console error do not break the inline code span', () => {
  const md = markdown({
    status: 'passed',
    run: '.proof/runs/0001',
    at: 'now',
    results: [{
      name: 'flow',
      kind: 'browser',
      status: 'passed',
      ms: 1,
      consoleErrors: [{ text: 'cannot read `foo` of undefined', at: 'app.js:1' }],
    }],
    failures: [],
  })
  const line = md.split('\n').find(l => l.includes('cannot read'))
  assert.match(line, /^- ``cannot read `foo` of undefined``/, `got: ${line}`)
})

test('an evidence path containing a backtick keeps its name and a working link', () => {
  // The name goes in a code span so a backtick cannot break it, and the href is encoded so
  // a space or a bracket cannot truncate the link. Rare but real: check names become
  // filenames.
  const md = renderResult({
    failures: [{ check: 'c', expected: 'e', observed: 'o', output: null, evidence: ['.proof/runs/0001/we`ird.png'] }],
  })

  assert.match(md, /!\[we`ird\]\(we%60ird\.png\)/, md)
})

test('a path with a space is encoded rather than left to break the link', () => {
  const md = renderResult({
    failures: [{ check: 'c', expected: 'e', observed: 'o', output: null, evidence: ['.proof/runs/0001/two words.txt'] }],
  })

  assert.match(md, /`two words\.txt` → \[open\]\(two%20words\.txt\)/, md)
})
