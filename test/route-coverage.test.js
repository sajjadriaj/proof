import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coverage } from '../src/changed.js'

const covered = (checks, file) => coverage(checks, [file])[0].checks

test('the regression: a check requesting a route covers the file that serves it', () => {
  // Every app-router file is called route.ts, so the filename identifies nothing. In a Next
  // project that meant every route file read as "no check names this file" — forever, and
  // with the contract already asserting exactly that route.
  // The check's name deliberately shares no word with the file's path: only the URL it
  // requests can connect them, so this fails if the route rule stops working. Naming it
  // `get /api/users` would have matched on the directory name instead.
  const checks = [{ name: 'signed-in listing', http: { method: 'GET', path: '/api/users', expect: { status: 200 } } }]

  assert.deepEqual(covered(checks, 'app/api/users/route.ts'), ['signed-in listing'])
})

test('a pages/api file is matched the same way', () => {
  const checks = [{ name: 'the old endpoint', http: { path: '/api/legacy' } }]
  assert.deepEqual(covered(checks, 'pages/api/legacy.ts'), ['the old endpoint'])
})

test('a different route does not count as coverage', () => {
  // The point of the warning is to be true when nothing covers the file.
  const checks = [{ name: 'get /api/orders', http: { path: '/api/orders' } }]
  assert.deepEqual(covered(checks, 'app/api/users/route.ts'), [])
})

test('an absolute url is matched by its path', () => {
  const checks = [{ name: 'paged listing', http: { url: 'http://localhost:3000/api/users?page=2' } }]
  assert.deepEqual(covered(checks, 'app/api/users/route.ts'), ['paged listing'])
})

test('a browser flow expecting the request covers it too', () => {
  const checks = [{
    name: 'paying with a saved card',
    browser: { flow: [{ click: 'Pay' }, { expect_request: { method: 'POST', path: '/api/checkout' } }] },
  }]
  assert.deepEqual(covered(checks, 'app/api/checkout/route.ts'), ['paying with a saved card'])
})

test('a browser visit covers the page it loads', () => {
  const checks = [{ name: 'the weekly summary', browser: { visit: '/api/reports' } }]
  assert.deepEqual(covered(checks, 'app/api/reports/route.ts'), ['the weekly summary'])
})

test('a file that is not a route still matches by name', () => {
  // The existing rule has to keep working — this adds a way to match, it does not replace one.
  const checks = [{ name: 'money rounds correctly', run: 'node --test src/lib/money.test.ts' }]
  assert.deepEqual(covered(checks, 'src/lib/money.ts'), ['money rounds correctly'])
})

test('a route file with nothing pointing at it is still reported', () => {
  const checks = [{ name: 'unit tests', run: 'npm test' }]
  assert.deepEqual(covered(checks, 'app/api/users/route.ts'), [])
})

test('a malformed url in a check does not break the scan', () => {
  const checks = [{ name: 'bad', http: { url: 'http://[bad' } }, { name: 'the listing', http: { path: '/api/users' } }]
  assert.deepEqual(covered(checks, 'app/api/users/route.ts'), ['the listing'])
})

test('the regression: an index file is identified by its directory', () => {
  // `index` was excluded from the stem outright, so src/lib/session/index.ts matched
  // nothing — not even a check that runs `node --test src/lib/session`.
  const checks = [{ name: 'session store keeps a login', run: 'node --test src/lib/session' }]
  assert.deepEqual(covered(checks, 'src/lib/session/index.ts'), ['session store keeps a login'])
})

test('the regression: a page file is not covered by any check mentioning "page"', () => {
  // The other direction of the same problem: `page.tsx` has stem "page", so one check
  // saying "the login page loads" covered every page file in the repo.
  const checks = [{ name: 'the login page loads', browser: { visit: '/login' } }]

  assert.deepEqual(covered(checks, 'app/dashboard/page.tsx'), [])
  assert.deepEqual(covered(checks, 'app/settings/page.tsx'), [])
})

test('a page file is covered by a check naming its directory', () => {
  const checks = [{ name: 'the dashboard renders', browser: { visit: '/dashboard' } }]
  assert.deepEqual(covered(checks, 'app/dashboard/page.tsx'), ['the dashboard renders'])
})

test('a dynamic directory is stepped over, not used as a name', () => {
  // `[id]` identifies nothing; the segment above it does.
  const checks = [{ name: 'orders load', run: 'node --test orders' }]
  assert.deepEqual(covered(checks, 'app/orders/[id]/page.tsx'), ['orders load'])
})

test('a file with no distinctive segment anywhere is reported uncovered', () => {
  // Better to say "nothing names this" than to match on `app` or `src`.
  const checks = [{ name: 'app works', run: 'npm test' }]
  assert.deepEqual(covered(checks, 'app/page.tsx'), [])
})

test('an ordinary filename is still used directly', () => {
  const checks = [{ name: 'money rounds correctly', run: 'node --test src/lib/money.test.ts' }]
  assert.deepEqual(covered(checks, 'src/lib/money.ts'), ['money rounds correctly'])
})

test('the rule earns its keep where the path has no distinctive segment', async () => {
  // Every other fixture here is matched by the name rule too: a check requesting
  // `/api/users` contains the token `users`, which is also the file's distinctive segment.
  // These are the cases where nothing but the route mapping can connect the two — short or
  // generic directories that make no usable stem.
  assert.deepEqual(covered([{ name: 'listing', http: { path: '/api/v2' } }], 'app/api/v2/route.ts'), ['listing'])
  assert.deepEqual(covered([{ name: 'listing', http: { path: '/api' } }], 'app/api/route.ts'), ['listing'])
})

test('and through an absolute url in the same situation', () => {
  assert.deepEqual(
    covered([{ name: 'listing', http: { url: 'http://x.test/api/v2' } }], 'app/api/v2/route.ts'),
    ['listing'],
  )
})

test('a short directory with a different route is still uncovered', () => {
  // The rule must connect the right pair, not any pair the name rule cannot judge.
  assert.deepEqual(covered([{ name: 'listing', http: { path: '/api/v3' } }], 'app/api/v2/route.ts'), [])
})
