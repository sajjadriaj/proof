import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { infer, isTestFile, findGaps } from '../src/infer.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

const project = files => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-testfiles-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  writeFileSync('README.md', 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  return dir
}

test('the regression: a route in a fixture is not a route of the application', () => {
  // Scanning proof's own repository produced 60 gaps, 58 from test fixtures — every
  // `app.get('/api/x', h)` written to exercise the detector reported as a product surface.
  // A gap list that long is one nobody reads.
  project({
    'src/server.ts': "app.get('/api/real', h)\n",
    'test/server.test.ts': "app.get('/api/fixture', h)\nconst k = process.env.TEST_ONLY_VAR\n",
  })

  const out = JSON.parse(captured(() => infer({ json: true })))
  const titles = out.gaps.map(g => g.title)

  assert.ok(titles.some(t => t.includes('/api/real')), 'the application route is still found')
  assert.ok(!titles.some(t => t.includes('/api/fixture')), `a fixture route was reported: ${titles}`)
  assert.ok(!titles.some(t => t.includes('TEST_ONLY_VAR')), 'a fixture env var was reported')
})

test('every convention for naming a test is recognised', () => {
  for (const path of [
    'src/thing.test.ts', 'src/thing.spec.js', 'src/Button.stories.tsx',
    'test/a.ts', 'tests/a.ts', '__tests__/a.ts', '__mocks__/a.ts', '__fixtures__/a.ts',
    'e2e/flow.ts', 'cypress/integration/a.js', 'fixtures/sample.ts',
  ]) {
    assert.equal(isTestFile(path), true, `${path} was not recognised as a test file`)
  }
})

test('application files are not mistaken for tests', () => {
  for (const path of [
    'src/server.ts', 'src/latest.ts', 'src/contest.js', 'app/api/users/route.ts',
    'src/protest/index.ts', 'lib/attest.ts',
  ]) {
    assert.equal(isTestFile(path), false, `${path} was treated as a test file`)
  }
})

test('the count says what was skipped rather than leaving a gap in the arithmetic', () => {
  // "119 files in scope, 13 scannable" with no explanation reads like a broken scan.
  project({
    'src/server.ts': "app.get('/api/real', h)\n",
    'test/a.test.ts': 'export const a = 1\n',
    'test/b.test.ts': 'export const b = 1\n',
  })

  const out = captured(() => infer({}))
  assert.match(out, /2 test file\(s\) skipped/)
})

test('a diff of nothing but tests is not reported as an unscannable failure', () => {
  project({ 'test/a.test.ts': "app.get('/api/fixture', h)\n" })

  const out = captured(() => infer({}))
  assert.match(out, /1 test file\(s\) skipped/)
  assert.doesNotMatch(out, /Nothing was scanned/, 'skipping tests on purpose is not a degraded scan')
})

test('findGaps applies the same rule when called directly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-testfiles-direct-'))
  process.chdir(dir)
  mkdirSync('test', { recursive: true })
  writeFileSync('test/x.test.ts', "app.get('/api/fixture', h)\n")

  assert.deepEqual(findGaps(['test/x.test.ts'], [], { reportUncovered: false }), [])
})

test('the regression: a test file is not counted as an uncovered gap', async () => {
  // "no check names this file" for a test file is noise: the file is the verification.
  // A section that warns about things needing no action is one people stop reading.
  const { changed } = await import('../src/changed.js')
  project({
    'src/a.ts': 'export const a = 2\n',
    'test/a.test.ts': "import { a } from '../src/a'\n",
  })

  const out = JSON.parse(captured(() => changed({ json: true })))
  assert.deepEqual(out.uncovered, ['src/a.ts'], 'only the application file is a gap')
})

test('the test file is still listed, marked for what it is', async () => {
  // Hiding it would leave a gap in the list with no explanation.
  const { changed } = await import('../src/changed.js')
  project({
    'src/a.ts': 'export const a = 2\n',
    'test/a.test.ts': "import { a } from '../src/a'\n",
  })

  const out = captured(() => changed({}))
  assert.match(out, /TEST {2}test\/a\.test\.ts — a test, so it verifies rather than needs verifying/)
  assert.match(out, /WARN {2}src\/a\.ts — no check names this file/)
  assert.match(out, /1 file\(s\) in the blast radius have no check naming them/)
})

test('a test file a check does name is reported as covered, not as a test', async () => {
  // The stronger statement wins: something explicitly names it.
  const { changed } = await import('../src/changed.js')
  const dir = project({ 'test/a.test.ts': 'export const a = 1\n' })
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: g\nchecks:\n  - name: runs test/a.test.ts\n    run: node --test test/a.test.ts\n')

  const out = captured(() => changed({}))
  assert.match(out, /OK {4}test\/a\.test\.ts/)
})

test('the regression: an unscannable language says which languages are scanned', () => {
  // "no code file is in scope" contradicted the file listed two lines above. The
  // limitation is proof's detectors, not the diff. Ruby, since Python and Go are now
  // languages the detectors read.
  project({ 'app/main.rb': 'get "/api/health" do\n  "ok"\nend\n' })

  const out = captured(() => infer({})).replace(/\s+/g, ' ')
  assert.match(out, /No file in scope is one proof can scan for gaps/)
  assert.match(out, /JavaScript, TypeScript, Python and Go/)
  assert.match(out, /`run:` checks work in any language/, 'and what still works')
  assert.doesNotMatch(out, /no code file is in scope/)
})

test('an empty diff says nothing is in scope, which is a different thing', () => {
  project({})
  const out = captured(() => infer({})).replace(/\s+/g, ' ')

  assert.match(out, /Nothing is in scope/)
  assert.doesNotMatch(out, /proof can scan/, 'no diff is not a limitation of the scanners')
})

test('a scannable diff with no gaps still says so plainly', () => {
  // The file needs a check naming it, or "nothing names this file" is itself a gap and
  // this branch is never reached.
  const dir = project({ 'src/plain.ts': 'export const a = 1\n' })
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: g\nchecks:\n  - name: plain behaves\n    run: node --test src/plain.ts\n')

  const out = captured(() => infer({}))
  assert.match(out, /No verification gaps found/)
})

test('the message wraps to the terminal width', () => {
  project({ 'app/main.py': 'def health(): pass\n' })

  for (const line of captured(() => infer({})).split('\n')) {
    assert.ok(line.length <= 100, `${line.length}: ${line}`)
  }
})
