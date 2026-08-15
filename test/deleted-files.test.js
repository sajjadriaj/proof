import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changed, reverseGraph, dependents, specifierCandidates } from '../src/changed.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-deleted-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('src/session.ts', 'export const session = 1\n')
  writeFileSync('src/auth.ts', "import { session } from './session'\nexport const auth = session\n")
  writeFileSync('src/api.ts', "import { auth } from './auth'\n")
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: x\n    run: "true"\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return dir
}

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

test('the regression: deleting a module still reports everything that imported it', () => {
  project()
  rmSync('src/session.ts')

  const out = captured(() => changed({ depth: 2 }))
  assert.match(out, /Direct dependents:\n {2}src\/auth\.ts/, `got:\n${out}`)
  assert.match(out, /Dependents \(hop 2\):\n {2}src\/api\.ts/, 'and transitively')
})

test('the graph records importers of a path nothing occupies', () => {
  project()
  rmSync('src/session.ts')

  const rev = reverseGraph()
  assert.deepEqual([...rev.get(join('src/session.ts'))], [join('src/auth.ts')])
  assert.deepEqual(dependents(['src/session.ts'], 1, rev), [[join('src/auth.ts')]])
})

test('a live module still resolves to exactly one edge, not one per candidate', () => {
  project()
  const rev = reverseGraph()

  assert.deepEqual([...rev.get(join('src/session.ts'))], [join('src/auth.ts')])
  // no phantom entries for extensions the file does not have
  assert.equal(rev.has(join('src/session.js')), false)
  assert.equal(rev.has(join('src/session/index.ts')), false)
})

test('a typo\'d import is attributed to the file that contains it', () => {
  project()
  writeFileSync('src/typo.ts', "import { x } from './sesion'\n")

  const rev = reverseGraph()
  assert.deepEqual([...rev.get(join('src/sesion.ts'))], [join('src/typo.ts')])
})

test('bare package specifiers create no candidates at all', () => {
  project()
  assert.deepEqual(specifierCandidates('lodash', 'src/a.ts'), [])
  assert.deepEqual(specifierCandidates('@scope/pkg', 'src/a.ts'), [])

  const rev = reverseGraph()
  for (const key of rev.keys()) assert.ok(key.startsWith('src'), `unexpected graph key: ${key}`)
})

test('candidates cover the extensions and index files a specifier could mean', () => {
  project()
  const candidates = specifierCandidates('./session', 'src/auth.ts')
  assert.ok(candidates.includes(join('src/session.ts')))
  assert.ok(candidates.includes(join('src/session.js')))
  assert.ok(candidates.includes(join('src/session/index.ts')))
})
