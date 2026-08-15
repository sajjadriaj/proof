import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { check } from '../src/check.js'
import { report } from '../src/report.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const project = async (checks = '  - name: a\n    run: "true"\n') => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-stale-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('.proof')
  writeFileSync('app.js', 'v1\n')
  writeFileSync('.proof/spec.yaml', `goal: g\nchecks:\n${checks}`)
  git('add', '-A')
  git('commit', '-qm', 'init')
  await quiet(() => check({ json: true }))
  return dir
}

test('the regression: a stale report does not exit 0', async () => {
  // The report said STALE and --json said stale:true, but the exit code still said pass,
  // so `proof report && deploy` shipped on results describing an older tree.
  await project()
  assert.equal(await quiet(() => report({})), 0, 'a fresh run still passes')

  writeFileSync('app.js', 'v2 — edited after the run\n')
  assert.equal(await quiet(() => report({})), 1, 'a stale run cannot claim done')
})

test('--json is stale too, and says so in the payload', async () => {
  await project()
  writeFileSync('app.js', 'v2\n')

  let out = ''
  const real = console.log
  console.log = s => { out += s }
  let code
  try { code = report({ json: true }) } finally { console.log = real }

  assert.equal(code, 1)
  assert.equal(JSON.parse(out).stale, true)
})

test('a passing run whose tree has not moved still exits 0', async () => {
  await project()
  assert.equal(await quiet(() => report({})), 0)
  assert.equal(await quiet(() => report({ json: true })), 0)
})

test('a failing run exits 1 whether or not it is stale', async () => {
  await project('  - name: a\n    run: exit 3\n')
  assert.equal(await quiet(() => report({})), 1)

  writeFileSync('app.js', 'v2\n')
  assert.equal(await quiet(() => report({})), 1)
})
