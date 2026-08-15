import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { routesIn, infer } from '../src/infer.js'
import { validateSpec } from '../src/validate.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

const write = (path, body) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

test('the regression: a framework file route is a route, not just a file', () => {
  // fileRoute was unit-tested, but nothing ran it through routesIn — so the path from
  // "a file exists at app/api/users/route.ts" to "GET /api/users is reachable" never ran.
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-'))
  process.chdir(dir)
  write('app/api/users/route.ts', 'export async function GET() { return Response.json([]) }\n')

  assert.deepEqual(routesIn('app/api/users/route.ts'), [
    { method: 'GET', path: '/api/users', at: 'app/api/users/route.ts:1' },
  ])
})

test('a pages/api file is one too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-pages-'))
  process.chdir(dir)
  write('pages/api/legacy.ts', 'export default function handler(req, res) { res.end() }\n')

  assert.deepEqual(routesIn('pages/api/legacy.ts'), [
    { method: 'GET', path: '/api/legacy', at: 'pages/api/legacy.ts:1' },
  ])
})

test('a file route and a route call in the same file are both reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-both-'))
  process.chdir(dir)
  write('app/api/mixed/route.ts', "export async function GET() {}\napp.post('/api/other', h)\n")

  const paths = routesIn('app/api/mixed/route.ts').map(r => `${r.method} ${r.path}`)
  assert.deepEqual(paths, ['GET /api/mixed', 'POST /api/other'])
})

test('infer offers a check for a framework route in the diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-infer-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  writeFileSync('README.md', 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  write('app/api/users/route.ts', 'export async function GET() { return Response.json([]) }\n')

  const out = JSON.parse(captured(() => infer({ json: true })))
  const gap = out.gaps.find(g => g.title.includes('/api/users'))

  assert.ok(gap, `no gap for the new route: ${JSON.stringify(out.gaps)}`)
  assert.equal(gap.severity, 'HIGH')
  assert.equal(gap.check.http.path, '/api/users')
  assert.equal(gap.at, 'app/api/users/route.ts:1')
})

test('a route already covered by the contract is not offered again', () => {
  // The check is generated with an http verb, so a contract that already has it must
  // suppress the gap — otherwise `infer --write` grows a duplicate on every run.
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-covered-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    'goal: g\nserve:\n  run: sleep 30\n  ready_url: http://localhost:9\n  reuse_existing: true\n'
    + 'checks:\n  - name: users\n    http: {method: GET, path: /api/users, expect: {status: 200}}\n')
  writeFileSync('README.md', 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  write('app/api/users/route.ts', 'export async function GET() {}\n')

  const out = JSON.parse(captured(() => infer({ json: true })))
  assert.equal(out.gaps.filter(g => g.title.includes('/api/users is reachable')).length, 0)
})

test('a contract that is not a mapping is rejected as one', () => {
  // `- goal: x` at the top of the file makes the document a list.
  assert.deepEqual(validateSpec([{ goal: 'g' }]), ['spec must be a YAML mapping'])
  assert.deepEqual(validateSpec('goal: g'), ['spec must be a YAML mapping'])
  assert.deepEqual(validateSpec(null), ['spec must be a YAML mapping'])
})

test('a check that is not a mapping is located by index', () => {
  const problems = validateSpec({ goal: 'g', checks: ['run: npm test'] })
  assert.match(problems.join('\n'), /check\[0\]: must be a mapping/)
})

test('the regression: an app-router file declares its methods by what it exports', () => {
  // Assuming GET generated `http: {method: GET, path: /api/checkout, expect: {status: 200}}`
  // for a route that only exports POST — a check that can never pass, offered as the fix.
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-method-'))
  process.chdir(dir)
  write('app/api/checkout/route.ts', 'export async function POST(req) { return Response.json({}) }\n')

  assert.deepEqual(routesIn('app/api/checkout/route.ts'), [
    { method: 'POST', path: '/api/checkout', at: 'app/api/checkout/route.ts:1' },
  ])
})

test('a route exporting several handlers yields one entry per method', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-many-'))
  process.chdir(dir)
  write('app/api/items/route.ts',
    'export async function GET() {}\nexport async function POST() {}\nexport const DELETE = async () => {}\n')

  assert.deepEqual(routesIn('app/api/items/route.ts').map(r => `${r.method} ${r.path}`),
    ['GET /api/items', 'POST /api/items', 'DELETE /api/items'])
})

test('each method points at the line that declares it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-lines-'))
  process.chdir(dir)
  write('app/api/x/route.ts', '// header\n\nexport async function GET() {}\nexport async function POST() {}\n')

  const at = routesIn('app/api/x/route.ts').map(r => r.at)
  assert.deepEqual(at, ['app/api/x/route.ts:3', 'app/api/x/route.ts:4'])
})

test('a pages/api handler still stands for the route as GET', () => {
  // One default export answers every method, so there is nothing better to name.
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-default-'))
  process.chdir(dir)
  write('pages/api/legacy.ts', 'export default function handler(req, res) { res.end() }\n')

  assert.deepEqual(routesIn('pages/api/legacy.ts'), [
    { method: 'GET', path: '/api/legacy', at: 'pages/api/legacy.ts:1' },
  ])
})

test('a commented-out handler does not declare a method', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-commented-'))
  process.chdir(dir)
  write('app/api/y/route.ts', '// export async function DELETE() {}\nexport async function GET() {}\n')

  assert.deepEqual(routesIn('app/api/y/route.ts').map(r => r.method), ['GET'])
})

test('a duplicated export is reported once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-fileroutes-dupe-'))
  process.chdir(dir)
  write('app/api/z/route.ts', 'export async function GET() {}\nexport const GET2 = 1\nexport async function GET() {}\n')

  assert.equal(routesIn('app/api/z/route.ts').filter(r => r.method === 'GET').length, 1)
})
