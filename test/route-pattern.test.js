import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSpec } from '../src/validate.js'

const SERVE = { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true }
const check = http => validateSpec({ goal: 'g', serve: SERVE, checks: [{ name: 'c', http }] }).join('\n')

test('the regression: a generated path still holding its route pattern is a contract error', () => {
  // `infer` prints "dynamic segment — replace with a real value" once, in a terminal, and
  // writes `path: /api/orders/[id]` into the contract anyway. Without this the next
  // `proof check` requests that path literally and fails with nothing to say it was a
  // placeholder proof wrote.
  const out = check({ path: '/api/orders/[id]' })

  assert.match(out, /still has the route pattern in it/)
  assert.match(out, /\[id\]/, 'the segment is named')
  assert.match(out, /replace it with a real value/)
})

test('every pattern style proof can generate is caught', () => {
  for (const path of ['/api/users/:id', '/api/x/{id}', '/api/a/[slug]/b']) {
    assert.match(check({ path }), /still has the route pattern/, `${path} was accepted`)
  }
})

test('an absolute url is checked by its path, not its origin', () => {
  assert.match(check({ url: 'http://localhost:3000/api/orders/[id]' }), /still has the route pattern/)
})

test('a real value is accepted', () => {
  assert.equal(check({ path: '/api/orders/42' }), '')
  assert.equal(check({ url: 'http://localhost:3000/api/orders/42' }), '')
})

test('a colon in a query string is not a route pattern', () => {
  // The rule must not fire on ordinary URLs, or it becomes noise people learn to ignore.
  assert.equal(check({ path: '/api/search?after=12:30' }), '')
})

test('a port is not a route pattern', () => {
  assert.equal(check({ url: 'http://localhost:3000/api/health' }), '')
})

test('a bracket inside a segment is left alone', () => {
  // Only a whole segment that starts with the marker is a pattern.
  assert.equal(check({ path: '/api/a-[b]-c' }), '')
})

test('the message says who wrote it', () => {
  // These paths arrive from `infer --write`, not from someone typing them, so the message
  // should point at that rather than imply a typo.
  assert.match(check({ path: '/api/orders/[id]' }), /`proof infer` writes these from route definitions/)
})
