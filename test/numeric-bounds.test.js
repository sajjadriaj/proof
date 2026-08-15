import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
import { validateSpec } from '../src/validate.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')
const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-bounds-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('src/a.ts', 'export const a = 1\n')
  writeFileSync('src/b.ts', "import { a } from './a'\n")
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: x\n    run: "true"\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync('src/a.ts', 'export const a = 2\n')
  return dir
}

const runCli = (dir, args) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { cwd: dir }, (err, stdout, stderr) =>
    resolve({ code: err?.code ?? 0, stdout, stderr }))
})

test('the regression: a non-numeric --depth is rejected, not answered with NaN', async () => {
  const dir = project()
  const { code, stdout, stderr } = await runCli(dir, ['changed', '--depth', 'abc'])

  assert.equal(code, 2)
  assert.match(stderr, /--depth must be a positive whole number \(got "abc"\)/)
  assert.doesNotMatch(stdout, /NaN/, 'NaN never reaches the user')
})

test('zero and negative depths are rejected too', async () => {
  const dir = project()
  for (const value of ['0', '-3', '1.5']) {
    const { code, stderr } = await runCli(dir, ['changed', '--depth', value])
    assert.equal(code, 2, `--depth ${value} should be refused`)
    assert.match(stderr, /positive whole number/)
  }
})

test('infer applies the same rule', async () => {
  const dir = project()
  const { code, stderr } = await runCli(dir, ['infer', '--depth', 'abc'])
  assert.equal(code, 2)
  assert.match(stderr, /--depth must be a positive whole number/)
})

test('a valid depth still works, and the default is unchanged', async () => {
  const dir = project()
  const two = await runCli(dir, ['changed', '--depth', '2'])
  assert.equal(two.code, 0)
  assert.match(two.stdout, /src\/b\.ts/)

  const none = await runCli(dir, ['changed'])
  assert.equal(none.code, 0)
  assert.match(none.stdout, /depth 1|src\/b\.ts/)
})

test('the regression: timeout 0 is a contract error, not a race', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [{ name: 'quick', timeout: 0, run: 'echo hello' }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /timeout: must be greater than 0 — proof has no "unlimited" timeout value/)
})

test('every timeout field is held to the rule', () => {
  const p = validateSpec({
    goal: 'g',
    serve: { run: 'x', ready_url: 'http://x.test', timeout: 0 },
    checks: [{
      name: 'a',
      browser: {
        base_url: 'http://x.test',
        visit: '/',
        flow: [{ expect_request: { path: '/a', timeout_ms: -1 } }],
      },
    }],
  })
  const joined = p.join('\n')
  assert.match(joined, /serve › timeout: must be greater than 0/)
  assert.match(joined, /expect_request › timeout_ms: must be greater than 0/)
})

test('a wrong type is still reported as a type problem, not a bounds one', () => {
  const p = validateSpec({ goal: 'g', checks: [{ name: 'a', timeout: 'soon', run: 'true' }] })
  assert.equal(p.length, 1)
  assert.match(p[0], /must be a number, got string/)
})

test('positive timeouts pass clean', () => {
  assert.deepEqual(validateSpec({
    goal: 'g',
    serve: { run: 'x', ready_url: 'http://x.test', timeout: 30 },
    checks: [{ name: 'a', timeout: 1, run: 'true' }],
  }), [])
})
