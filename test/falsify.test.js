import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { classify } from '../src/falsify.js'

// The question nothing was asking: would this contract have noticed if the change had never
// been made? A check that passes on the code from before the diff reports DONE for a branch
// that did nothing.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

/** A repo with a committed "before", and whatever the change left in the working tree. */
const repo = (before, after, contract) => {
  // Deliberately not the worktree's own prefix: the leak check below counts those.
  const dir = mkdtempSync(join(tmpdir(), 'proof-fx-base-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  const put = (name, body) => {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  for (const [name, body] of Object.entries(before)) put(name, body)
  g('init', '-q', '-b', 'main', '.')
  g('config', 'user.email', 't@t.t')
  g('config', 'user.name', 't')
  g('add', '-A')
  g('commit', '-qm', 'before')

  for (const [name, body] of Object.entries(after)) put(name, body)
  put('.proof/spec.yaml', contract)
  return dir
}

// Every prose block is wrapped to the terminal width, so match on the text, not the lines.
const flat = out => out.replace(/\s+/g, ' ')

test('a contract that needs the change fails on the base, and says which checks carry it', () => {
  const dir = repo(
    { 'app.txt': 'old\n' },
    { 'app.txt': 'new: the refund button\n' },
    `goal: the refund button exists
checks:
  - name: it still builds
    run: "true"
  - name: the refund button is there
    file: {path: app.txt, contains: "refund button"}
`)

  const r = proof(dir, 'falsify')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /DISCRIMINATES/)
  assert.match(r.out, /the refund button is there\s+FAIL\s+needs your change/)
  assert.match(r.out, /it still builds\s+PASS\s+would pass without your change/)
  assert.match(r.out, /1 of 2 check\(s\) fail without your change/)
  assert.match(flat(r.out), /regression guards, not the requirement/)
})

test('a contract that passes without the change is the finding, and exits 1', () => {
  // The whole point. This contract would report DONE for a branch that did nothing.
  const dir = repo(
    { 'app.txt': 'old\n' },
    { 'app.txt': 'new: the refund button\n' },
    `goal: the refund button exists
checks:
  - name: the file is there
    file: app.txt
  - name: it still builds
    run: "true"
`)

  const r = proof(dir, 'falsify')
  assert.equal(r.code, 1)
  assert.match(r.out, /DOES NOT DISCRIMINATE/)
  assert.match(flat(r.out), /would report DONE for a branch that did nothing/)
  assert.match(r.out, /the file is there\s+PASS/)
})

test('it runs the current contract, not the one the base commit had', () => {
  // The contract is the thing being tested, so the checkout's own copy must not be what runs.
  const dir = repo(
    { 'app.txt': 'old\n', '.proof/spec.yaml': 'goal: stale\nchecks:\n  - name: stale\n    run: "true"\n' },
    { 'app.txt': 'new\n' },
    'goal: fresh\nchecks:\n  - name: fresh check\n    file: {path: app.txt, contains: "new"}\n')

  const r = proof(dir, 'falsify')
  assert.match(r.out, /Requirement:\n {2}fresh/)
  assert.match(r.out, /fresh check\s+FAIL/)
  assert.doesNotMatch(r.out, /stale/)
})

test('the working tree is never touched, and no worktree is left behind', () => {
  const dir = repo({ 'app.txt': 'old\n' }, { 'app.txt': 'new\n' },
    'goal: g\nchecks:\n  - name: c\n    file: {path: app.txt, contains: "new"}\n')

  proof(dir, 'falsify')

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
  assert.match(status, /app\.txt/, 'the uncommitted change is still uncommitted')
  assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').length, 1)
  assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('proof-falsify-')), [],
    'the checkout it made is gone')
})

test('--base measures what the branch changed, not how it differs from a moved main', () => {
  const dir = repo({ 'app.txt': 'v1\n' }, {}, 'goal: g\nchecks:\n  - name: c\n    file: {path: app.txt, contains: "feature"}\n')
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })

  g('checkout', '-qb', 'feature')
  writeFileSync(join(dir, 'app.txt'), 'v1 + feature\n')
  g('add', '-A')
  g('commit', '-qm', 'the feature')

  // main moves on afterwards; the fork point is still where the branch started
  g('checkout', '-q', 'main')
  writeFileSync(join(dir, 'other.txt'), 'unrelated\n')
  g('add', '-A')
  g('commit', '-qm', 'later on main')
  g('checkout', '-q', 'feature')

  const r = proof(dir, 'falsify', '--base', 'main')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /DISCRIMINATES/)
  assert.match(r.out, /where this branch left main/)
})

test('a run check that the base cannot even find is not counted as evidence', () => {
  // A missing binary exits 127. Counting that would let a contract testing nothing pass here
  // on any checkout that happens to be missing a build step.
  const dir = repo({ 'app.txt': 'old\n' }, { 'app.txt': 'new\n' },
    'goal: g\nchecks:\n  - name: a tool that is not there\n    run: proof-nonexistent-binary-xyz\n')

  const r = proof(dir, 'falsify')
  assert.equal(r.code, 2)
  assert.match(r.out, /INCONCLUSIVE/)
  assert.match(flat(r.out), /says nothing about the change/)
  assert.match(flat(r.out), /exits 127 was not found there/)
})

test('an app that will not start on the base is inconclusive, never "it discriminates"', () => {
  const dir = repo({ 'app.txt': 'old\n' }, { 'app.txt': 'new\n' },
    `goal: g
serve:
  run: exit 1
  ready_url: http://127.0.0.1:9
  timeout: 2
checks:
  - name: c
    http: {path: /, expect: {status: 200}}
`)

  const r = proof(dir, 'falsify')
  assert.equal(r.code, 2)
  assert.match(r.out, /INCONCLUSIVE/)
  assert.match(flat(r.out), /the app did not start on/)
  assert.match(flat(r.out), /Nothing here says the contract is wrong, only that this run could not tell/)
})

test('outside a repository, and with no commits, it refuses rather than guesses', () => {
  const bare = mkdtempSync(join(tmpdir(), 'proof-fx-norepo-'))
  mkdirSync(join(bare, '.proof'))
  writeFileSync(join(bare, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: c\n    run: "true"\n')
  const outside = proof(bare, 'falsify')
  assert.equal(outside.code, 2)
  assert.match(outside.out, /not a git repository/)

  execFileSync('git', ['init', '-q', '.'], { cwd: bare, stdio: 'ignore' })
  const empty = proof(bare, 'falsify')
  assert.equal(empty.code, 2)
  assert.match(empty.out, /no commits yet, so there is no "before"/)
})

test('a broken contract is the usual coded error, before any checkout happens', () => {
  const dir = repo({ 'a.txt': 'x\n' }, {}, 'goal: g\nchecks:\n  - name: c\n    frobnicate: 1\n')
  const r = proof(dir, 'falsify', '--json')
  assert.equal(r.code, 2)
  assert.match(r.out, /"code": "EBADSPEC"/)
})

test('--json carries the per-check finding an agent would act on', () => {
  const dir = repo({ 'app.txt': 'old\n' }, { 'app.txt': 'new\n' },
    `goal: g
checks:
  - name: guard
    run: "true"
  - name: the change
    file: {path: app.txt, contains: "new"}
`)
  const o = JSON.parse(proof(dir, 'falsify', '--json').stdout)
  assert.equal(o.status, 'discriminates')
  assert.deepEqual(o.discriminating, ['the change'])
  assert.deepEqual(o.regression_guards, ['guard'])
  assert.equal(o.checks.find(c => c.check === 'the change').about_the_change, true)
  assert.equal(o.checks.find(c => c.check === 'guard').about_the_change, false)
  assert.match(o.commit, /^[0-9a-f]{40}$/)
})

// --- classification, without the checkout ------------------------------------

const run = results => ({ results })
const ctx = { spec: { goal: 'g' }, base: 'HEAD', from: 'HEAD', commit: 'a'.repeat(40) }

test('a crashed check is never evidence that the contract discriminates', () => {
  const o = classify(run([{ name: 'c', kind: 'http', status: 'failed', crashed: true }]), ctx)
  assert.equal(o.status, 'inconclusive')
  assert.deepEqual(o.discriminating, [])
})

test('one clean failure is enough, and the suspicious ones are still named', () => {
  const o = classify(run([
    { name: 'real', kind: 'file', status: 'failed' },
    { name: 'crashed', kind: 'http', status: 'failed', crashed: true },
  ]), ctx)
  assert.equal(o.status, 'discriminates')
  assert.deepEqual(o.discriminating, ['real'])
  assert.deepEqual(o.suspicious.map(s => s.check), ['crashed'])
})

test('a skipped check is neither evidence nor a regression guard', () => {
  const o = classify(run([
    { name: 'off', kind: 'run', status: 'skipped' },
    { name: 'real', kind: 'file', status: 'failed' },
  ]), ctx)
  assert.equal(o.checks.length, 1)
  assert.deepEqual(o.regression_guards, [])
})

test('a boot failure outranks everything, because nothing after it ran', () => {
  const o = classify(run([
    { name: 'app boots', kind: 'serve', status: 'failed' },
    { name: 'real', kind: 'file', status: 'failed' },
  ]), ctx)
  assert.equal(o.status, 'inconclusive')
  assert.match(o.reason, /the app did not start/)
})

test('reuse_existing is called out, since those checks may have reached the new code', () => {
  const o = classify(run([{ name: 'c', kind: 'http', status: 'passed' }]), {
    ...ctx,
    spec: { goal: 'g', serve: { run: 'x', ready_url: 'http://localhost:3000', reuse_existing: true } },
  })
  assert.equal(o.reused_existing, true)
})
