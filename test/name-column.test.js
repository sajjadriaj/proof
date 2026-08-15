import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { check, TERMINAL_WIDTH } from '../src/check.js'
import { report } from '../src/report.js'

const LONG = 'verify that the checkout flow completes correctly when the customer has a saved '
  + 'card and a coupon applied and the inventory service is slow'

const captured = async fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { await fn() } finally { console.log = real }
  return lines.join('\n')
}

const run = async checks => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-namecol-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({ goal: 'long names', checks }))
  const out = await captured(() => check({}))
  return { dir, out }
}

test('the regression: one long name does not widen every row past the terminal', async () => {
  const { out } = await run([
    { name: 'short', run: 'true' },
    { name: LONG, run: 'true' },
  ])

  const widest = Math.max(...out.split('\n').map(l => l.length))
  assert.ok(widest <= TERMINAL_WIDTH, `widest line was ${widest} characters`)
})

test('the truncated name is marked as truncated', async () => {
  const { out } = await run([{ name: LONG, run: 'true' }])
  const row = out.split('\n').find(l => l.includes('verify that'))

  assert.match(row, /…\s+PASS$/, `got: ${row}`)
  assert.ok(row.includes(LONG.slice(0, 40)), 'the beginning is still readable')
})

test('the full name survives in the evidence and the report', async () => {
  const { dir } = await run([{ name: LONG, run: 'true' }])

  const result = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.deepEqual(Object.keys(result.checks), [LONG], 'the results map keeps the whole name')

  await captured(() => report({}))
  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
  assert.ok(md.includes(LONG), 'the report is not a terminal and keeps it whole')
})

test('short names are untouched and the column stays snug', async () => {
  const { out } = await run([
    { name: 'alpha', run: 'true' },
    { name: 'bravo', run: 'true' },
  ])

  const rows = out.split('\n').filter(l => /\bPASS$/.test(l))
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.ok(row.length < 30, `row is ${row.length} characters: ${row}`)
    assert.doesNotMatch(row, /…/)
  }
})

test('double-width names are truncated by display width, not character count', async () => {
  const cjk = '日'.repeat(60) // 120 display columns
  const { out } = await run([{ name: cjk, run: 'true' }])

  const row = out.split('\n').find(l => l.includes('日'))
  const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/
  const width = [...row].reduce((n, ch) => n + (wide.test(ch) ? 2 : 1), 0)

  assert.ok(width <= TERMINAL_WIDTH, `row occupies ${width} columns`)
  assert.match(row, /…/)
})
