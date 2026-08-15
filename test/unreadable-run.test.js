import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TERMINAL_WIDTH } from '../src/terminal.js'

const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

/** A run whose result.json was cut short — what an interrupted run or a full disk leaves. */
const withTruncatedRun = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-unreadable-'))
  writeFileSync(join(dir, 'spec-src'), '')
  mkdirSync(join(dir, '.proof'), { recursive: true })
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: a\n    run: echo ok\n')
  proof(dir, 'check')

  const file = join(dir, '.proof/runs/0001/result.json')
  writeFileSync(file, readFileSync(file, 'utf8').slice(0, 40))
  return dir
}

test('the regression: an unreadable run says which file and what to do', () => {
  // It reported the raw parser error — "Unexpected end of JSON input" — with no file name,
  // no run id and nothing actionable.
  const dir = withTruncatedRun()
  const { code, out } = proof(dir, 'report')

  assert.equal(code, 2)
  const flat = out.replace(/\s+/g, ' ')
  assert.match(flat, /\.proof\/runs\/0001\/result\.json could not be read/)
  assert.match(flat, /proof report --list/, 'it points at the command that still works')
  assert.match(flat, /not valid JSON/)
})

test('--list still reads every run it can', () => {
  // The list degrading gracefully is what made the single-run crash worth fixing: the
  // information was there, one command over.
  const dir = withTruncatedRun()
  proof(dir, 'check')

  const { out } = proof(dir, 'report', '--list')
  assert.match(out, /result\.json could not be read/, 'the broken run is shown, not hidden')
  assert.match(out, /0002/, 'the readable run is still listed')
})

test('a missing result.json is reported differently from a corrupt one', () => {
  const dir = withTruncatedRun()
  rmSync(join(dir, '.proof/runs/0001/result.json'))

  const { out } = proof(dir, 'report', '0001')
  assert.match(out.replace(/\s+/g, ' '), /did not finish|is not there/)
})

test('long errors are wrapped to the terminal width', () => {
  const dir = withTruncatedRun()
  const { out } = proof(dir, 'report')

  for (const line of out.split('\n')) {
    assert.ok(line.length <= TERMINAL_WIDTH, `line was ${line.length} characters: ${line}`)
  }
})

test('wrapping keeps the indent of a list of contract problems', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-unreadable-wrap-'))
  mkdirSync(join(dir, '.proof'), { recursive: true })
  writeFileSync(
    join(dir, '.proof/spec.yaml'),
    'goal: g\nchecks:\n  - name: b\n    file: {path: x, contains: ""}\n',
  )

  const { out } = proof(dir, 'check')
  const body = out.split('\n').filter(l => l.trim() && !l.startsWith('proof:'))
  assert.ok(body.length > 1, 'the message wrapped onto more than one line')
  for (const line of body) assert.match(line, /^ {2}/, `continuation lost its indent: ${JSON.stringify(line)}`)
})

test('the pre-formatted usage block is not re-wrapped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-unreadable-usage-'))
  const { out } = proof(dir, 'frobnicate')

  assert.match(out, /unknown command "frobnicate"/)
  assert.match(out, /^ {2}proof init "<requirement>" {3}create an acceptance contract/m,
    'the aligned usage table survives')
})

test('--json reports it as an error rather than crashing', () => {
  const dir = withTruncatedRun()
  const { code, out } = proof(dir, 'report', '--json')

  assert.equal(code, 2)
  assert.equal(JSON.parse(out).status, 'error')
})
