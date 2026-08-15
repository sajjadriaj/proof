import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changed, aliasConfigError, pathAliases } from '../src/changed.js'
import { infer } from '../src/infer.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const project = tsconfig => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-degraded-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('app/auth', { recursive: true })
  mkdirSync('app/api', { recursive: true })
  mkdirSync('.proof')
  if (tsconfig) writeFileSync('tsconfig.json', tsconfig)
  writeFileSync('app/auth/session.ts', 'export const session = 1\n')
  writeFileSync('app/api/login.ts', "import { session } from '@/auth/session'\n")
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: x\n    run: "true"\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync('app/auth/session.ts', 'export const session = 2\n')
  return dir
}

const BROKEN = `{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./app/*"] }
}`

const GOOD = '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["./app/*"]}}}'

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

test('the regression: a malformed config says so instead of quietly reporting no dependents', () => {
  project(BROKEN)
  assert.deepEqual(pathAliases(), [], 'aliases really are unavailable')
  assert.match(aliasConfigError(), /tsconfig\.json could not be parsed/)

  const out = captured(() => changed({}))
  assert.match(out, /none found \(import scan, depth 1\)/)
  assert.match(out.replace(/\s+/g, ' '), /import aliases are unresolved, so dependents may be missing/)
})

test('a valid config resolves the dependent and warns about nothing', () => {
  project(GOOD)
  assert.equal(aliasConfigError(), null)

  const out = captured(() => changed({}))
  assert.match(out, /app\/api\/login\.ts/)
  assert.doesNotMatch(out, /NOTE/)
})

test('no config at all is not an error', () => {
  project(null)
  assert.equal(aliasConfigError(), null)
  assert.doesNotMatch(captured(() => changed({})), /NOTE/)
})

test('changed --json carries the warning for agents', () => {
  project(BROKEN)
  const out = JSON.parse(captured(() => changed({ json: true })))
  assert.equal(out.warnings.length, 1)
  assert.match(out.warnings[0], /could not be parsed/)
})

test('infer warns too, including on the no-gaps-found path', () => {
  project(BROKEN)
  const out = captured(() => infer({}))
  assert.match(out, /could not be parsed/)

  const json = JSON.parse(captured(() => infer({ json: true })))
  assert.equal(json.warnings.length, 1)
})

test('the caveat precedes the "no gaps" conclusion it undermines', () => {
  project(BROKEN)
  const out = captured(() => infer({}))
  if (out.includes('No verification gaps found')) {
    assert.ok(
      out.indexOf('could not be parsed') < out.indexOf('No verification gaps found'),
      'the reason the scan is unreliable must come before the reassuring conclusion',
    )
  }
})
