import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * How anyone reporting a bug says which proof they ran, and the first thing typed after
 * installing. Both answered `unknown command "--version"` — which is not even a command.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const run = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: '/' })
  return { exit: r.status, out: (r.stdout + r.stderr).trim() }
}
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

test('--version prints the installed version and exits 0', () => {
  const r = run('--version')
  assert.equal(r.exit, 0)
  assert.equal(r.out, VERSION)
})

test('-v is the same', () => {
  assert.deepEqual(run('-v'), run('--version'))
})

test('the version is the one in package.json, not a copy that can drift', () => {
  // a hardcoded string is a second source of truth that goes stale at the next release
  assert.doesNotMatch(readFileSync(CLI, 'utf8'), new RegExp(`['"\`]${VERSION.replace(/\./g, '\\.')}['"\`]`))
  assert.match(run('--version').out, /^\d+\.\d+\.\d+/)
})

test('it works from any directory, with no contract in sight', () => {
  // `cwd: '/'` above — a version check must not need a project
  assert.equal(run('--version').exit, 0)
})

test('help is a command as well as a flag', () => {
  const r = run('help')
  assert.equal(r.exit, 0)
  assert.match(r.out, /verification CLI for AI coding agents/)
})

test('and all three spellings agree', () => {
  assert.equal(run('help').out, run('--help').out)
  assert.equal(run('-h').out, run('--help').out)
})

test('an unknown flag is not reported as an unknown command', () => {
  const r = run('--nope')
  assert.equal(r.exit, 2)
  assert.match(r.out, /unknown flag "--nope"/)
  assert.doesNotMatch(r.out, /unknown command/)
})

test('an unknown command still is one', () => {
  const r = run('nope')
  assert.equal(r.exit, 2)
  assert.match(r.out, /unknown command "nope"/)
})

test('the usage text lists both', () => {
  const usage = run('--help').out
  assert.match(usage, /proof help/)
  assert.match(usage, /proof --version/)
})
