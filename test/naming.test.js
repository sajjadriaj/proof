import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coverage } from '../src/changed.js'

const named = (checks, file) => coverage(checks, [file])[0].checks

test('the regression: a longer word containing the stem does not count as naming the file', () => {
  const checks = [{ name: 'sessionStorage polyfill tests', run: 'npm test -- polyfill' }]
  assert.deepEqual(named(checks, 'src/auth/session.ts'), [])
})

test('a check that names the file, its path, or its basename does count', () => {
  assert.deepEqual(named([{ name: 'session tests', run: 'npm test -- session' }], 'src/auth/session.ts'), ['session tests'])
  assert.deepEqual(named([{ name: 'a', run: 'node src/auth/session.ts' }], 'src/auth/session.ts'), ['a'])
  assert.deepEqual(named([{ name: 'a', run: 'cat session.ts' }], 'src/auth/session.ts'), ['a'])
})

test('separators still delimit tokens, and case does not matter', () => {
  assert.deepEqual(named([{ name: 'reset-session flow', run: 'true' }], 'src/session.ts'), ['reset-session flow'])
  assert.deepEqual(named([{ name: 'SESSION smoke test', run: 'true' }], 'src/session.ts'), ['SESSION smoke test'])
})

test('a hyphenated stem falls back to a plain match rather than failing to match itself', () => {
  assert.deepEqual(
    named([{ name: 'session-store tests', run: 'true' }], 'src/session-store.ts'),
    ['session-store tests'],
  )
})

test('short and generic basenames never claim coverage on their own', () => {
  assert.deepEqual(named([{ name: 'api tests', run: 'true' }], 'src/api.ts'), [], 'stem under 4 chars')
  assert.deepEqual(named([{ name: 'index checks', run: 'true' }], 'src/index.ts'), [], 'index is not distinctive')
})

test('an unrelated check names nothing', () => {
  assert.deepEqual(named([{ name: 'billing totals', run: 'true' }], 'src/session.ts'), [])
})
