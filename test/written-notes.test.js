import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import YAML from 'yaml'
import { infer } from '../src/infer.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

const project = files => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-written-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    'goal: g\nserve:\n  run: sleep 30\n  ready_url: http://localhost:9\n  reuse_existing: true\n'
    + 'checks:\n  - name: a\n    run: "true"\n')
  writeFileSync('README.md', 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  return dir
}

const spec = dir => readFileSync(join(dir, '.proof/spec.yaml'), 'utf8')

test('the regression: a generated check carries its caveat into the contract', () => {
  // The note was printed once, in a terminal. Whoever opens the contract next — a teammate,
  // CI, the same person on Monday — saw only a check that fails against a nonsense path.
  const dir = project({ 'app/api/orders/[id]/route.ts': 'export async function GET() {}\n' })
  captured(() => infer({ write: true }))

  assert.match(spec(dir), /# dynamic segment — replace with a real value/)
})

test('the comment sits with the check it belongs to', () => {
  const dir = project({
    'app/api/health/route.ts': 'export async function GET() {}\n',
    'app/api/orders/[id]/route.ts': 'export async function GET() {}\n',
  })
  captured(() => infer({ write: true }))

  const lines = spec(dir).split('\n')
  const comment = lines.findIndex(l => l.includes('dynamic segment'))
  assert.ok(comment >= 0, spec(dir))
  assert.match(lines[comment + 1], /name: get \/api\/orders\/\[id\]/, 'it precedes the right check')
})

test('the contract still parses, and the comment is not part of any value', () => {
  const dir = project({ 'app/api/orders/[id]/route.ts': 'export async function GET() {}\n' })
  captured(() => infer({ write: true }))

  const doc = YAML.parse(spec(dir))
  const written = doc.checks.find(c => c.name?.includes('/api/orders'))
  assert.equal(written.http.path, '/api/orders/[id]', 'the value is exactly the path')
})

test('infer says the run it just wrote will be refused', () => {
  // Otherwise the next command is the one that explains what this one did.
  const dir = project({ 'app/api/orders/[id]/route.ts': 'export async function GET() {}\n' })
  const out = captured(() => infer({ write: true })).replace(/\s+/g, ' ')

  assert.match(out, /1 generated check\(s\) still contain a route pattern/)
  assert.match(out, /`proof check` refuses to run until you do/)
})

test('a contract with no patterns gets no such note', () => {
  const dir = project({ 'app/api/health/route.ts': 'export async function GET() {}\n' })
  const out = captured(() => infer({ write: true }))

  assert.match(out, /Appended/, 'checks were actually written')
  assert.doesNotMatch(out, /still contain a route pattern/)
  assert.doesNotMatch(spec(dir), /dynamic segment/)
})

test('without --write nothing is added and nothing is claimed', () => {
  const dir = project({ 'app/api/orders/[id]/route.ts': 'export async function GET() {}\n' })
  const before = spec(dir)
  const out = captured(() => infer({}))

  assert.equal(spec(dir), before, 'the contract is untouched')
  assert.doesNotMatch(out, /still contain a route pattern/, 'and nothing was written to warn about')
})
