import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reverseGraph, dependents, resolveSpecifier, pathAliases } from '../src/changed.js'

const project = (config, layout) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-alias-'))
  process.chdir(dir)
  if (config) writeFileSync(config.name, config.body)
  for (const [path, body] of Object.entries(layout)) {
    mkdirSync(join(dir, path.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(path, body)
  }
  return dir
}

const TSCONFIG = {
  name: 'tsconfig.json',
  body: `{
  // aliases point at app/, not src/ — with trailing commas, as tsconfig allows
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./app/*"],
      "~features/*": ["./features/*"],
      "config": ["./app/config/index.ts"],
    },
  },
}`,
}

const LAYOUT = {
  'app/auth/session.ts': 'export const session = 1\n',
  'features/flags.ts': 'export const flag = 1\n',
  'app/config/index.ts': 'export const cfg = 1\n',
  'app/consumer.ts': "import { session } from '@/auth/session'\nimport { flag } from '~features/flags'\nimport { cfg } from 'config'\n",
}

test('the regression: configured aliases resolve, so the blast radius is not under-reported', () => {
  project(TSCONFIG, LAYOUT)
  const rev = reverseGraph()

  assert.deepEqual(dependents(['app/auth/session.ts'], 1, rev), [[join('app/consumer.ts')]])
  assert.deepEqual(dependents(['features/flags.ts'], 1, rev), [[join('app/consumer.ts')]])
  assert.deepEqual(dependents(['app/config/index.ts'], 1, rev), [[join('app/consumer.ts')]], 'exact, non-wildcard alias')
})

test('comments and trailing commas in tsconfig do not defeat the parse', () => {
  project(TSCONFIG, LAYOUT)
  assert.deepEqual(pathAliases(), [
    { pattern: '@/*', targets: [join('app/*')] },
    { pattern: '~features/*', targets: [join('features/*')] },
    { pattern: 'config', targets: [join('app/config/index.ts')] },
  ])
})

test('jsconfig.json works the same way', () => {
  project(
    { name: 'jsconfig.json', body: '{"compilerOptions":{"baseUrl":"src","paths":{"@app/*":["./modules/*"]}}}' },
    { 'src/modules/thing.js': 'export const t = 1\n', 'src/use.js': "import { t } from '@app/thing'\n" },
  )
  assert.equal(resolveSpecifier('@app/thing', 'src/use.js'), join('src/modules/thing.js'))
})

test('with no config, the `@/` convention still resolves', () => {
  project(null, {
    'src/auth/session.ts': 'export const s = 1\n',
    'src/consumer.ts': "import { s } from '@/auth/session'\n",
  })
  assert.equal(resolveSpecifier('@/auth/session', 'src/consumer.ts'), join('src/auth/session.ts'))
  assert.deepEqual(pathAliases(), [])
})

test('a malformed tsconfig degrades to the convention instead of crashing', () => {
  project(
    { name: 'tsconfig.json', body: '{ this is not json at all' },
    { 'src/a.ts': 'export const a = 1\n', 'src/b.ts': "import { a } from '@/a'\n" },
  )
  assert.deepEqual(pathAliases(), [])
  assert.equal(resolveSpecifier('@/a', 'src/b.ts'), join('src/a.ts'))
})

test('an unconfigured bare specifier stays unresolved', () => {
  project(TSCONFIG, LAYOUT)
  assert.equal(resolveSpecifier('lodash', 'app/consumer.ts'), null)
  assert.equal(resolveSpecifier('@scope/pkg', 'app/consumer.ts'), null)
})
