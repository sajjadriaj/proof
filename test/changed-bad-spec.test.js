import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changed } from '../src/changed.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

const project = spec => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-badspec-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('src/a.ts', 'export const a = 1\n')
  writeFileSync('src/b.ts', "import { a } from './a'\n")
  writeFileSync('.proof/spec.yaml', spec)
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync('src/a.ts', 'export const a = 2\n')
  return dir
}

const BROKEN = 'goal: g\nchecks:\n  - name: ok\n    run: "true"\n    expect_stat: 0\n'
const VALID = 'goal: g\nchecks:\n  - name: ok\n    run: "true"\n'

test('the regression: a typo in the contract does not withhold the blast radius', () => {
  // The changed files, their dependents and the dependency changes are all independent of
  // the contract. Refusing the whole command meant fixing an unrelated key before you could
  // see what your change touches.
  project(BROKEN)
  const out = captured(() => changed({}))

  assert.match(out, /src\/a\.ts/, 'the changed file is reported')
  assert.match(out, /src\/b\.ts/, 'and its dependent')
})

test('only the coverage section is withheld, and it says why', () => {
  project(BROKEN)
  const out = captured(() => changed({})).replace(/\s+/g, ' ')

  assert.match(out, /the contract is invalid, so coverage was not computed/)
  assert.match(out, /unknown key "expect_stat"/, 'the actual problem, not just the heading')
  assert.match(out, /did you mean "expect_exit"/, 'and its suggestion')
})

test('an invalid contract is not reported as a missing one', () => {
  // The file is there and unusable; "run `proof init`" would be the wrong fix.
  project(BROKEN)
  const out = captured(() => changed({}))

  assert.match(out, /the contract is invalid/, 'it read the file and said so')
  assert.doesNotMatch(out, /no \.proof\/spec\.yaml/)
  assert.doesNotMatch(out, /run `proof init/)
})

test('--json carries the problem and reports no coverage', () => {
  project(BROKEN)
  const out = JSON.parse(captured(() => changed({ json: true })))

  assert.match(out.spec_invalid, /unknown key "expect_stat"/)
  assert.equal(out.spec, false)
  assert.equal(out.coverage, null)
  assert.deepEqual(out.changed, ['src/a.ts'])
})

test('a valid contract still computes coverage, and reports nothing invalid', () => {
  project(VALID)
  const out = JSON.parse(captured(() => changed({ json: true })))

  assert.equal(out.spec_invalid, null)
  assert.equal(out.spec, true)
  assert.ok(Array.isArray(out.coverage))
})

test('check still refuses an invalid contract outright', async () => {
  // Degrading is right for a report about the diff; it would be wrong for a verdict.
  const { check } = await import('../src/check.js')
  project(BROKEN)

  await assert.rejects(() => check({ json: true }), /is invalid/)
})

const inferProject = () => {
  const dir = project(BROKEN)
  writeFileSync(join(dir, 'src/routes.ts'),
    "app.get('/api/users', h)\nconst k = process.env.SECRET_KEY\n")
  return dir
}

test('the regression: infer still reports gaps when the contract does not validate', async () => {
  // Gaps come from the code. What a broken contract costs is knowing which are covered —
  // worth saying, not worth withholding the answer for.
  const { infer } = await import('../src/infer.js')
  inferProject()

  const out = JSON.parse(captured(() => infer({ json: true })))
  assert.ok(out.gaps.some(g => g.title.includes('/api/users')), JSON.stringify(out.gaps))
  assert.ok(out.gaps.some(g => g.title.includes('SECRET_KEY')))
})

test('and says what it could not tell', async () => {
  const { infer } = await import('../src/infer.js')
  inferProject()

  const out = captured(() => infer({})).replace(/\s+/g, ' ')
  assert.match(out, /could not tell which of these are already covered/)
  assert.match(out, /unknown key "expect_stat"/)
})

test('--write is refused, and names the command that still works', async () => {
  // Appending to a contract proof cannot read would add duplicates of checks it could not see.
  const { infer } = await import('../src/infer.js')
  const dir = inferProject()
  const before = readFileSync(join(dir, '.proof/spec.yaml'), 'utf8')

  await assert.rejects(async () => infer({ write: true }), e => {
    assert.match(e.message, /`--write` would append to a contract proof cannot read/)
    assert.match(e.message, /without `--write` to see the gaps/)
    return true
  })

  assert.equal(readFileSync(join(dir, '.proof/spec.yaml'), 'utf8'), before, 'the contract is untouched')
})

test('a valid contract still suppresses gaps it covers', async () => {
  // The dedup this protects: with a readable contract, a covered route is not offered again.
  const { infer } = await import('../src/infer.js')
  const dir = project(VALID)
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: g\nserve:\n  run: sleep 30\n  ready_url: http://localhost:9\n  reuse_existing: true\n'
    + 'checks:\n  - name: users\n    http: {method: GET, path: /api/users, expect: {status: 200}}\n')
  writeFileSync(join(dir, 'src/routes.ts'), "app.get('/api/users', h)\n")

  const out = JSON.parse(captured(() => infer({ json: true })))
  assert.equal(out.spec_invalid, null)
  assert.equal(out.gaps.filter(g => g.title.includes('/api/users is reachable')).length, 0)
})
