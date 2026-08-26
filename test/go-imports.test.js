import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reverseGraph, dependents, goImportsOf, resolveGoPackage, lookupKeys, resetScan } from '../src/changed.js'

// internal/store <- internal/service <- cmd/api, plus a third-party import alongside.
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-go-'))
  process.chdir(dir)
  resetScan()
  mkdirSync('internal/store', { recursive: true })
  mkdirSync('internal/service', { recursive: true })
  mkdirSync('cmd/api', { recursive: true })
  writeFileSync('go.mod', 'module github.com/acme/app\n\ngo 1.22\n')
  writeFileSync('internal/store/store.go', 'package store\n\ntype Order struct{}\n')
  writeFileSync('internal/store/query.go', 'package store\n\nfunc Find() {}\n')
  writeFileSync('internal/service/service.go',
    'package service\n\nimport (\n\t"fmt"\n\t"github.com/acme/app/internal/store"\n)\n\nfunc X(o store.Order) { fmt.Println(o) }\n')
  writeFileSync('cmd/api/main.go',
    'package main\n\nimport (\n\t_ "github.com/lib/pq"\n\tsvc "github.com/acme/app/internal/service"\n)\n\nfunc main() { svc.X() }\n')
  return dir
}

test('the regression: a changed Go file has a derivable blast radius', () => {
  // Every .go file used to come back as "not import-scannable" — an honest answer, and the
  // answer for an ecosystem `init` already scaffolds build, test and serve commands for.
  project()
  const levels = dependents([join('internal/store/store.go')], 1, reverseGraph())

  assert.deepEqual(levels[0], [join('internal/service/service.go')])
})

test('an import names a package, so any file in it carries the edge', () => {
  // `query.go` never mentions service.go, and changing it breaks the same importers as
  // store.go does. A Go import is a directory, not a file.
  project()
  const rev = reverseGraph()
  const levels = dependents([join('internal/store/query.go')], 1, rev)

  assert.deepEqual(levels[0], [join('internal/service/service.go')])
})

test('the walk goes outward through Go packages', () => {
  project()
  const levels = dependents([join('internal/store/store.go')], 3, reverseGraph())

  assert.deepEqual(levels[0], [join('internal/service/service.go')])
  assert.deepEqual(levels[1], [join('cmd/api/main.go')])
})

test('a deleted package still reports its importers', () => {
  // The highest-consequence change of all. The edge is keyed at the directory, which does not
  // need the file to exist — so this works without the fabricated candidate paths JS needs.
  const dir = project()
  const rev = reverseGraph()
  rmSync(join(dir, 'internal/store/store.go'))
  rmSync(join(dir, 'internal/store/query.go'))

  assert.deepEqual(dependents([join('internal/store/store.go')], 1, rev)[0],
    [join('internal/service/service.go')])
})

test('every import form is read, and a commented one is not', () => {
  assert.deepEqual(goImportsOf('package m\nimport "fmt"\n'), ['fmt'])
  assert.deepEqual(goImportsOf('package m\nimport alias "x/y"\n'), ['x/y'])
  assert.deepEqual(goImportsOf('package m\nimport _ "x/y"\n'), ['x/y'])
  assert.deepEqual(
    goImportsOf('package m\n\nimport (\n\t"fmt"\n\tm "a/b"\n\t_ "c/d"\n)\n'),
    ['fmt', 'a/b', 'c/d'],
  )
  // A commented-out import is not an edge, the same reason a commented-out route is not a gap.
  assert.deepEqual(goImportsOf('package m\n// import "gone"\nimport "fmt"\n'), ['fmt'])
  assert.deepEqual(goImportsOf('package m\n/*\nimport (\n"gone"\n)\n*/\nimport "fmt"\n'), ['fmt'])
})

test('a third-party import fabricates no local path', () => {
  // The Python side has `pyLooksLocal` for this. Here `resolve` simply returns null outside
  // the module, and there are no candidate paths to invent.
  project()
  assert.equal(resolveGoPackage('github.com/lib/pq'), null)
  assert.equal(resolveGoPackage('fmt'), null)
  // Not a prefix match on a partial segment either.
  assert.equal(resolveGoPackage('github.com/acme/application/x'), null)
})

test('an import inside the module resolves to its directory', () => {
  project()
  assert.equal(resolveGoPackage('github.com/acme/app/internal/store'), join('internal/store'))
  // The module root itself.
  assert.equal(resolveGoPackage('github.com/acme/app'), '.')
})

test('the most specific module claims an import', () => {
  // A Go monorepo has a go.mod per service, and the nested one owns its own subtree.
  const dir = mkdtempSync(join(tmpdir(), 'proof-go-multi-'))
  process.chdir(dir)
  resetScan()
  mkdirSync('services/api/handler', { recursive: true })
  writeFileSync('go.mod', 'module github.com/acme/root\n')
  writeFileSync('services/api/go.mod', 'module github.com/acme/root/services/api\n')
  writeFileSync('services/api/handler/h.go', 'package handler\n')

  assert.equal(resolveGoPackage('github.com/acme/root/services/api/handler'),
    join('services/api/handler'))
})

test('a Go file is looked up by its package as well as itself', () => {
  assert.deepEqual(lookupKeys(join('internal/store/store.go')), [join('internal/store/store.go'), join('internal/store')])
  // Other languages are keyed by path alone, as before.
  assert.deepEqual(lookupKeys('src/app.ts'), ['src/app.ts'])
  assert.deepEqual(lookupKeys('app/service.py'), ['app/service.py'])
})
