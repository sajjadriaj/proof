import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { check, clip } from '../src/check.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const run = async contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-output-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(contract))
  const code = await quiet(() => check({ json: true }))
  return {
    code,
    result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
    commands: readFileSync(join(dir, '.proof/runs/0001/commands.log'), 'utf8'),
  }
}

const NOISY = 'echo "ERROR: cannot resolve module \'./missing\' in src/app.ts:3"; '
  + 'for i in $(seq 1 120); do echo "  at frame $i"; done; exit 1'

test('the regression: the diagnostic first line survives in the evidence bundle', async () => {
  const { commands } = await run({ goal: 'build', checks: [{ name: 'build', run: NOISY }] })
  assert.match(commands, /ERROR: cannot resolve module/, 'commands.log holds the whole output')
  assert.match(commands, /at frame 1$/m)
  assert.match(commands, /at frame 120$/m)
})

test('result.json keeps both ends and names what it dropped', async () => {
  const { result } = await run({ goal: 'build', checks: [{ name: 'build', run: NOISY }] })
  const { output } = result.results[0]

  assert.match(output, /ERROR: cannot resolve module/, 'the head is kept, not just the tail')
  assert.match(output, /at frame 120/, 'the tail is kept too')
  assert.match(output, /line\(s\) omitted — full output in commands\.log/)
  assert.equal(result.results[0].output_clipped, true)
})

test('short output is stored whole, with no elision marker', async () => {
  const { result, commands } = await run({
    goal: 'short',
    checks: [{ name: 'short', run: 'echo one; echo two; exit 1' }],
  })
  assert.equal(result.results[0].output, 'one\ntwo')
  assert.equal(result.results[0].output_clipped, false)
  assert.doesNotMatch(commands, /omitted/)
})

test('the full text never bloats result.json', async () => {
  const { result } = await run({ goal: 'build', checks: [{ name: 'build', run: NOISY }] })
  assert.equal('full' in result.results[0], false, 'the complete output lives in commands.log only')
  assert.ok(result.results[0].output.split('\n').length < 60)
})

test('clip keeps both ends and counts the gap exactly', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n')
  const clipped = clip(lines, 3, 3).split('\n')

  assert.deepEqual(clipped.slice(0, 3), ['line 1', 'line 2', 'line 3'])
  assert.deepEqual(clipped.slice(-3), ['line 98', 'line 99', 'line 100'])
  assert.match(clipped[3], /94 line\(s\) omitted/)
  assert.equal(3 + 1 + 3, clipped.length)
})

test('clip leaves anything that already fits completely alone', () => {
  const short = 'a\nb\nc'
  assert.equal(clip(short, 20, 20), short)
  assert.equal(clip('', 20, 20), '')
})

test('every check contributes its command output to the log', async () => {
  const { commands } = await run({
    goal: 'several',
    checks: [
      { name: 'first', run: 'echo alpha' },
      { name: 'second', run: 'echo bravo' },
    ],
  })
  assert.match(commands, /\$ first \[run\] -> passed/)
  assert.match(commands, /alpha/)
  assert.match(commands, /\$ second \[run\] -> passed/)
  assert.match(commands, /bravo/)
})
