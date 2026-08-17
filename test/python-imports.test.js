import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reverseGraph, dependents, resolvePyModule, pyImportsOf, coverage, PKG } from '../src/changed.js'

// app/repo.py <- app/service.py <- app/api.py, plus a src-layout package alongside.
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-py-'))
  process.chdir(dir)
  mkdirSync('app/sub', { recursive: true })
  mkdirSync('src/pkg', { recursive: true })
  writeFileSync('app/__init__.py', '')
  writeFileSync('app/sub/__init__.py', '')
  writeFileSync('app/repo.py', 'VALUE = 1\n')
  writeFileSync('app/sub/deep.py', 'DEEP = 1\n')
  writeFileSync('app/service.py', 'from app.repo import VALUE\n')
  writeFileSync('app/api.py', 'import app.service\nfrom temporalio import workflow\n')
  writeFileSync('app/relative.py', 'from . import repo\nfrom .sub.deep import DEEP\n')
  writeFileSync('app/parent.py', 'from ..app.repo import VALUE\n')
  writeFileSync('src/pkg/__init__.py', '')
  writeFileSync('src/pkg/thing.py', 'THING = 1\n')
  writeFileSync('src/pkg/user.py', 'from pkg.thing import THING\n')
  return dir
}

test('a python import makes an edge, so the blast radius is derivable', () => {
  project()
  const rev = reverseGraph()
  assert.deepEqual([...rev.get(join('app/repo.py'))].sort(),
    [join('app/parent.py'), join('app/relative.py'), join('app/service.py')])
  assert.deepEqual([...rev.get(join('app/service.py'))], [join('app/api.py')])
})

test('dependents walks outward through python modules', () => {
  project()
  const levels = dependents([join('app/repo.py')], 3, reverseGraph())
  // service.py imports repo directly; api.py only reaches it through service.py
  assert.ok(levels[0].includes(join('app/service.py')))
  assert.deepEqual(levels[1], [join('app/api.py')])
})

test('`from a.b import c` prefers the submodule and falls back to the parent', () => {
  project()
  // c is a module here
  assert.equal(resolvePyModule('app.sub.deep', 'app/relative.py'), join('app/sub/deep.py'))
  // VALUE is a name inside app/repo.py, so the parent module is the file that matters
  assert.equal(resolvePyModule('app.repo.VALUE', 'app/service.py'), null)
  assert.equal(resolvePyModule('app.repo', 'app/service.py'), join('app/repo.py'))
})

test('a package resolves to its __init__.py, and the src layout is searched', () => {
  project()
  assert.equal(resolvePyModule('app', 'app/api.py'), join('app/__init__.py'))
  assert.equal(resolvePyModule('pkg.thing', 'src/pkg/user.py'), join('src/pkg/thing.py'))
  assert.deepEqual([...reverseGraph().get(join('src/pkg/thing.py'))], [join('src/pkg/user.py')])
})

test('a third-party module becomes a package edge, not a fabricated local path', () => {
  project()
  const rev = reverseGraph()
  assert.deepEqual([...rev.get(`${PKG}temporalio`)], [join('app/api.py')])
  // The paths `import temporalio` would name if it were local are not in this repo, and
  // recording them would key edges at files that can never exist.
  assert.equal(rev.get(join('temporalio/__init__.py')), undefined)
  assert.equal(rev.get('temporalio.py'), undefined)
})

test('a deleted module still finds its importers', () => {
  project()
  // app/repo.py deleted: nothing resolves, but the importers are the whole point.
  rmSync('app/repo.py')
  const rev = reverseGraph()
  assert.ok([...(rev.get(join('app/repo.py')) ?? [])].includes(join('app/service.py')),
    'the deleted path still keys its importers')
})

test('a commented or docstringed import is not an edge', () => {
  project()
  writeFileSync('app/quiet.py',
    '"""\nfrom app.repo import VALUE\n"""\n# from app.repo import VALUE\nX = 1\n')
  assert.equal(reverseGraph().get(join('app/quiet.py')), undefined)
  const importers = [...(reverseGraph().get(join('app/repo.py')) ?? [])]
  assert.ok(!importers.includes(join('app/quiet.py')),
    'an import that the runtime never executes is not a dependency')
})

test('a parenthesised import list names every module in it, not just the first line', () => {
  const specs = pyImportsOf('from app.sub import (\n  deep,\n  other,\n)\n')
  assert.ok(specs.includes('app.sub.deep'), specs.join(' '))
  assert.ok(specs.includes('app.sub.other'), specs.join(' '))
})

test('__init__.py is identified by its package, the way index.ts is', () => {
  // Its own stem names nothing: every package has one. Without that, a check naming the
  // package read as naming no file, and the package file was reported uncovered forever.
  const checks = [{ name: 'the temporal package converges', run: 'pytest tests/temporal' }]
  assert.deepEqual(coverage(checks, [join('app/temporal/__init__.py')])[0].checks,
    ['the temporal package converges'])
})

test('aliases and star imports are read as the module they name', () => {
  const specs = pyImportsOf('import app.service as svc\nfrom app.repo import *\n')
  assert.ok(specs.includes('app.service'))
  assert.ok(specs.includes('app.repo'))
  assert.ok(!specs.some(s => s.includes('*')), specs.join(' '))
})
