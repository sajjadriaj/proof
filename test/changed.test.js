import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reverseGraph, dependents, resolveSpecifier, coverage } from '../src/changed.js'

// src/auth/session.ts <- middleware/auth.ts <- api/login.ts
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-changed-'))
  process.chdir(dir)
  mkdirSync('src/auth', { recursive: true })
  mkdirSync('middleware', { recursive: true })
  mkdirSync('api', { recursive: true })
  mkdirSync('node_modules/pkg', { recursive: true })
  writeFileSync('src/auth/session.ts', 'export const session = 1\n')
  writeFileSync('src/auth/index.ts', "export * from './session'\n")
  writeFileSync('middleware/auth.ts', "import { session } from '../src/auth/session'\n")
  writeFileSync('api/login.ts', "const a = require('../middleware/auth')\nimport('@/auth/session')\n")
  writeFileSync('api/logout.ts', "import '../middleware/auth'\n") // bare side-effect import
  writeFileSync('api/unrelated.ts', "import x from 'lodash'\n")
  writeFileSync('node_modules/pkg/i.ts', "import '../../src/auth/session'\n")
  return dir
}

test('reverse graph resolves relative, alias and require specifiers, skips node_modules', () => {
  project()
  const rev = reverseGraph()
  assert.deepEqual([...rev.get(join('src/auth/session.ts'))].sort(), [
    join('api/login.ts'),
    join('middleware/auth.ts'),
    join('src/auth/index.ts'),
  ])
  assert.deepEqual([...rev.get(join('middleware/auth.ts'))].sort(), [join('api/login.ts'), join('api/logout.ts')])
})

test('dependents walks outward one hop per depth level', () => {
  project()
  const rev = reverseGraph()
  const one = dependents(['src/auth/session.ts'], 1, rev)
  assert.equal(one.length, 1)
  assert.ok(one[0].includes('middleware/auth.ts'))

  // api/login.ts imports session directly (hop 1); api/logout.ts only reaches it via middleware (hop 2)
  const two = dependents(['src/auth/session.ts'], 3, rev)
  assert.equal(two.length, 2)
  assert.deepEqual(two[1], [join('api/logout.ts')])
  assert.ok(!two.flat().includes(join('api/unrelated.ts')))
})

test('resolveSpecifier finds index files and returns null for bare packages', () => {
  project()
  assert.equal(resolveSpecifier('./auth', 'src/x.ts'), join('src/auth/index.ts'))
  assert.equal(resolveSpecifier('lodash', 'api/unrelated.ts'), null)
})

test('coverage flags files no check mentions', () => {
  const checks = [
    { name: 'session tests', run: 'npm test -- session' },
    { name: 'login flow', http: { path: '/api/login' } },
  ]
  const cov = coverage(checks, ['src/auth/session.ts', 'api/unrelated.ts'])
  assert.deepEqual(cov[0].checks, ['session tests'])
  assert.deepEqual(cov[1].checks, [])
})
