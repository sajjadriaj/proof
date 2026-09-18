import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import YAML from 'yaml'

// Flags and values proof accepted and then did not act on. Each one produced a run that
// answered a different question from the one asked, and said nothing about the substitution.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-misread-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), YAML.stringify({
    goal: 'misreads',
    checks: [{ name: 'alpha', run: 'true' }, { name: 'bravo', run: 'true' }],
  }))
  return dir
}

const runCli = (dir, args) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { cwd: dir }, (err, stdout, stderr) =>
    resolve({ code: err?.code ?? 0, out: stdout + stderr }))
})

test('the regression: an empty --only ran the whole contract and reported DONE', async () => {
  const dir = sandbox()
  // Every check name contains the empty string, so the filter selected all of them: a run
  // asking for a subset made the completion claim `--only` exists to withhold.
  for (const args of [['check', '--only', ''], ['check', '--only=']]) {
    const { code, out } = await runCli(dir, args)
    assert.equal(code, 2, `${args.join(' ')} should be refused`)
    assert.match(out, /--only was given an empty value/)
    assert.doesNotMatch(out, /DONE/)
  }
})

test('a real --only still selects its subset', async () => {
  const { code, out } = await runCli(sandbox(), ['check', '--only', 'alpha'])
  assert.equal(code, 0)
  assert.match(out, /INCOMPLETE/)
})

test('every value flag refuses an empty value, not just --only', async () => {
  const { code, out } = await runCli(sandbox(), ['changed', '--base', ''])
  assert.equal(code, 2)
  assert.match(out, /--base was given an empty value/)
})

test('a flag that only means something with another one is refused, not ignored', async () => {
  // `proof report --keep 5` reads as "prune to five" and rendered the latest report instead.
  const dir = sandbox()
  await runCli(dir, ['check'])

  const keep = await runCli(dir, ['report', '--keep', '5'])
  assert.equal(keep.code, 2)
  assert.match(keep.out, /--keep only applies with --prune/)

  const all = await runCli(dir, ['report', '--all'])
  assert.equal(all.code, 2)
  assert.match(all.out, /--all only applies with --list/)

  // and the combinations that do mean something still work
  assert.equal((await runCli(dir, ['report', '--prune', '--keep', '5'])).code, 0)
  assert.equal((await runCli(dir, ['report', '--list', '--all'])).code, 0)
})
