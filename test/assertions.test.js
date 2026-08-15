import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { validateSpec } from '../src/validate.js'
import { check } from '../src/check.js'

const sandbox = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-assert-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(contract))
  return dir
}

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const resultOf = dir => JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

test('the regression: unquoted YAML numbers can no longer skip an assertion', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [
      { name: 'a', file: { path: 'out.txt', contains: 0 } },
      { name: 'b', run: 'echo hello', expect_output: 0 },
    ],
  })
  assert.equal(p.length, 2)
  assert.match(p[0], /file › contains: must be a string, got number — quote it in YAML/)
  assert.match(p[1], /expect_output: must be a string, got number — quote it in YAML/)
})

test('a quoted zero is a real assertion and actually fails', async () => {
  const dir = sandbox({ goal: 'g', checks: [{ name: 'prints zero', run: 'echo hello', expect_output: '0' }] })
  assert.equal(await quiet(() => check({ json: true })), 1)
  assert.match(resultOf(dir).failures[0].expected, /output contains "0"/)
})

test('wrong types are caught across every assertion-carrying field', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [
      { name: 'a', http: { url: 'http://x.test/', expect: { status: '200', body_contains: 5 } } },
      { name: 'b', file: { path: 'x', exists: 'yes' } },
      { name: 'c', run: 'true', expect_exit: '0', timeout: '30' },
      { name: 'd', browser: { base_url: 'http://x.test', visit: '/', expect_no_console_errors: 'true', flow: [{ click: 7 }, { wait: 'soon' }] } },
    ],
  })
  const joined = p.join('\n')
  assert.match(joined, /expect › status: must be a number, got string/)
  assert.match(joined, /expect › body_contains: must be a string, got number/)
  assert.match(joined, /file › exists: must be a boolean, got string/)
  assert.match(joined, /expect_exit: must be a number, got string/)
  assert.match(joined, /timeout: must be a number, got string/)
  assert.match(joined, /expect_no_console_errors: must be a boolean, got string/)
  assert.match(joined, /flow\[0\] › click: must be a string, got number/)
  assert.match(joined, /flow\[1\] › wait: must be a number, got string/)
})

test('correct types stay silent', () => {
  assert.deepEqual(validateSpec({
    goal: 'g',
    checks: [
      { name: 'a', http: { url: 'http://x.test/', expect: { status: 200, body_contains: 'ok' } }, timeout: 30 },
      // separate checks: `exists: false` with `contains` is incoherent, and both keys
      // still need their types exercised
      { name: 'b', file: { path: 'x', exists: false } },
      { name: 'b2', file: { path: 'x', contains: 'y' } },
      { name: 'c', run: 'true', expect_exit: 1, expect_output: '0' },
      { name: 'd', browser: { base_url: 'http://x.test', visit: '/', expect_no_console_errors: true, flow: [{ click: 'Go' }, { wait: 100 }] } },
    ],
  }), [])
})

test('a contract of only run: checks says so on a pass', async () => {
  const dir = sandbox({
    goal: 'green suite, unproven requirement',
    checks: [{ name: 'build', run: 'true' }, { name: 'tests', run: 'true' }],
  })
  assert.equal(await quiet(() => check({ json: true })), 0)

  const r = resultOf(dir)
  assert.equal(r.status, 'passed')
  assert.match(r.advisory, /Nothing in this contract exercises the running application/)
})

test('one acceptance-level check silences the advisory', async () => {
  const dir = sandbox({
    goal: 'has an acceptance check',
    checks: [{ name: 'tests', run: 'true' }, { name: 'secret set', env: 'PATH' }],
  })
  assert.equal(await quiet(() => check({ json: true })), 0)
  assert.equal(resultOf(dir).advisory, null)
})

test('the advisory is absent on a failing run, where there is no false confidence', async () => {
  const dir = sandbox({ goal: 'failing', checks: [{ name: 'tests', run: 'exit 1' }] })
  assert.equal(await quiet(() => check({ json: true })), 1)
  assert.equal(resultOf(dir).advisory, null)
})
