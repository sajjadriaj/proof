import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { report, isStale, listRunsDetailed } from '../src/report.js'

const repo = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-stale-'))
  process.chdir(dir)
  execFileSync('git', ['init', '-q', '.'], { stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@t.t'], { stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { stdio: 'ignore' })
  writeFileSync('app.js', 'export const version = "1.0.0"\n')
  writeFileSync('.gitignore', '.proof/runs/\n')
  execFileSync('git', ['add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['commit', '-qm', 'init'], { stdio: 'ignore' })
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(contract))
  return dir
}

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

const CONTRACT = {
  goal: 'the app reports version 1.0.0',
  checks: [{ name: 'version is 1.0.0', file: { path: 'app.js', contains: '1.0.0' } }],
}

test('the regression: a report whose code has changed says it is stale', async () => {
  const dir = repo(CONTRACT)
  await quiet(() => check({ json: true }))

  // rewrite the app so the verified claim is now false
  writeFileSync('app.js', 'export const version = "BROKEN"\n')

  await quiet(() => report({}))
  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')

  assert.match(md, /\*\*Verdict:\*\* DONE — STALE/)
  assert.match(md, /the working tree has changed since this run/)
  assert.match(md, /Re-run `proof check` for a verdict about the current tree/)
})

test('an untouched tree produces no staleness marker', async () => {
  const dir = repo(CONTRACT)
  await quiet(() => check({ json: true }))
  await quiet(() => report({}))

  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
  assert.match(md, /\*\*Verdict:\*\*/, 'a report was rendered')
  assert.doesNotMatch(md, /STALE/)
  assert.doesNotMatch(md, /has changed since this run/)
})

test('--list marks the stale runs', async () => {
  repo(CONTRACT)
  await quiet(() => check({ json: true }))
  assert.doesNotMatch(await captured(() => report({ list: true })), /stale/)

  writeFileSync('app.js', 'export const version = "2.0.0"\n')
  assert.match(await captured(() => report({ list: true })), /\(stale\)/)
  assert.equal(listRunsDetailed()[0].stale, true)
})

test('staleness is exposed to agents in --json', async () => {
  repo(CONTRACT)
  await quiet(() => check({ json: true }))
  writeFileSync('app.js', 'export const version = "2.0.0"\n')

  const out = await captured(() => report({ json: true }))
  assert.equal(JSON.parse(out).stale, true)
})

test('outside a git repository nothing is ever called stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-nogit-stale-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({ goal: 'g', checks: [{ name: 'a', run: 'true' }] }))

  await quiet(() => check({ json: true }))
  const result = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.equal(result.tree, null)
  assert.equal(isStale(result), false)
})

test('the advisory names what is actually missing, not a verb the contract never used', async () => {
  const dir = repo(CONTRACT) // one `file:` check, no `run:` checks at all
  await quiet(() => check({ json: true }))

  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.match(r.advisory, /Nothing in this contract exercises the running application/)
  assert.doesNotMatch(r.advisory, /Every check here is a `run:` command/)
})
