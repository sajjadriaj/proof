import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { report } from '../src/report.js'
import { changed } from '../src/changed.js'
import { TERMINAL_WIDTH } from '../src/terminal.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const LONG_GOAL = 'verify that customers can complete checkout with a saved card and a coupon '
  + 'while the inventory service is degraded and the audit log stays consistent'

const captured = async fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { await fn() } finally { console.log = real }
  return lines.join('\n')
}

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const project = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-rows-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('src/session.ts', 'export const session = 1\n')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: LONG_GOAL,
    checks: Array.from({ length: 8 }, (_, i) => ({ name: `session check number ${i + 1}`, run: 'true' })),
  }))
  git('add', '-A')
  git('commit', '-qm', 'init')
  await quiet(() => check({ json: true }))
  writeFileSync('src/session.ts', 'export const session = 2\n')
  return dir
}

test('the regression: a long goal does not stretch the run list', async () => {
  await project()
  const out = await captured(() => report({ list: true }))

  const widest = Math.max(...out.split('\n').map(l => l.length))
  assert.ok(widest <= TERMINAL_WIDTH, `widest line was ${widest} characters`)
  assert.match(out, /verify that customers can complete checkout/, 'the start of the goal is still shown')
  assert.match(out, /…/)
})

test('the regression: many checks naming one file are summarised, not listed in full', async () => {
  await project()
  const out = await captured(() => changed({}))

  const widest = Math.max(...out.split('\n').map(l => l.length))
  assert.ok(widest <= TERMINAL_WIDTH, `widest line was ${widest} characters`)

  // the contract is that shown names plus the count equal the total, whatever fits
  const row = out.split('\n').find(l => l.includes('src/session.ts —'))
  const shown = (row.match(/session check number \d+/g) ?? []).length
  const hidden = Number(row.match(/\+(\d+) more/)?.[1] ?? 0)

  assert.ok(shown > 0, `no names shown: ${row}`)
  assert.equal(shown + hidden, 8, `${shown} shown + ${hidden} hidden should account for all 8`)
  assert.doesNotMatch(row, /…/, 'the count survives rather than being cut off')
})

test('three or fewer checks are listed without a summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-rows-few-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('src/session.ts', 'export const session = 1\n')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'short',
    checks: [{ name: 'session alpha', run: 'true' }, { name: 'session bravo', run: 'true' }],
  }))
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync('src/session.ts', 'export const session = 2\n')

  const out = await captured(() => changed({}))
  assert.match(out, /src\/session\.ts — session alpha, session bravo$/m)
  assert.doesNotMatch(out, /more/)
})

test('the full goal and the full check list survive in --json', async () => {
  const dir = await project()
  const listed = JSON.parse(await captured(() => report({ list: true, json: true })))
  assert.equal(listed.runs[0].goal, LONG_GOAL, 'nothing is truncated in the data')

  const changedJson = JSON.parse(await captured(() => changed({ json: true })))
  const entry = changedJson.coverage.find(c => c.file === 'src/session.ts')
  assert.equal(entry.checks.length, 8, 'every naming check is still reported')
})

test('a short goal is left alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-rows-short-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({ goal: 'short goal', checks: [{ name: 'a', run: 'true' }] }))
  await quiet(() => check({ json: true }))

  const out = await captured(() => report({ list: true }))
  assert.match(out, /short goal$/m)
  assert.doesNotMatch(out, /…/)
})
