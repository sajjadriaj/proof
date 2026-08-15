import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changed } from '../src/changed.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-unscannable-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('package.json', JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.20' } }))
  writeFileSync('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { lodash: { version: '4.17.20' } } }))
  writeFileSync('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }))
  writeFileSync('src/list.ts', "import _ from 'lodash'\nexport const a = _.chunk\n")
  writeFileSync('src/consumer.ts', "import { a } from './list'\nexport const b = a\n")
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

test('the regression: files proof cannot scan are named, not silently empty', () => {
  project()
  writeFileSync('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { lodash: { version: '4.17.21' } } }))
  writeFileSync('tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }))

  const out = captured(() => changed({}))
  assert.match(out, /Not import-scannable/)
  assert.match(out, /package-lock\.json/)
  assert.match(out, /tsconfig\.json/)
})

test('with nothing scannable, the radius is "not derivable" rather than "none found"', () => {
  project()
  writeFileSync('tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }))

  const out = captured(() => changed({}))
  assert.match(out, /not derivable — no changed file could be scanned for imports/)
  assert.doesNotMatch(out, /none found/, 'proof never ran a scan it could report as empty')
})

test('a source file with genuinely no importers still says "none found"', () => {
  project()
  writeFileSync('src/consumer.ts', "import { a } from './list'\nexport const b = a // touched\n")

  const out = captured(() => changed({}))
  assert.match(out, /none found \(import scan, depth 1\)/, 'a real empty result is still reported as such')
  assert.doesNotMatch(out, /Not import-scannable/)
})

test('package.json counts as scanned when its dependencies moved', () => {
  project()
  writeFileSync('package.json', JSON.stringify({ name: 'app', dependencies: { lodash: '^4.17.21' } }))

  const out = JSON.parse(captured(() => changed({ json: true })))
  assert.deepEqual(out.unscannable, [], 'it contributed a dependency seed, so it was scanned')
  assert.deepEqual(out.dependents[0], [join('src/list.ts')])
})

test('package.json counts as unscannable when only unrelated fields changed', () => {
  project()
  writeFileSync('package.json', JSON.stringify({
    name: 'app',
    scripts: { build: 'tsc' },
    dependencies: { lodash: '^4.17.20' },
  }))

  const out = JSON.parse(captured(() => changed({ json: true })))
  assert.deepEqual(out.dependencies, [])
  assert.deepEqual(out.unscannable, ['package.json'], 'no dependency moved, so nothing was derived from it')
})

test('a mixed diff scans what it can and names what it could not', () => {
  project()
  writeFileSync('src/list.ts', "import _ from 'lodash'\nexport const a = _.chunk // touched\n")
  writeFileSync('tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }))

  const out = JSON.parse(captured(() => changed({ json: true })))
  assert.deepEqual(out.unscannable, ['tsconfig.json'])
  assert.deepEqual(out.dependents[0], [join('src/consumer.ts')], 'the scannable half still produced a radius')
})
