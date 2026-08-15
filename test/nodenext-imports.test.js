import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reverseGraph, resolveSpecifier, specifierCandidates } from '../src/changed.js'

const project = files => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-nodenext-'))
  process.chdir(dir)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
  return Object.keys(files)
}

const importersOf = (files, target) => [...(reverseGraph(files).get(target) ?? [])]

test('the regression: a .js specifier resolves to the .ts that produces it', () => {
  // TypeScript's NodeNext convention: sources import each other by the path the *output*
  // will have. Without this the blast radius of any such project was empty, and `changed`
  // reported "none found" for every edit — a scan that resolved nothing, read as an answer.
  const files = project({
    'src/money.ts': 'export const money = 1\n',
    'src/cart.ts': "import { money } from './money.js'\n",
  })

  assert.deepEqual(importersOf(files, 'src/money.ts'), ['src/cart.ts'])
})

test('every output extension maps to its sources', () => {
  const files = project({
    'src/a.tsx': 'export const a = 1\n',
    'src/b.mts': 'export const b = 1\n',
    'src/c.cts': 'export const c = 1\n',
    'src/use.ts': "import './a.jsx'\nimport './b.mjs'\nimport './c.cjs'\n",
  })

  for (const target of ['src/a.tsx', 'src/b.mts', 'src/c.cts']) {
    assert.deepEqual(importersOf(files, target), ['src/use.ts'], `${target} has no importer`)
  }
})

test('a real .js file still wins over the .ts that could produce it', () => {
  // Both exist: the file actually named by the specifier is the one imported.
  project({
    'src/money.js': 'export const money = 1\n',
    'src/money.ts': 'export const money = 2\n',
  })

  assert.equal(resolveSpecifier('./money.js', 'src/cart.ts'), 'src/money.js')
})

test('extension-less and directory imports are unaffected', () => {
  const files = project({
    'src/lib/session/index.ts': 'export const login = 1\n',
    'src/plain.ts': 'export const plain = 1\n',
    'src/use.ts': "import './lib/session'\nimport './plain'\n",
  })

  assert.deepEqual(importersOf(files, 'src/lib/session/index.ts'), ['src/use.ts'])
  assert.deepEqual(importersOf(files, 'src/plain.ts'), ['src/use.ts'])
})

test('a deleted .ts is still found through its .js specifier', () => {
  // The candidate list is what lets a just-deleted module be traced to its importers,
  // which is the blast radius that matters most.
  project({ 'src/use.ts': "import './money.js'\n" })

  assert.ok(specifierCandidates('./money.js', 'src/use.ts').includes('src/money.ts'),
    'the .ts the specifier would name is not among the candidates')
})

test('a specifier naming a file that exists nowhere resolves to nothing', () => {
  project({ 'src/use.ts': "import './absent.js'\n" })
  assert.equal(resolveSpecifier('./absent.js', 'src/use.ts'), null)
})
