import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reverseGraph, workspacePackages, resetWorkspaces, resolveSpecifier } from '../src/changed.js'

const write = (p, body) => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

const monorepo = (rootPkg, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-workspaces-'))
  process.chdir(dir)
  resetWorkspaces()

  write('package.json', rootPkg)
  write('packages/utils/package.json', { name: '@acme/utils' })
  write('packages/utils/src/index.ts', 'export const round = (n) => n\n')
  write('packages/api/package.json', { name: '@acme/api' })
  write('packages/api/src/server.ts', "import { round } from '@acme/utils'\n")
  for (const [p, body] of Object.entries(extra)) write(p, body)
  return dir
}

const importers = files => [...(reverseGraph(files).get('packages/utils/src/index.ts') ?? [])]
const FILES = ['packages/utils/src/index.ts', 'packages/api/src/server.ts']

test('the regression: a workspace package is a directory here, not an installed package', () => {
  // Treating `@acme/utils` as something in node_modules left the blast radius of every
  // shared package empty — "none found" for a change whose consumers are in the same checkout.
  monorepo({ name: 'root', private: true, workspaces: ['packages/*'] })
  assert.deepEqual(importers(FILES), ['packages/api/src/server.ts'])
})

test('the object form of workspaces works too', () => {
  monorepo({ name: 'root', private: true, workspaces: { packages: ['packages/*'] } })
  assert.deepEqual(importers(FILES), ['packages/api/src/server.ts'])
})

test('a pnpm workspace file is read', () => {
  monorepo({ name: 'root', private: true }, { 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n' })
  assert.deepEqual(importers(FILES), ['packages/api/src/server.ts'])
})

test('an exact path in the workspace list works', () => {
  monorepo({ name: 'root', private: true, workspaces: ['packages/utils', 'packages/api'] })
  assert.deepEqual(importers(FILES), ['packages/api/src/server.ts'])
})

test('a subpath import resolves inside the package', () => {
  monorepo({ name: 'root', private: true, workspaces: ['packages/*'] }, {
    'packages/utils/src/money.ts': 'export const money = 1\n',
    'packages/api/src/pay.ts': "import { money } from '@acme/utils/src/money'\n",
  })

  const files = [...FILES, 'packages/utils/src/money.ts', 'packages/api/src/pay.ts']
  const graph = reverseGraph(files)
  assert.deepEqual([...(graph.get('packages/utils/src/money.ts') ?? [])], ['packages/api/src/pay.ts'])
})

test('a genuine npm dependency is still treated as one', () => {
  // The rule must not swallow real packages, or dependency changes stop being seen.
  monorepo({ name: 'root', private: true, workspaces: ['packages/*'] })
  assert.equal(resolveSpecifier('lodash', 'packages/api/src/server.ts'), null)
})

test('a repository with no workspaces is unaffected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-workspaces-none-'))
  process.chdir(dir)
  resetWorkspaces()
  write('package.json', { name: 'app' })
  write('src/a.ts', "import { x } from '@acme/utils'\n")

  assert.equal(workspacePackages().size, 0)
  assert.equal(resolveSpecifier('@acme/utils', 'src/a.ts'), null)
})

test('the workspace map is rebuilt between runs', () => {
  // It is cached for the duration of a scan; a second project in the same process must
  // not inherit the first one's packages.
  monorepo({ name: 'root', private: true, workspaces: ['packages/*'] })
  assert.ok(workspacePackages().has('@acme/utils'))

  const other = mkdtempSync(join(tmpdir(), 'proof-workspaces-other-'))
  process.chdir(other)
  resetWorkspaces()
  write('package.json', { name: 'solo' })

  assert.equal(workspacePackages().size, 0)
})
