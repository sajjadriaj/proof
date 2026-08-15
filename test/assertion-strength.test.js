import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * Tests about this suite, because a test that cannot fail is worse than no test: it reports
 * coverage that is not there.
 *
 * Both rules were found the same way — by sabotaging proof so it produced no output at all
 * and seeing which tests still passed.
 */
const dir = fileURLToPath(new URL('.', import.meta.url))
const files = readdirSync(dir).filter(f => f.endsWith('.test.js'))
const bodies = files.flatMap(f => {
  const src = readFileSync(join(dir, f), 'utf8')
  return src.split(/\ntest\(/).slice(1).map(part => ({
    file: f,
    name: (part.match(/^['"](.*?)['"]/) ?? [, '?'])[1],
    body: part.split('\n})')[0],
  }))
})

test('this audit is reading the suite it thinks it is', () => {
  assert.ok(files.length > 100, `only found ${files.length} test files`)
  assert.ok(bodies.length > 800, `only found ${bodies.length} tests`)
})

test('no test claims only an exit code from the CLI', () => {
  // exit 2 is what proof returns for every config error, so `assert.equal(exit, 2)` alone is
  // satisfied by a CLI that does nothing at all. Claim the reason as well as the number.
  const exitOnly = /assert\.equal\(\s*proof\([^)]*\)\.exit\s*,\s*[0-9]\s*[,)]/
  const claimsMore = /assert\.(match|doesNotMatch)\s*\(|\.out\b|\.stdout\b|JSON\.parse|readFileSync/

  const weak = bodies.filter(t => exitOnly.test(t.body) && !claimsMore.test(t.body))
  assert.deepEqual(weak.map(t => `${t.file}: ${t.name}`), [])
})

test('no test asserts only that something is absent', () => {
  // "the output does not contain X" is satisfied by output that was never produced — the run
  // may have died before reaching the thing being denied. Pair it with a positive assertion
  // proving the run got that far.
  // Narrow on purpose. `assert.notEqual(a, b)` on a returned value is a real comparison —
  // the vacuous shape is denying that some *output* contains something, since output that
  // was never produced denies everything.
  const negative = /assert\.doesNotMatch\s*\(|assert\.ok\(\s*!/g
  const positive = /assert\.(match|equal|deepEqual|strictEqual|throws|rejects|fail|ok)\b/

  const weak = bodies.filter(t =>
    negative.test(t.body) && !positive.test(t.body.replace(negative, '')))
  assert.deepEqual(weak.map(t => `${t.file}: ${t.name}`), [])
})
