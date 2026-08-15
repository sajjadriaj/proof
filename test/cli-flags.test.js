import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import YAML from 'yaml'

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-flags-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), YAML.stringify({
    goal: 'flags',
    checks: [{ name: 'alpha', run: 'true' }, { name: 'bravo', run: 'true' }],
  }))
  return dir
}

const runCli = (dir, args) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { cwd: dir }, (err, stdout, stderr) =>
    resolve({ code: err?.code ?? 0, stdout, stderr }))
})

test('the regression: an unknown flag stops the run instead of being ignored', async () => {
  const dir = sandbox()
  const { code, stdout, stderr } = await runCli(dir, ['check', '--dry-run'])

  assert.equal(code, 2)
  assert.match(stderr, /unknown flag --dry-run/)
  assert.doesNotMatch(stdout, /DONE/, 'a misread request must not execute')
  assert.equal(existsSync(join(dir, '.proof/runs')), false, 'and must have no side effects')
})

test('the error lists what the command does accept', async () => {
  const dir = sandbox()
  const { stderr } = await runCli(dir, ['check', '--dry-run'])
  assert.match(stderr, /`proof check` accepts: --json, --only, --spec/)
})

test('a near-miss flag gets a suggestion', async () => {
  const dir = sandbox()
  assert.match((await runCli(dir, ['check', '--onyl', 'alpha'])).stderr, /did you mean --only\?/)
  assert.match((await runCli(dir, ['report', '--lst'])).stderr, /did you mean --list\?/)
})

test('the regression: a value flag with no value is refused, not silently dropped', async () => {
  const dir = sandbox()
  const { code, stdout, stderr } = await runCli(dir, ['check', '--only'])

  assert.equal(code, 2)
  assert.match(stderr, /--only needs a value/)
  assert.doesNotMatch(stdout, /alpha/, 'the whole contract must not run under a subset request')
})

test('a value flag swallowed by the next flag is caught too', async () => {
  const dir = sandbox()
  const { code, stdout } = await runCli(dir, ['check', '--only', '--json'])
  assert.equal(code, 2)
  // --json appears in argv, so the error is reported as JSON rather than swallowing it
  assert.match(JSON.parse(stdout).error, /--only needs a value/)
  assert.match(JSON.parse(stdout).error, /use --only=<value> if it starts with "--"/)
})

test('the same mistake without --json reports on stderr', async () => {
  const dir = sandbox()
  const { code, stderr } = await runCli(dir, ['check', '--only', '--list'])
  assert.equal(code, 2)
  assert.match(stderr, /--only needs a value/)
})

test('the = form still accepts values that look like flags', async () => {
  const dir = sandbox()
  const { code, stderr } = await runCli(dir, ['check', '--only=--weird'])
  assert.equal(code, 2)
  assert.match(stderr, /no check matches "--weird"/, 'parsed as a value, then reported by the matcher')
})

test('flags valid for one command are rejected for another', async () => {
  const dir = sandbox()
  assert.match((await runCli(dir, ['changed', '--only', 'alpha'])).stderr, /unknown flag --only/)
  assert.match((await runCli(dir, ['check', '--depth', '2'])).stderr, /unknown flag --depth/)
  assert.match((await runCli(dir, ['init', 'x', '--list'])).stderr, /unknown flag --list/)
})

test('--json is accepted everywhere, and errors honour it', async () => {
  const dir = sandbox()
  const { code, stdout } = await runCli(dir, ['check', '--json', '--dry-run'])
  assert.equal(code, 2)
  assert.match(JSON.parse(stdout).error, /unknown flag --dry-run/)
})

test('valid invocations are unaffected', async () => {
  const dir = sandbox()
  const subset = await runCli(dir, ['check', '--only', 'alpha'])
  assert.equal(subset.code, 0)
  assert.match(subset.stdout, /selected 1 of 2 check\(s\)/)

  const full = await runCli(dir, ['check'])
  assert.equal(full.code, 0)
  assert.equal(readdirSync(join(dir, '.proof/runs')).length, 2)
})
