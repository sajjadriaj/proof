import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

// One `.proof/runs` directory, many branches. A run recorded on another branch describes a
// state this commit never had, and the field that suffers most is the one an agent acts on
// hardest: "passed in run 12, fails now" means *you broke this*, and across a branch switch it
// was a sentence about somebody else's work.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

/** A repo where the feature exists on a branch and has never existed on main. */
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-branch-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, 'app.txt'), 'old\n')
  writeFileSync(join(dir, '.proof', 'spec.yaml'),
    'goal: the feature exists\nchecks:\n  - name: the feature is there\n    file: {path: app.txt, contains: "the feature"}\n')
  g('init', '-q', '-b', 'main', '.')
  g('config', 'user.email', 't@t.t')
  g('config', 'user.name', 't')
  g('add', '-A')
  g('commit', '-qm', 'base')
  return { dir, git: g }
}

test('a run from another branch is not this branch\'s baseline', () => {
  const { dir, git } = repo()
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'app.txt'), 'the feature\n')
  git('commit', '-qam', 'feature')
  assert.equal(proof(dir, 'check').code, 0, 'the feature branch passes')

  git('checkout', '-q', 'main')
  const r = proof(dir, 'check')

  assert.equal(r.code, 1, 'and main fails, because the feature is not there')
  assert.doesNotMatch(r.out, /Regression/, 'it never passed on this branch — claiming a regression is a lie')
  assert.doesNotMatch(r.out, /Not new/, 'and there is no comparable run to call it old news either')
})

test('a genuine regression on the same commit still reports as one', () => {
  const { dir, git } = repo()
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'app.txt'), 'the feature\n')
  git('commit', '-qam', 'feature')
  proof(dir, 'check')

  writeFileSync(join(dir, 'app.txt'), 'broken\n')
  const r = proof(dir, 'check')
  assert.match(r.out, /Regression:\n\s+passed in run 0001, fails now/)
})

test('the branch\'s own run outranks an older run at the shared base commit', () => {
  // Every branch descends from the base, so a run recorded there is an ancestor of all of them
  // and would win on recency alone. The run at this very commit is the one this run follows.
  const { dir, git } = repo()
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'app.txt'), 'the feature\n')
  git('commit', '-qam', 'feature')
  proof(dir, 'check')                       // 0001: passes, on feature's commit

  git('checkout', '-q', 'main')
  proof(dir, 'check')                       // 0002: fails, at the base commit

  git('checkout', '-q', 'feature')
  writeFileSync(join(dir, 'app.txt'), 'broken\n')
  const r = proof(dir, 'check')             // 0003: the baseline must be 0001, not 0002

  assert.match(r.out, /Regression:\n\s+passed in run 0001, fails now/)
})

test('a run on a merged branch is on this lineage, and is comparable again', () => {
  const { dir, git } = repo()
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'app.txt'), 'the feature\n')
  git('commit', '-qam', 'feature')
  proof(dir, 'check')                       // 0001: passes, on the branch

  git('checkout', '-q', 'main')
  git('merge', '-q', '--no-ff', '-m', 'merge', 'feature')
  writeFileSync(join(dir, 'app.txt'), 'broken after the merge\n')
  const r = proof(dir, 'check')

  assert.match(r.out, /Regression:\n\s+passed in run 0001, fails now/,
    'the branch run is in main\'s history now, so it really did used to pass here')
})

test('the completion gate refuses evidence recorded on another branch', () => {
  const { dir, git } = repo()
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'app.txt'), 'the feature\n')
  git('commit', '-qam', 'feature')
  proof(dir, 'check')

  git('checkout', '-q', 'main')
  const r = proof(dir, 'done')
  assert.equal(r.code, 1)
  assert.match(r.out, /VERDICT\n {2}INVALID/)
  assert.match(r.out, /Evidence\s+NOT ABOUT THIS CODE/)
  assert.match(r.out, /NEXT\n {2}proof check/)
})

test('the run listing says which branch each run came from, once there is more than one', () => {
  const { dir, git } = repo()
  proof(dir, 'check')
  git('checkout', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'app.txt'), 'the feature\n')
  git('commit', '-qam', 'feature')
  proof(dir, 'check')

  const r = proof(dir, 'report', '--list')
  assert.match(r.out, /0001\s+FAIL.*main/)
  assert.match(r.out, /0002\s+PASS.*feature/)

  const payload = JSON.parse(proof(dir, 'report', '--list', '--json').stdout)
  assert.deepEqual(payload.runs.map(x => x.branch), ['main', 'feature'])
})

test('outside a repository nothing changes — there are no branches to confuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-branch-none-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof', 'spec.yaml'),
    'goal: g\nchecks:\n  - name: marker\n    file: {path: app.txt, contains: "ready"}\n')
  writeFileSync(join(dir, 'app.txt'), 'ready\n')
  proof(dir, 'check')

  writeFileSync(join(dir, 'app.txt'), 'not yet\n')
  const r = proof(dir, 'check')
  assert.match(r.out, /Regression:\n\s+passed in run 0001, fails now/)
})
