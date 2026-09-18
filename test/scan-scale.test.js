import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripComments } from '../src/changed.js'

// The import scan reads every file in the repository, so one generated or bundled file used
// to be enough to stall it: deciding whether a `/` opened a regex re-read everything emitted
// so far, which is quadratic twice over — the copy itself, and flattening the rope that
// building the output produces. 1.3 MB took 25 seconds.

const source = lines => 'const a = x / y;\n'.repeat(lines)

test('stripComments scales linearly with file size', () => {
  const time = src => { const t = Date.now(); stripComments(src); return Date.now() - t }

  time(source(2000))                       // warm up, so JIT is not measured as growth
  const small = Math.max(1, time(source(20_000)))
  const large = Math.max(1, time(source(160_000)))

  // Eight times the input. Linear is ~8x; the old scan was ~64x and took half a minute.
  assert.ok(large < small * 24, `8x the input took ${large}ms vs ${small}ms — the scan is not linear`)
  assert.ok(large < 10_000, `a 2.7 MB file took ${large}ms`)
})

/** What stripping should produce: the comment blanked, every other byte where it was. */
const blanked = (code, comment) => code + ' '.repeat(comment.length)

test('and still strips exactly what it stripped before', () => {
  // A regex containing a quote is the case the lookbehind exists for: mistaking it for a
  // string put the scanner into string mode and stopped stripping comments from there on.
  for (const code of ["const re = /['\"]/ ", 'return /a\\/b/.test(s) ', 'let y = a / b ']) {
    const comment = '// gone'
    assert.equal(stripComments(code + comment), blanked(code, comment))
  }
  assert.equal(stripComments('/* gone */ const z = 1'), `${' '.repeat(10)} const z = 1`)

  // Positions survive, which is what `infer` reports gaps by.
  const src = "// comment\napp.get('/api/x', h)\n"
  assert.equal(stripComments(src).indexOf('app.get'), src.indexOf('app.get'))
})

test('a blanked comment does not hide the code in front of it from the lookbehind', () => {
  // The window is kept right-trimmed, so a long comment between a token and a `/` cannot
  // make the scanner read the division as the start of a regex — which would swallow the
  // rest of the line into a literal.
  const comment = `/*${'.'.repeat(500)}*/`
  assert.equal(stripComments(`let y = a ${comment} / b`), `let y = a ${' '.repeat(comment.length)} / b`)
})
