import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { check } from '../src/check.js'

const captured = async fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { await fn() } finally { console.log = real }
  return lines.join('\n')
}

const run = async contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-blocks-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(contract))
  return { dir, out: await captured(() => check({})) }
}

test('the regression: a multi-line requirement stays inside its block', async () => {
  const { out } = await run({
    goal: 'checkout works\nand refunds work\nand invoices are emailed',
    checks: [{ name: 'a', run: 'true' }],
  })

  const lines = out.split('\n')
  const start = lines.indexOf('Requirement:')
  const body = lines.slice(start + 1, start + 4)

  assert.deepEqual(body, [
    '  checkout works',
    '  and refunds work',
    '  and invoices are emailed',
  ], 'every line is indented, not just the first')
})

test('the regression: a long expected value wraps, and none of it is lost', async () => {
  // It was truncated instead, which bounded the width but threw away the explanation —
  // an occupied port lost the half naming the three ways to resolve it.
  const long = 'a string that is really quite long and will not be found anywhere in the output '
    + 'of this command at all, not even once, however hard it looks'
  const { out } = await run({
    goal: 'g',
    checks: [{ name: 'a', run: 'echo x', expect_output: long }],
  })

  const widest = Math.max(...out.split('\n').map(l => l.length))
  assert.ok(widest <= 100, `widest line was ${widest} characters`)

  const collapsed = out.replace(/\s+/g, ' ')
  assert.ok(collapsed.includes(long), 'every word of the expectation survives the wrap')
  assert.doesNotMatch(out, /more character\(s\) on this line/, 'nothing was cut')
})

test('a multi-line observed value is indented consistently too', async () => {
  const { out } = await run({
    goal: 'g',
    checks: [{ name: 'a', run: 'printf "one\\ntwo\\nthree\\n"; exit 1', expect_output: 'missing' }],
  })

  const lines = out.split('\n')
  const start = lines.indexOf('  Output:')
  assert.ok(start > 0, 'the output block is present')
  for (const line of lines.slice(start + 1, start + 4)) {
    assert.match(line, /^ {4}\S/, `expected four-space indent, got: ${JSON.stringify(line)}`)
  }
})

test('short values are untouched', async () => {
  const { out } = await run({ goal: 'short goal', checks: [{ name: 'a', run: 'exit 1' }] })

  assert.match(out, /^Requirement:\n {2}short goal$/m)
  assert.match(out, /^ {4}exit 0$/m, 'expected value unchanged')
  assert.doesNotMatch(out, /…/)
})

test('the evidence keeps the whole text regardless of the terminal', async () => {
  const long = 'x'.repeat(300)
  const { dir } = await run({
    goal: long,
    checks: [{ name: 'a', run: 'echo hi', expect_output: long }],
  })

  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.equal(r.goal, long)
  assert.ok(r.failures[0].expected.includes(long), 'the assertion is recorded in full')
})

test('the occupied-port explanation survives intact', async () => {
  // The message that made this worth fixing: everything after the port was cut, including
  // the three ways to resolve it.
  const { block } = await import('../src/terminal.js')
  const observed = 'something is already responding at http://localhost:8388 before '
    + '`npm run dev` was started — proof cannot tell whether checks would reach your app '
    + '(stop it, use a different port, or set `reuse_existing: true` to accept it)'

  const rendered = block(observed)
  for (const line of rendered.split('\n')) assert.ok(line.length <= 100, `line was ${line.length}: ${line}`)
  assert.ok(rendered.replace(/\s+/g, ' ').includes('set `reuse_existing: true` to accept it'))
})

test('blank lines between paragraphs are kept', async () => {
  const { block } = await import('../src/terminal.js')
  const rendered = block('first\n\nsecond')
  assert.equal(rendered.split('\n').length, 3, rendered)
  assert.match(rendered, /first/)
  assert.match(rendered, /second/)
})

test('a runaway value is bounded rather than wrapped forever', async () => {
  const { block } = await import('../src/terminal.js')
  const rendered = block('word '.repeat(5000))
  const lines = rendered.split('\n')
  assert.ok(lines.length <= 25, `${lines.length} lines`)
  assert.match(rendered, /more line\(s\)/)
})
