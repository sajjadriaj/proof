import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { check, boundedSink } from '../src/check.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

test('the regression: a flooding command still produces a complete evidence bundle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-flood-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'runaway output',
    checks: [{ name: 'floods stdout', timeout: 3, run: "yes 'this line repeats forever and consumes memory'" }],
  }))

  assert.equal(await quiet(() => check({ json: true })), 1, 'the check times out and fails')

  assert.ok(existsSync(join(dir, '.proof/runs/0001/result.json')), 'evidence survives the flood')
  assert.ok(existsSync(join(dir, '.proof/runs/0001/commands.log')))

  // What proof held is what matters, and it is measurable directly. Process heap is not:
  // the suite runs many tests in one process, so GC timing swamps the signal.
  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  const retained = statSync(join(dir, '.proof/runs/0001/commands.log')).size
  // magnitude depends on machine speed; that the bound engaged and held does not
  assert.ok(r.results[0].output_dropped > 0, 'the command produced more than proof retains')
  assert.ok(retained < 3 * 1024 * 1024, `retained ${retained} bytes of it`)
})

test('the retained log is bounded and says what it dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-flood2-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'runaway output',
    checks: [{ name: 'floods stdout', timeout: 3, run: "yes 'repeating line of output'" }],
  }))

  await quiet(() => check({ json: true }))

  const log = readFileSync(join(dir, '.proof/runs/0001/commands.log'), 'utf8')
  assert.ok(statSync(join(dir, '.proof/runs/0001/commands.log')).size < 3 * 1024 * 1024, 'the log is bounded')
  assert.match(log, /character\(s\) dropped — output exceeded proof's \d+ character buffer/)

  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.ok(r.results[0].output_dropped > 0, 'the count is recorded as evidence')
})

test('ordinary output is untouched — no marker, nothing dropped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-flood3-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'normal output',
    checks: [{ name: 'chatty', run: 'for i in $(seq 1 500); do echo "line $i"; done' }],
  }))

  assert.equal(await quiet(() => check({ json: true })), 0)

  const log = readFileSync(join(dir, '.proof/runs/0001/commands.log'), 'utf8')
  assert.doesNotMatch(log, /dropped/)
  assert.match(log, /^line 1$/m)
  assert.match(log, /^line 500$/m, 'every line is still there')

  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.equal('output_dropped' in r.results[0], false)
})

test('boundedSink keeps both ends and counts the gap exactly', () => {
  const sink = boundedSink(10)
  sink.push('HEADHEADHE')       // fills the head
  sink.push('xxxxxxxxxxxxxxx')  // dropped middle
  sink.push('TAILTAILTA')       // becomes the tail

  const text = sink.text()
  assert.match(text, /^HEADHEADHE/)
  assert.match(text, /TAILTAILTA$/)
  assert.equal(sink.dropped, 15)
  assert.match(text, /… 15 character\(s\) dropped/)
})

test('boundedSink under the cap is byte-for-byte', () => {
  const sink = boundedSink(100)
  sink.push('hello ')
  sink.push('world')
  assert.equal(sink.text(), 'hello world')
  assert.equal(sink.dropped, 0)
})
