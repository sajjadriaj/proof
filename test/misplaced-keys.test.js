import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSpec } from '../src/validate.js'

const SERVE = { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true }
const problems = check => validateSpec({ goal: 'g', serve: SERVE, checks: [{ name: 'c', ...check }] }).join('\n')

test('the regression: a key written at the wrong level is told where it belongs', () => {
  // Edit distance answered this badly: `expect` on the check suggested `expect_exit`, a
  // different assertion — so following the advice produced a contract that was valid and
  // wrong. Nesting is the likeliest mistake in this language.
  const out = problems({ http: { path: '/a' }, expect: { status: 200 } })

  assert.match(out, /unknown key "expect" — that key belongs under `http`/)
  assert.doesNotMatch(out, /did you mean "expect_exit"/)
})

test('a key one level too shallow is placed too', () => {
  assert.match(problems({ http: { path: '/a', status: 200 } }), /"status" — that key belongs under `http › expect`/)
  assert.match(problems({ http: { path: '/a' }, body_contains: 'x' }), /"body_contains" — that key belongs under `http › expect`/)
})

test('a key with several homes names them all', () => {
  // `status` is valid under both `http.expect` and `step.expect_request`; picking one would
  // be a guess about which the author meant.
  assert.match(problems({ http: { path: '/a', status: 200 } }), /`http › expect` or `expect_request` in a flow step/)
})

test('an ordinary misspelling still gets the nearest key', () => {
  // The placement rule must not swallow the case it sits beside.
  assert.match(problems({ http: { path: '/a' }, timeut: 5 }), /did you mean "timeout"\?/)
  assert.match(problems({ http: { pth: '/a' } }), /did you mean "path"\?/)
})

test('a key that is nowhere gets no invented advice', () => {
  const out = problems({ http: { path: '/a' }, frobnicate: 1 })

  assert.match(out, /unknown key "frobnicate"$/m)
  assert.doesNotMatch(out, /belongs under/)
  assert.doesNotMatch(out, /did you mean/)
})

test('the home is named as the reader writes it, not as an internal path', () => {
  // `check.http.expect` is proof's schema path; the contract says `http: {expect: ...}`.
  const out = problems({ http: { path: '/a' }, body_contains: 'x' })

  assert.doesNotMatch(out, /check\./, 'no internal prefix')
  assert.match(out, /`http › expect`/)
})

test('a top-level key written on a check says so plainly', () => {
  const out = validateSpec({ goal: 'g', checks: [{ name: 'c', run: 'true', goal: 'oops' }] }).join('\n')
  assert.match(out, /unknown key "goal" — that key belongs under the top level/)
})

test('a place is named as the contract writes it, never as proof names it internally', () => {
  // `step` is proof's word for an entry in a browser flow. A reader looking for where to put
  // `click` needs `browser › flow` — a label that appears nowhere in their file is no help.
  const out = problems({ click: 'Go' })

  assert.match(out, /belongs under a step in `browser › flow`/)
  assert.doesNotMatch(out, /under `step`/)
})

test('every schema path has a reader-facing name', async () => {
  // Otherwise a new nesting level ships with an internal label in the error message.
  const { validateSpec: v } = await import('../src/validate.js')
  const source = (await import('node:fs')).readFileSync(new URL('../src/validate.js', import.meta.url), 'utf8')

  const allowed = [...source.matchAll(/^\s*'?([\w.]*)'?:\s*\[/gm)].map(m => m[1])
  const places = [...source.matchAll(/^\s*'?([\w.]*)'?:\s*(?:'|`)/gm)].map(m => m[1])

  for (const path of allowed) {
    assert.ok(places.includes(path), `schema path "${path}" has no entry in PLACE`)
  }
  assert.ok(typeof v === 'function')
})
