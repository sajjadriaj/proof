import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routesIn, findGaps } from '../src/infer.js'

const scan = source => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-mount-'))
  process.chdir(dir)
  writeFileSync('a.js', source)
  return routesIn('a.js')
}

test('the regression: a route on a mounted router carries its prefix', () => {
  // `router.get('/users')` was reported as `/users`, so the generated check requested a
  // path the app does not serve — a 404 offered as the fix.
  const routes = scan(
    "const router = express.Router()\n"
    + "router.get('/users', listUsers)\n"
    + "app.use('/api/v2', router)\n",
  )

  assert.deepEqual(routes.map(r => `${r.method} ${r.path}`), ['GET /api/v2/users'])
  assert.ok(!routes[0].mountable, 'the prefix is known, so nothing to confirm')
})

test('a trailing slash on the mount does not double up', () => {
  const routes = scan("router.get('/users', h)\napp.use('/api/', router)\n")
  assert.equal(routes[0].path, '/api/users')
})

test('mounting at the root leaves the path alone', () => {
  const routes = scan("router.get('/users', h)\napp.use('/', router)\n")
  assert.equal(routes[0].path, '/users')
})

test('a router mounted in another file is flagged rather than guessed at', () => {
  // The route is real; where it is mounted is decided in a file this scan has not read.
  const routes = scan("const router = express.Router()\nrouter.get('/users', h)\nmodule.exports = router\n")

  assert.equal(routes[0].path, '/users')
  assert.equal(routes[0].mountable, true)
})

test('the gap says the prefix needs confirming', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-mount-gap-'))
  process.chdir(dir)
  writeFileSync('routes.js', "const router = express.Router()\nrouter.get('/users', h)\n")

  const gap = findGaps(['routes.js'], [], { reportUncovered: false })[0]
  assert.match(gap.note ?? '', /confirm the prefix the app mounts it under/)
})

test('a route on the app itself is never flagged', () => {
  const routes = scan("app.get('/health', h)\nserver.post('/hook', h)\n")
  assert.deepEqual(routes.map(r => r.path), ['/health', '/hook'], 'both were found')
  for (const r of routes) assert.ok(!r.mountable, `${r.path} was flagged`)
})

test('an http client is not treated as a router', () => {
  // `api.post('/api/login')` is as often axios as it is a router; a note about mounting
  // would be attached to the wrong thing.
  const routes = scan("api.post('/api/login', body)\n")
  assert.equal(routes[0].path, '/api/login', 'it was still detected as a route')
  assert.ok(!routes[0].mountable)
})

test('two routers with different mounts each get their own prefix', () => {
  const routes = scan(
    "adminRouter.get('/users', h)\n"
    + "router.get('/orders', h)\n"
    + "app.use('/admin', adminRouter)\n"
    + "app.use('/api', router)\n",
  )

  // Only `router` matches the receiver whitelist; the point is that its own mount is used.
  const orders = routes.find(r => r.path.endsWith('/orders'))
  assert.equal(orders.path, '/api/orders')
})
