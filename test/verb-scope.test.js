import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { check } from '../src/check.js'

const sandbox = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-scope-'))
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

test('the regression: a directory does not satisfy the file verb', async () => {
  const dir = sandbox({
    goal: 'build output exists',
    checks: [{ name: 'bundle was produced', file: 'dist/bundle.js' }],
  })
  mkdirSync('dist/bundle.js', { recursive: true })

  assert.equal(await quiet(() => check({ json: true })), 1)
  const f = resultOf(dir).failures[0]
  assert.match(f.expected, /dist\/bundle\.js is a file/)
  assert.match(f.observed, /is a directory — use `run: test -d dist\/bundle\.js`/)
})

test('contains on a directory says so instead of surfacing EISDIR', async () => {
  const dir = sandbox({
    goal: 'g',
    checks: [{ name: 'bundle mentions version', file: { path: 'dist/bundle.js', contains: '1.0.0' } }],
  })
  mkdirSync('dist/bundle.js', { recursive: true })

  assert.equal(await quiet(() => check({ json: true })), 1)
  assert.doesNotMatch(resultOf(dir).failures[0].observed, /EISDIR/)
  assert.match(resultOf(dir).failures[0].observed, /is a directory/)
})

test('a real file, and a symlink to one, still pass', async () => {
  const dir = sandbox({
    goal: 'g',
    checks: [
      { name: 'real', file: { path: 'real.txt', contains: 'hello' } },
      { name: 'linked', file: 'link.txt' },
    ],
  })
  writeFileSync('real.txt', 'hello world')
  symlinkSync(join(dir, 'real.txt'), join(dir, 'link.txt'))

  assert.equal(await quiet(() => check({ json: true })), 0)
})

test('exists: false is unaffected by the file/directory distinction', async () => {
  sandbox({ goal: 'g', checks: [{ name: 'no leftovers', file: { path: 'nope', exists: false } }] })
  assert.equal(await quiet(() => check({ json: true })), 0)
})

test('the env verb names whose environment it read', async () => {
  const dir = sandbox({
    goal: 'g',
    checks: [{ name: 'key set', env: 'PROOF_SCOPE_TEST' }, { name: 'key unset', env: 'PROOF_SCOPE_MISSING' }],
  })
  process.env.PROOF_SCOPE_TEST = 'x'
  delete process.env.PROOF_SCOPE_MISSING
  try {
    assert.equal(await quiet(() => check({ json: true })), 1)
    const r = resultOf(dir)
    assert.match(r.results[0].observed, /set in proof's environment/)
    assert.match(r.failures[0].expected, /set in proof's environment/)
  } finally { delete process.env.PROOF_SCOPE_TEST }
})

test('the env verb still never echoes the value', async () => {
  const dir = sandbox({ goal: 'g', checks: [{ name: 'secret', env: { name: 'PROOF_SECRET', matches: '^sk_live' } }] })
  process.env.PROOF_SECRET = 'sk_test_shouldnotappear'
  try {
    assert.equal(await quiet(() => check({ json: true })), 1)
    assert.doesNotMatch(JSON.stringify(resultOf(dir)), /shouldnotappear/)
  } finally { delete process.env.PROOF_SECRET }
})
