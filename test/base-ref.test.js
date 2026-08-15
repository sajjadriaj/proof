import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changed } from '../src/changed.js'
import { infer } from '../src/infer.js'
import { changedFiles, refExists } from '../src/git.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-baseref-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('src/a.ts', 'export const a = 1\n')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: x\n    run: "true"\n')
  git('add', '-A')
  git('commit', '-qm', 'first')
  git('branch', '-q', 'feature')
  writeFileSync('src/b.ts', 'export const b = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'second')
  return dir
}

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

test('the regression: an unknown base ref is an error, not an empty diff', () => {
  repo()
  assert.throws(() => changedFiles('no-such-ref'), /unknown git ref "no-such-ref"/)
  assert.throws(() => changed({ base: 'no-such-ref' }), /unknown git ref "no-such-ref"/)
  assert.throws(() => infer({ base: 'no-such-ref' }), /unknown git ref "no-such-ref"/)
})

test('a real ref still resolves, and refExists agrees', () => {
  repo()
  assert.equal(refExists('feature'), true)
  assert.equal(refExists('HEAD'), true)
  assert.equal(refExists('no-such-ref'), false)
  assert.deepEqual(changedFiles('feature'), ['src/b.ts'])
})

test('the empty message names the ref that was actually used', () => {
  repo()
  assert.match(captured(() => changed({})), /No changes against HEAD/)
  assert.match(captured(() => changed({ base: 'HEAD' })), /No changes against HEAD/)

  // diffing against the current branch tip by name is also empty, and must say so by name
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.match(captured(() => changed({ base: branch })), new RegExp(`No changes against ${branch}`))
})

test('--json carries the base so an agent knows what the diff was against', () => {
  repo()
  const out = captured(() => changed({ json: true, base: 'feature' }))
  const parsed = JSON.parse(out)
  assert.equal(parsed.base, 'feature')
  assert.deepEqual(parsed.changed, ['src/b.ts'])
})

test('a repository with no commits yet still works with the default base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-unborn-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  writeFileSync('a.ts', 'export const a = 1\n')

  // unborn HEAD: no commit to diff against, but untracked files are still the change
  assert.deepEqual(changedFiles(), ['a.ts'])
})

test('outside a git repository an explicit ref is not second-guessed', () => {
  process.chdir(mkdtempSync(join(tmpdir(), 'proof-nogit-ref-')))
  assert.deepEqual(changedFiles('main'), [], 'no repo, nothing to compare, no false error')
})
