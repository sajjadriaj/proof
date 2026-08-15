import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { validateSpec } from '../src/validate.js'
import { check } from '../src/check.js'

const sandbox = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-names-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(contract))
  return dir
}

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const resultOf = dir => JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

test('the regression: a duplicate name is a contract error, not a silently replaced result', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [
      { name: 'api works', run: 'exit 1' },
      { name: 'api works', run: 'true' },
    ],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /check\[1\] "api works": duplicate check name \(also check\[0\] "api works"\)/)
  assert.match(p[0], /results, evidence files and --only/)
})

test('names that differ only by case or punctuation still collide in evidence filenames', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [{ name: 'API Works', run: 'true' }, { name: 'api-works', run: 'true' }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /duplicate check name/)
})

test('distinct names pass clean', () => {
  assert.deepEqual(validateSpec({
    goal: 'g',
    checks: [{ name: 'api works', run: 'true' }, { name: 'api fails', run: 'true' }],
  }), [])
})

test('unnamed checks get distinct generated names instead of collapsing', async () => {
  const dir = sandbox({
    goal: 'unnamed checks',
    checks: [{ file: 'present.txt' }, { file: 'absent.txt' }],
  })
  writeFileSync('present.txt', 'x')

  assert.equal(await quiet(() => check({ json: true })), 1)
  const r = resultOf(dir)

  assert.deepEqual(r.checks, { 'file check 1': 'passed', 'file check 2': 'failed' })
  assert.equal(r.results.length, 2, 'both checks are reported')
})

test('every executed check appears in the results map', async () => {
  const dir = sandbox({
    goal: 'no collapsing',
    checks: [
      { name: 'one', run: 'exit 1' },
      { name: 'two', run: 'true' },
      { file: 'nope.txt' },
    ],
  })
  assert.equal(await quiet(() => check({ json: true })), 1)

  const r = resultOf(dir)
  assert.equal(Object.keys(r.checks).length, r.results.length)
  assert.equal(r.checks.one, 'failed', 'a failed check is never reported as passed')
})

test('two browser checks cannot overwrite each other\'s evidence bundle', async () => {
  // rejected at load, so the collision can never reach the filesystem
  const p = validateSpec({
    goal: 'g',
    checks: [
      { name: 'login flow', browser: { base_url: 'http://x.test', visit: '/a' } },
      { name: 'login flow', browser: { base_url: 'http://x.test', visit: '/b' } },
    ],
  })
  assert.match(p[0], /duplicate check name/)
})
