import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, describe } from '../src/check.js'
import { report } from '../src/report.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const run = async spec => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-asserted-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('f.txt', 'hello world\n')
  writeFileSync('.proof/spec.yaml', spec)
  await quiet(() => check({ json: true }))
  return {
    dir,
    result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
    log: readFileSync(join(dir, '.proof/runs/0001/commands.log'), 'utf8'),
  }
}

test('the regression: evidence records what was asserted, not only what was observed', async () => {
  // The bundle used to hold "f.txt ok" and "exit 0" with no record of the command that ran
  // or what it had to produce. Once the contract moved on, the run could not be read back.
  const { result, log } = await run(
    'goal: g\nchecks:\n  - name: alpha\n    run: echo hi\n    expect_output: hi\n'
    + '  - name: beta\n    file: {path: f.txt, contains: hello}\n',
  )

  const [alpha, beta] = result.results
  assert.equal(alpha.asserted, '`echo hi`, exit 0, output contains "hi"')
  assert.equal(beta.asserted, 'f.txt exists and contains "hello"')

  assert.match(log, /asserted: `echo hi`, exit 0, output contains "hi"/)
  assert.match(log, /asserted: f\.txt exists and contains "hello"/)
})

test('every check in a run carries an assertion, synthetic ones included', async () => {
  const { result } = await run(
    'goal: g\nchecks:\n  - name: a\n    run: "true"\n  - name: b\n    env: HOME\n',
  )
  for (const r of result.results) {
    assert.ok(r.asserted, `${r.name} (${r.kind}) recorded no assertion`)
  }
})

test('the description matches what the runner actually enforces', () => {
  // Each pair: a check, and the assertion the runner applies to it. These drift apart
  // silently — a description that overstates the check is worse than none.
  assert.equal(describe({ run: 'npm test' }, 'run'), '`npm test`, exit 0')
  assert.equal(describe({ run: 'x', expect_exit: 3 }, 'run'), '`x`, exit 3')

  // runHttp treats a missing `expect` as "not an error status", never as "no assertion".
  assert.equal(describe({ http: { path: '/a' } }, 'http'), 'GET /a, a non-error status')
  assert.equal(describe({ http: { path: '/a', expect: { status: 201 } } }, 'http'), 'GET /a, status 201')

  // runFile with exists:false asserts absence, which is the opposite of the default.
  assert.equal(describe({ file: { path: 'x', exists: false } }, 'file'), 'x is absent')
  assert.equal(describe({ file: 'x' }, 'file'), 'x exists')

  assert.equal(describe({ env: 'TOKEN' }, 'env'), 'env TOKEN is set')
})

test('a pattern containing a slash is still readable', () => {
  // `/^//` cannot be read back as the pattern `^/`.
  assert.equal(describe({ env: { name: 'P', matches: '^/' } }, 'env'), 'env P matches "^/"')
})

test('report.md carries the assertion beside the verdict', async () => {
  const { dir } = await run('goal: g\nchecks:\n  - name: alpha\n    run: echo hi\n')
  await quiet(() => report({}))
  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
  assert.match(md, /\| alpha \| `echo hi`, exit 0 \| PASS \|/)
})

test('a browser check describes its flow', () => {
  const flow = { browser: { flow: [{ visit: '/login' }, { click: 'Sign in' }, { expect_text: 'Welcome' }] } }
  assert.equal(describe(flow, 'browser'), 'visit /login; click "Sign in"; see "Welcome"')
})
