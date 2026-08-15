import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import YAML from 'yaml'

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-positional-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), YAML.stringify({
    goal: 'positionals',
    checks: [{ name: 'alpha', run: 'true' }, { name: 'bravo', run: 'true' }],
  }))
  return dir
}

const runCli = (dir, args) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { cwd: dir }, (err, stdout, stderr) =>
    resolve({ code: err?.code ?? 0, stdout, stderr }))
})

test('the regression: `check <name>` is refused, not answered with a full run', async () => {
  const dir = sandbox()
  const { code, stdout, stderr } = await runCli(dir, ['check', 'alpha'])

  assert.equal(code, 2)
  assert.match(stderr, /unexpected argument "alpha" — did you mean --only "alpha"\?/)
  assert.doesNotMatch(stdout, /DONE/)
  assert.equal(existsSync(join(dir, '.proof/runs')), false, 'nothing ran')
})

test('the regression: a second run id is refused rather than ignored', async () => {
  const dir = sandbox()
  await runCli(dir, ['check'])
  await runCli(dir, ['check'])

  const { code, stderr } = await runCli(dir, ['report', '0001', '0002'])
  assert.equal(code, 2)
  assert.match(stderr, /unexpected argument "0002"/)
  assert.match(stderr, /usage: proof report \[run\]/)
})

test('commands that take no arguments say so', async () => {
  const dir = sandbox()
  for (const cmd of ['changed', 'infer']) {
    const { code, stderr } = await runCli(dir, [cmd, 'nonsense'])
    assert.equal(code, 2, `${cmd} should refuse a bare argument`)
    assert.match(stderr, /unexpected argument "nonsense"/)
    assert.match(stderr, new RegExp(`usage: proof ${cmd}`))
  }
})

test('several extras are all named', async () => {
  const dir = sandbox()
  const { stderr } = await runCli(dir, ['changed', 'one', 'two'])
  assert.match(stderr, /unexpected arguments "one", "two"/)
})

test('init still takes a multi-word requirement unquoted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-positional-init-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo t' } }))

  const { code } = await runCli(dir, ['init', 'users', 'can', 'reset', 'a', 'password'])
  assert.equal(code, 0)

  const spec = YAML.parse(readFileSync(join(dir, '.proof/spec.yaml'), 'utf8'))
  assert.equal(spec.goal, 'users can reset a password')
})

test('valid invocations still work', async () => {
  const dir = sandbox()
  assert.equal((await runCli(dir, ['check'])).code, 0)
  assert.equal((await runCli(dir, ['check', '--only', 'alpha'])).code, 0)
  assert.equal((await runCli(dir, ['report'])).code, 0)
  assert.equal((await runCli(dir, ['report', '0001'])).code, 0)
})
