import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSpec } from '../src/validate.js'
import { assertedRoutes } from '../src/infer.js'

const SERVE = { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true }
const problems = spec => validateSpec({ goal: 'g', ...spec }).join('\n')

// Strings that pass a prefix test but are not URLs anything can request.
const UNPARSEABLE = ['http://[bad', 'http://', 'https://exa mple.com/x', 'http://localhost:99999/x']

test('the regression: an absolute url that cannot be parsed is a contract error', () => {
  // ABSOLUTE.test only checks the prefix, so these reached the runner and failed there —
  // a contract mistake reported as a code failure, with exit 1 instead of 2.
  for (const url of UNPARSEABLE) {
    const out = problems({ checks: [{ name: 'c', http: { url, expect: { status: 200 } } }] })
    assert.match(out, /is not a URL that can be requested/, `"${url}" was accepted`)
  }
})

test('real URLs are untouched', () => {
  for (const url of [
    'http://localhost:3000/a/b?c=1#d',
    'https://api.example.com/v2/users',
    'http://127.0.0.1:8080',
    'https://user:pass@example.com/x',
  ]) {
    assert.equal(problems({ checks: [{ name: 'c', http: { url } }] }), '', `"${url}" was rejected`)
  }
})

test('a relative path is still handled by the rule that exists for it', () => {
  // mustParse must not swallow the "use `path` for a relative one" advice.
  const out = problems({ checks: [{ name: 'c', http: { url: '/api/users' } }] })
  assert.match(out, /must be absolute/)
  assert.doesNotMatch(out, /is not a URL that can be requested/, 'one problem, not two')
})

test('serve.ready_url and browser.base_url are checked the same way', () => {
  assert.match(
    problems({ serve: { run: 'x', ready_url: 'http://[bad' }, checks: [{ name: 'c', run: 'true' }] }),
    /serve › ready_url: .* is not a URL/,
  )
  assert.match(
    problems({ serve: SERVE, checks: [{ name: 'c', browser: { base_url: 'http://[bad', visit: '/' } }] }),
    /browser › base_url: .* is not a URL/,
  )
})

test('the consequence in infer: a covered route is no longer re-suggested', () => {
  // assertedRoutes silently skipped a check whose url would not parse, so infer offered a
  // gap for a route the contract already had. With the contract rejected up front, the
  // routes it does accept are all counted.
  const routes = assertedRoutes([
    { http: { url: 'http://localhost:3000/api/users', method: 'POST' } },
    { http: { path: '/api/health' } },
  ])

  assert.deepEqual(routes, [
    { method: 'POST', path: '/api/users' },
    { method: 'GET', path: '/api/health' },
  ])
})
