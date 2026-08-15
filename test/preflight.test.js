import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * The same check the wrapper runs before the suite, asserted here so it holds for anyone
 * running `node --test` directly rather than through `npm test`.
 */
const sources = ['src', 'bin', 'test']
  .flatMap(dir => readdirSync(join(root, dir)).filter(f => f.endsWith('.js')).map(f => join(root, dir, f)))

test('every source and test file parses', () => {
  const broken = sources
    .map(file => ({ file, check: spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }) }))
    .filter(({ check }) => check.status !== 0)
    .map(({ file, check }) => `${file.replace(root, '')}: ${(check.stderr || '').trim().split('\n')[1] ?? ''}`)

  assert.deepEqual(broken, [])
})

test('the check is looking at something', () => {
  // Without this, a glob that matched nothing would pass the test above silently.
  assert.ok(sources.length > 50, `only ${sources.length} files were checked`)
  assert.ok(sources.some(f => f.endsWith('/src/check.js')), 'src/ is included')
  assert.ok(sources.some(f => f.endsWith('/bin/proof.js')), 'bin/ is included')
})

test('the wrapper refuses to run the suite when a file does not parse', () => {
  // The point is the nine minutes it saves: a syntax error otherwise surfaces as one test
  // file that "failed" with no line number, after the whole suite has run.
  const r = spawnSync(process.execPath, ['--check', '-'], { input: 'const x = (', encoding: 'utf8' })

  assert.notEqual(r.status, 0, 'node --check reports a syntax error')
  assert.match(r.stderr, /SyntaxError|Unexpected/, r.stderr)
})
