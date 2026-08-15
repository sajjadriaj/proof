import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changedFiles } from '../src/git.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

/** A branch that forked before main advanced — the ordinary state of any open PR. */
const diverged = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fork-'))
  process.chdir(dir)
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  writeFileSync('src/base.js', 'base\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  git('checkout', '-q', '-b', 'feature')
  writeFileSync('src/mine.js', 'mine\n')
  git('add', '-A')
  git('commit', '-qm', 'mine')

  git('checkout', '-q', 'main')
  writeFileSync('src/theirs.js', 'theirs\n')
  git('add', '-A')
  git('commit', '-qm', 'theirs')

  git('checkout', '-q', 'feature')
  return dir
}

test('the regression: --base names what this branch changed, not how it differs from main', () => {
  diverged()
  const files = changedFiles('main')

  assert.ok(files.includes('src/mine.js'), 'the branch\'s own change is reported')
  assert.ok(
    !files.includes('src/theirs.js'),
    `main's own later commit was attributed to this branch: ${JSON.stringify(files)}`,
  )
})

test('uncommitted work still counts — the fork point is two-dot, not three', () => {
  diverged()
  writeFileSync('src/wip.js', 'not committed\n')
  writeFileSync('src/base.js', 'edited, not committed\n')

  const files = changedFiles('main')
  assert.ok(files.includes('src/wip.js'), 'an untracked file is in scope')
  assert.ok(files.includes('src/base.js'), 'an unstaged edit is in scope')
  assert.ok(!files.includes('src/theirs.js'))
})

test('staged work counts too', () => {
  diverged()
  writeFileSync('src/staged.js', 'staged\n')
  git('add', 'src/staged.js')

  assert.ok(changedFiles('main').includes('src/staged.js'))
})

test('a branch behind main reports only its own working-tree changes', () => {
  // merge-base(main, HEAD) is HEAD itself here — nothing was committed on this branch.
  diverged()
  git('checkout', '-q', 'main')
  git('checkout', '-q', '-b', 'stale-branch')
  git('reset', '-q', '--hard', 'HEAD~1')
  writeFileSync('src/only-mine.js', 'x\n')

  const files = changedFiles('main')
  assert.deepEqual(files, ['src/only-mine.js'])
})

test('the default base is unchanged', () => {
  diverged()
  writeFileSync('src/wip.js', 'x\n')

  assert.deepEqual(changedFiles(), ['src/wip.js'], 'HEAD still means the working tree')
})

test('an unrelated ref still fails loudly rather than reading as "nothing changed"', () => {
  diverged()
  assert.throws(() => changedFiles('no-such-branch'), /unknown git ref/)
})

/** The same divergence, with a dependency bump on the branch and a different one on main. */
const divergedDeps = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fork-deps-'))
  process.chdir(dir)
  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  writeFileSync('package.json', JSON.stringify({ dependencies: { lodash: '1.0.0' } }))
  git('add', '-A')
  git('commit', '-qm', 'init')

  git('checkout', '-q', '-b', 'feature')
  writeFileSync('package.json', JSON.stringify({ dependencies: { lodash: '2.0.0' } }))
  git('add', '-A')
  git('commit', '-qm', 'bump lodash')

  git('checkout', '-q', 'main')
  writeFileSync('package.json', JSON.stringify({ dependencies: { lodash: '1.0.0', express: '9.9.9' } }))
  git('add', '-A')
  git('commit', '-qm', 'main adds express')

  git('checkout', '-q', 'feature')
  return dir
}

test('the regression: a package main added is not reported as one this branch removed', async () => {
  const { dependencyChanges } = await import('../src/changed.js')
  divergedDeps()

  const changes = dependencyChanges('main')
  const express = changes.find(d => d.name === 'express')
  assert.equal(express, undefined, `main's own addition was reported as this branch's change: ${JSON.stringify(changes)}`)

  assert.deepEqual(changes, [{ name: 'lodash', from: '1.0.0', to: '2.0.0', manifest: 'package.json' }])
})

test('a genuine removal on the branch is still reported', async () => {
  const { dependencyChanges } = await import('../src/changed.js')
  divergedDeps()
  writeFileSync('package.json', JSON.stringify({ dependencies: {} }))

  const changes = dependencyChanges('main')
  assert.deepEqual(changes, [{ name: 'lodash', from: '1.0.0', to: null, manifest: 'package.json' }])
})
