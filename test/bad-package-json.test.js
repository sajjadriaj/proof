import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changed, dependencyChanges, scanWarnings, resetScan } from '../src/changed.js'
import { infer } from '../src/infer.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

/** A package.json left mid-merge — the ordinary way this file stops parsing. */
const CONFLICTED = `{
  "dependencies": {
<<<<<<< HEAD
    "lodash": "2.0.0"
=======
    "lodash": "3.0.0"
>>>>>>> feature
  }
}
`

const project = (working = CONFLICTED) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-badpkg-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  writeFileSync('package.json', JSON.stringify({ dependencies: { lodash: '1.0.0' } }))
  git('add', '-A')
  git('commit', '-qm', 'init')

  writeFileSync('package.json', working)
  return dir
}

test('the regression: an unparseable package.json is not reported as no dependency changes', () => {
  // The file is right there in the changed list, so silence about it reads as an answer.
  project()
  resetScan()

  assert.deepEqual(dependencyChanges(), [], 'nothing can be derived')
  const warning = scanWarnings().find(w => w.includes('could not be parsed'))
  assert.ok(warning, `no warning: ${JSON.stringify(scanWarnings())}`)
  assert.match(warning, /dependency changes were not derived/)
})

test('the warning reaches the human output', () => {
  project()
  const out = captured(() => changed({})).replace(/\s+/g, ' ')

  assert.match(out, /package\.json could not be parsed/)
  assert.match(out, /dependency changes were not derived/)
})

test('the parse error itself is included', () => {
  // "could not be parsed" alone leaves someone staring at a file that looks fine to them.
  project()
  resetScan()
  dependencyChanges()

  assert.match(scanWarnings().find(w => w.includes('could not be parsed')), /position \d+|line \d+/)
})

test('infer carries it too', () => {
  project()
  const out = JSON.parse(captured(() => infer({ json: true })))
  assert.ok(out.warnings.some(w => w.includes('could not be parsed')), JSON.stringify(out.warnings))
})

test('a valid package.json produces no such warning, and real changes are still found', () => {
  project(JSON.stringify({ dependencies: { lodash: '2.0.0' } }))
  resetScan()

  assert.deepEqual(dependencyChanges(), [{ name: 'lodash', from: '1.0.0', to: '2.0.0', manifest: 'package.json' }])
  assert.equal(scanWarnings().filter(w => w.includes('could not be parsed')).length, 0)
})

test('the record is cleared between runs', () => {
  project()
  resetScan()
  dependencyChanges()
  assert.ok(scanWarnings().some(w => w.includes('could not be parsed')))

  writeFileSync('package.json', JSON.stringify({ dependencies: { lodash: '2.0.0' } }))
  resetScan()
  dependencyChanges()
  assert.equal(scanWarnings().filter(w => w.includes('could not be parsed')).length, 0)
})

test('a project with no package.json is not a parse failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-badpkg-none-'))
  process.chdir(dir)
  resetScan()

  assert.deepEqual(dependencyChanges(), [])
  assert.equal(scanWarnings().filter(w => w.includes('could not be parsed')).length, 0)
})
