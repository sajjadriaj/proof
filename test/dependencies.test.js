import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changed, dependencyChanges, packageOf, reverseGraph, PKG } from '../src/changed.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const project = (pkg = { lodash: '^4.17.20', axios: '^1.6.0' }) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-deps-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('package.json', JSON.stringify({ name: 'app', dependencies: pkg }))
  writeFileSync('src/list.ts', "import _ from 'lodash'\nexport const a = _.chunk\n")
  writeFileSync('src/merge.ts', "import { merge } from 'lodash/fp'\nexport const b = merge\n")
  writeFileSync('src/http.ts', "import axios from 'axios'\nexport const c = axios.get\n")
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: x\n    run: "true"\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return dir
}

const bump = deps => writeFileSync('package.json', JSON.stringify({ name: 'app', dependencies: deps }))

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

test('the regression: a dependency bump reports what imports it', () => {
  project()
  bump({ lodash: '^4.17.21', axios: '^1.6.0' })

  const out = captured(() => changed({}))
  assert.match(out, /Changed dependencies:\n\s+lodash\s+\^4\.17\.20 → \^4\.17\.21/, `got:\n${out}`)
  assert.match(out, /src\/list\.ts/)
  assert.match(out, /src\/merge\.ts/, 'subpath imports count as the same package')
  assert.doesNotMatch(out, /src\/http\.ts/, 'axios was untouched')
})

test('added and removed dependencies are labelled as such', () => {
  project()
  bump({ axios: '^1.6.0', dayjs: '^1.11.0' })

  const changes = dependencyChanges()
  assert.deepEqual(changes, [
    { name: 'dayjs', from: null, to: '^1.11.0', manifest: 'package.json' },
    { name: 'lodash', from: '^4.17.20', to: null, manifest: 'package.json' },
  ])

  const out = captured(() => changed({}))
  assert.match(out, /dayjs\s+\(added\) → \^1\.11\.0/)
  assert.match(out, /lodash\s+\^4\.17\.20 → \(removed\)/)
})

test('an unchanged package.json produces no dependency entries', () => {
  project()
  writeFileSync('src/list.ts', "import _ from 'lodash'\nexport const a = _.chunk // touched\n")

  const out = JSON.parse(captured(() => changed({ json: true })))
  assert.deepEqual(out.dependencies, [])
  assert.deepEqual(out.changed, ['src/list.ts'])
})

test('packageOf resolves scopes and subpaths, and rejects local specifiers', () => {
  assert.equal(packageOf('lodash'), 'lodash')
  assert.equal(packageOf('lodash/fp'), 'lodash')
  assert.equal(packageOf('@scope/pkg'), '@scope/pkg')
  assert.equal(packageOf('@scope/pkg/deep'), '@scope/pkg')
  assert.equal(packageOf('./local'), null)
  assert.equal(packageOf('@/aliased'), null, 'an alias is not a package')
})

test('package keys never leak into the file graph as paths', () => {
  project()
  const rev = reverseGraph()

  assert.deepEqual([...rev.get(`${PKG}lodash`)].sort(), [join('src/list.ts'), join('src/merge.ts')])
  for (const key of rev.keys()) {
    assert.ok(key.startsWith(PKG) || key.startsWith('src'), `unexpected key: ${key}`)
  }
})

test('--json carries the dependency changes for agents', () => {
  project()
  bump({ lodash: '^4.17.21', axios: '^1.6.0' })

  const out = JSON.parse(captured(() => changed({ json: true })))
  assert.deepEqual(out.dependencies, [{ name: 'lodash', from: '^4.17.20', to: '^4.17.21', manifest: 'package.json' }])
  assert.deepEqual(out.dependents[0].sort(), [join('src/list.ts'), join('src/merge.ts')])
})

test('devDependencies count too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-deps-dev-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('.proof')
  writeFileSync('package.json', JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }))
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: x\n    run: "true"\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  writeFileSync('package.json', JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }))
  assert.deepEqual(dependencyChanges(), [{ name: 'vitest', from: '^1.0.0', to: '^2.0.0', manifest: 'package.json' }])
})
