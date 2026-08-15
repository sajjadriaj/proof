import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findGaps, assertedRoutes, assertedEnv, assertsMigration, infer } from '../src/infer.js'

// infer() prints; capture the payload by running it in json mode and parsing stdout
const inferJson = () => {
  let printed = ''
  const real = console.log
  console.log = s => { printed += s }
  try { infer({ json: true }) } finally { console.log = real }
  return JSON.parse(printed)
}

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-dedup-'))
  process.chdir(dir)
  mkdirSync('src', { recursive: true })
  return dir
}

const ROUTES = "app.post('/api/user', h)\napp.get('/api/admin', h)\nconst k = process.env.STRIPE_KEY\n"

test('the regression: a neighbouring name no longer swallows a real gap', () => {
  sandbox()
  writeFileSync('src/routes.ts', ROUTES)

  const existing = [
    { name: 'list users', http: { url: 'http://127.0.0.1:9/api/users' } },
    { name: 'admin dashboard loads', run: 'echo /api/administrators' },
    { name: 'stripe key format', run: 'echo STRIPE_KEY_ID is documented' },
  ]

  const gaps = findGaps(['src/routes.ts'], existing, { reportUncovered: false })
  assert.deepEqual(gaps.map(g => g.title).sort(), [
    'GET /api/admin is reachable',
    'POST /api/user is reachable',
    'env STRIPE_KEY is set at run time',
  ])
})

test('a genuinely matching check still suppresses its gap', () => {
  sandbox()
  writeFileSync('src/routes.ts', ROUTES)

  const existing = [
    { name: 'create user', http: { method: 'POST', path: '/api/user' } },
    { name: 'admin', http: { method: 'GET', url: 'http://127.0.0.1:9/api/admin' } },
    { name: 'stripe', env: 'STRIPE_KEY' },
  ]
  assert.deepEqual(findGaps(['src/routes.ts'], existing, { reportUncovered: false }), [])
})

test('method is part of the match, so POST and GET on one path are separate gaps', () => {
  sandbox()
  writeFileSync('src/routes.ts', "app.post('/api/user', h)\n")

  const existing = [{ name: 'read user', http: { method: 'GET', path: '/api/user' } }]
  const gaps = findGaps(['src/routes.ts'], existing, { reportUncovered: false })
  assert.deepEqual(gaps.map(g => g.title), ['POST /api/user is reachable'])
})

test('a browser expect_request counts as asserting that route', () => {
  sandbox()
  writeFileSync('src/routes.ts', "app.post('/api/user', h)\n")

  const existing = [{
    name: 'signup flow',
    browser: { base_url: 'http://x.test', visit: '/', flow: [{ expect_request: { method: 'POST', path: '/api/user' } }] },
  }]
  assert.deepEqual(findGaps(['src/routes.ts'], existing, { reportUncovered: false }), [])
})

test('migration gap is suppressed only by a check that actually migrates', () => {
  sandbox()
  mkdirSync('migrations', { recursive: true })
  writeFileSync('package.json', JSON.stringify({ devDependencies: { prisma: '^5' } }))

  const files = ['migrations/001_init.sql']
  assert.equal(findGaps(files, [{ name: 'a', run: 'echo migration notes' }], { reportUncovered: false }).length, 0)
  assert.equal(findGaps(files, [{ name: 'a', run: 'npm test' }], { reportUncovered: false }).length, 1)
  assert.equal(assertsMigration([{ run: 'npx prisma migrate deploy' }]), true)
})

test('the extractors read the fields they claim to', () => {
  assert.deepEqual(assertedRoutes([
    { http: { path: '/a' } },
    { http: { method: 'post', url: 'https://x.test/b?q=1' } },
    { browser: { flow: [{ expect_request: { method: 'PUT', path: '/c' } }, { click: 'x' }] } },
    { run: 'true' },
  ]), [
    { method: 'GET', path: '/a' },
    { method: 'POST', path: '/b' },
    { method: 'PUT', path: '/c' },
  ])

  assert.deepEqual([...assertedEnv([{ env: 'A' }, { env: { name: 'B' } }, { run: 'true' }])], ['A', 'B'])
})

test('infer warns when generated checks would need a serve block the contract lacks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-needsserve-'))
  process.chdir(dir)
  mkdirSync('src', { recursive: true })
  mkdirSync('.proof')
  writeFileSync('src/routes.ts', "app.post('/api/user', h)\n")
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: build\n    run: "true"\n')

  assert.equal(inferJson().needs_serve, true)

  // and the human output says so too
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { infer({}) } finally { console.log = real }
  assert.match(lines.join('\n'), /needs a serve block/)
})

test('no warning once the contract has a serve block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-hasserve-'))
  process.chdir(dir)
  mkdirSync('src', { recursive: true })
  mkdirSync('.proof')
  writeFileSync('src/routes.ts', "app.post('/api/user', h)\n")
  writeFileSync('.proof/spec.yaml',
    'goal: g\nserve:\n  run: npm run dev\n  ready_url: http://localhost:3000\nchecks:\n  - name: build\n    run: "true"\n')

  const real = console.log
  console.log = () => {}
  let out
  try { out = inferJson() } finally { console.log = real }
  assert.equal(out.needs_serve, false)
})
