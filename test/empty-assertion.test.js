import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateSpec } from '../src/validate.js'
import { check } from '../src/check.js'

const SERVE = { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true }

const problems = (spec) => validateSpec(spec).join('\n')

// Every string assertion Proof supports, each paired with the value that makes it vacuous.
const ASSERTIONS = [
  ['expect_output', { name: 'a', run: 'echo hi', expect_output: '' }, null],
  ['http › expect › body_contains', { name: 'a', http: { path: '/', expect: { body_contains: '' } } }, SERVE],
  ['file › contains', { name: 'a', file: { path: 'f.txt', contains: '' } }, null],
  ['env › matches', { name: 'a', env: { name: 'HOME', matches: '' } }, null],
  ['browser › flow[0] › expect_text', { name: 'a', browser: { flow: [{ visit: '/', expect_text: '' }] } }, SERVE],
  ['expect_request › path_matches',
    { name: 'a', browser: { flow: [{ visit: '/', expect_request: { path_matches: '' } }] } }, SERVE],
]

test('the regression: an empty assertion is rejected wherever it can be written', () => {
  for (const [where, checkBody, serve] of ASSERTIONS) {
    const spec = { goal: 'g', checks: [checkBody], ...(serve ? { serve } : {}) }
    const out = problems(spec)
    assert.match(out, new RegExp(`${where.replace(/[›[\]]/g, m => '\\' + m)}: is empty`), `${where} was accepted: ${out}`)
  }
})

test('the same assertions with real values are accepted', () => {
  for (const [where, checkBody, serve] of ASSERTIONS) {
    const filled = JSON.parse(JSON.stringify(checkBody).replaceAll('""', '"something"'))
    const spec = { goal: 'g', checks: [filled], ...(serve ? { serve } : {}) }
    // Paired with the empty form of the same fixture: without that, "no `is empty` problem"
    // is equally satisfied by a rule that stopped working.
    const emptySpec = { goal: 'g', checks: [checkBody], ...(serve ? { serve } : {}) }
    assert.match(problems(emptySpec), /is empty/, `${where} is no longer caught when empty`)
    assert.doesNotMatch(problems(spec), /is empty/, `${where} was rejected when filled in`)
  }
})

test('omitting the key entirely is still fine — only writing it empty is not', () => {
  assert.equal(problems({ goal: 'g', checks: [{ name: 'a', run: 'echo hi' }] }), '')
  assert.equal(problems({ goal: 'g', checks: [{ name: 'a', file: { path: 'f.txt', exists: true } }] }), '')
})

test('an empty assertion used to pass no matter what the code did', async () => {
  // The proof that this rule is load-bearing: the same check with real content fails,
  // so the machinery works — the empty string was the part that could not fail.
  const dir = mkdtempSync(join(tmpdir(), 'proof-empty-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('f.txt', 'some content\n')
  writeFileSync('.proof/spec.yaml',
    'goal: g\nchecks:\n  - name: a\n    file: {path: f.txt, contains: "definitely-not-present"}\n')

  const real = console.log
  console.log = () => {}
  let code
  try { code = await check({}) } finally { console.log = real }
  assert.equal(code, 1, 'a non-empty contains assertion can fail')
})

test('a whitespace assertion is a real assertion and is left alone', () => {
  // `contains: " "` says the file has a space in it. That can fail.
  assert.equal(problems({ goal: 'g', checks: [{ name: 'a', file: { path: 'f.txt', contains: ' ' } }] }), '')
})

test('the regression: exists:false with contains is refused, not silently half-run', async () => {
  // The runner returns on `exists: false` before reading anything, so `contains` was dropped
  // without trace — and on an absent file the check PASSED while an assertion its author
  // wrote had never run. Even the recorded `asserted` said only "absent.txt is absent".
  const problems = validateSpec({
    goal: 'g',
    checks: [{ name: 'c', file: { path: 'absent.txt', exists: false, contains: 'never checked' } }],
  }).join('\n')

  assert.match(problems, /`exists: false` and `contains` cannot both hold/)
  assert.match(problems, /an absent file has no contents to match/)
  assert.match(problems, /would never be checked/)
})

test('each half on its own is fine', () => {
  assert.deepEqual(validateSpec({
    goal: 'g',
    checks: [
      { name: 'a', file: { path: 'x', exists: false } },
      { name: 'b', file: { path: 'x', contains: 'y' } },
      { name: 'c', file: { path: 'x', exists: true, contains: 'y' } },
    ],
  }), [])
})

test('the run that motivated it can no longer happen', async () => {
  // Before: PASS, with the content assertion never evaluated.
  const dir = mkdtempSync(join(tmpdir(), 'proof-filecontra-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    'goal: g\nchecks:\n  - name: c\n    file: {path: absent.txt, exists: false, contains: "never checked"}\n')

  const real = console.log
  console.log = () => {}
  let threw = false
  try { await check({ json: true }) } catch { threw = true } finally { console.log = real }

  assert.ok(threw, 'the contract is refused rather than passing')
})

test('the regression: http path and url together are refused', async () => {
  // The runner takes `url` and ignores `path`, so a check holding both requests one address
  // while its contract shows two — usually the remains of editing one form into the other.
  const problems = validateSpec({
    goal: 'g',
    serve: { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true },
    checks: [{ name: 'c', http: { path: '/a', url: 'http://x.test/b' } }],
  }).join('\n')

  assert.match(problems, /`path` and `url` are alternatives/)
  assert.match(problems, /`url` would be requested and `path` ignored/)
})

test('either one alone is accepted', () => {
  const serve = { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true }

  assert.deepEqual(validateSpec({ goal: 'g', serve, checks: [{ name: 'c', http: { path: '/a' } }] }), [])
  assert.deepEqual(validateSpec({ goal: 'g', serve, checks: [{ name: 'c', http: { url: 'http://x.test/b' } }] }), [])
})

test('neither is still its own error', () => {
  // The rule must not swallow the case it sits next to.
  const problems = validateSpec({
    goal: 'g',
    serve: { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true },
    checks: [{ name: 'c', http: { method: 'GET' } }],
  }).join('\n')

  assert.match(problems, /needs a `path` or `url`/)
  assert.doesNotMatch(problems, /are alternatives/)
})

test('the regression: a step with two verbs is refused', async () => {
  // The runner dispatches on the first verb it finds and ignores the rest, so
  // `{click: "Go", expect_text: "Welcome"}` clicked and never asserted the text. The check
  // level has rejected two verbs since the beginning; steps had not — and four tests in
  // this suite were quietly relying on it.
  const problems = validateSpec({
    goal: 'g',
    serve: { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true },
    checks: [{ name: 'c', browser: { flow: [{ click: 'Go', expect_text: 'Welcome' }] } }],
  }).join('\n')

  assert.match(problems, /2 step verbs \(click, expect_text\)/)
  assert.match(problems, /only `click` would run/)
  assert.match(problems, /Split them into separate steps/)
})

test('the same step split in two is accepted', () => {
  assert.deepEqual(validateSpec({
    goal: 'g',
    serve: { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true },
    checks: [{ name: 'c', browser: { flow: [{ click: 'Go' }, { expect_text: 'Welcome' }] } }],
  }), [])
})

test('a step with no verb is still its own error', () => {
  const problems = validateSpec({
    goal: 'g',
    serve: { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true },
    checks: [{ name: 'c', browser: { flow: [{ timeout_ms: 100 }] } }],
  }).join('\n')

  assert.match(problems, /no step verb|unknown key/)
  assert.doesNotMatch(problems, /step verbs \(/)
})

test('the message names the verb that would actually run', () => {
  // Which one wins is dispatch order, not document order — so it has to be read from the
  // same list the runner uses.
  const problems = validateSpec({
    goal: 'g',
    serve: { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true },
    checks: [{ name: 'c', browser: { flow: [{ expect_text: 'Welcome', visit: '/a' }] } }],
  }).join('\n')

  assert.match(problems, /only `visit` would run/, 'visit is dispatched before expect_text')
})
