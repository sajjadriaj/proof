import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openApiRoutes, apiSpecsIn, findGaps } from '../src/infer.js'

const project = files => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-openapi-'))
  process.chdir(dir)
  for (const [path, body] of Object.entries(files)) {
    if (path.includes('/')) mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}

const SPEC = `openapi: 3.0.0
info: {title: orders, version: "1"}
paths:
  /orders:
    get:
      summary: list orders
    post:
      summary: create an order
  /orders/{orderId}:
    parameters:
      - name: orderId
        in: path
        required: true
        schema: {type: string, example: "ord_42"}
    get:
      summary: read one order
    delete:
      summary: cancel it
`

test('the regression: a language proof has no detector for still gets its routes', () => {
  // A Java, C#, Rust, PHP or Ruby repository had no route source at all — every gap list came
  // back empty, which reads as "nothing to verify" for an API that is fully described on disk.
  project({ 'openapi.yaml': SPEC, 'OrderController.java': 'class OrderController {}' })

  const gaps = findGaps(['OrderController.java'], [])
  const titles = gaps.map(g => g.title)

  assert.ok(titles.includes('GET /orders is reachable'), titles.join('\n'))
  assert.ok(titles.includes('POST /orders is reachable'), titles.join('\n'))
})

test('a declared example makes the generated check requestable', () => {
  // Without it the check holds `/orders/{orderId}` and `proof check` refuses to run the
  // contract at all — the generated check is worse than none.
  project({ 'openapi.yaml': SPEC })
  const routes = openApiRoutes('openapi.yaml')
  const one = routes.find(r => r.method === 'GET' && r.path.startsWith('/orders/'))

  assert.equal(one.path, '/orders/ord_42')
  const gap = findGaps(['openapi.yaml'], []).find(g => g.check?.http?.path === '/orders/ord_42')
  assert.equal(gap.note, null, 'a filled path is not a dynamic segment')
})

test('a parameter with no stated value stays dynamic rather than being invented', () => {
  // `type: integer` does not mean `1` exists. A generated check that 404s costs an iteration.
  project({
    'openapi.yaml': `openapi: 3.0.0
paths:
  /users/{id}:
    parameters: [{name: id, in: path, schema: {type: integer}}]
    get: {summary: read}
`,
  })
  const [route] = openApiRoutes('openapi.yaml')

  assert.equal(route.path, '/users/{id}')
  const [gap] = findGaps(['openapi.yaml'], [])
  assert.match(gap.note, /dynamic segment/)
})

test('every method the document declares is its own gap, and nothing else is', () => {
  project({ 'openapi.yaml': SPEC })
  const routes = openApiRoutes('openapi.yaml')

  assert.deepEqual(routes.map(r => `${r.method} ${r.path}`).sort(), [
    'DELETE /orders/ord_42',
    'GET /orders',
    'GET /orders/ord_42',
    'POST /orders',
  ])
  // `parameters` and `summary` are not HTTP methods.
  assert.ok(!routes.some(r => r.method === 'PARAMETERS'), 'a non-method key was read as one')
})

test('each route points at the line its path is declared on', () => {
  // The house rule: a gap that cannot be located is a gap that should not be reported.
  project({ 'openapi.yaml': SPEC })
  const at = openApiRoutes('openapi.yaml').find(r => r.path === '/orders').at

  assert.match(at, /^openapi\.yaml:4$/, at)
})

test('a swagger 2 basePath is applied without comment; a servers URL is applied with one', () => {
  project({
    'swagger.json': JSON.stringify({ swagger: '2.0', basePath: '/v1', paths: { '/ping': { get: {} } } }),
  })
  const [relative] = openApiRoutes('swagger.json')
  assert.equal(relative.path, '/v1/ping')
  assert.equal(relative.prefixed, undefined, 'an explicit basePath is unambiguous')

  project({
    'openapi.yaml': 'openapi: 3.0.0\nservers: [{url: "https://api.example.com/v2"}]\npaths:\n  /ping:\n    get: {}\n',
  })
  const [absolute] = openApiRoutes('openapi.yaml')
  assert.equal(absolute.path, '/v2/ping')
  // A deployment URL is not necessarily the dev server proof starts.
  assert.equal(absolute.prefixed, '/v2')
  assert.match(findGaps(['openapi.yaml'], [])[0].note, /describes a deployment/)
})

test('a file that is not an API description yields nothing', () => {
  // `paths` alone is not distinctive — a build config has one, and routes read out of one are
  // a gap list nobody can act on.
  project({ 'openapi.yaml': 'paths:\n  /src:\n    get: {}\n' })
  assert.deepEqual(openApiRoutes('openapi.yaml'), [])

  project({ 'openapi.yaml': 'this: [is, not, ya:ml\n' })
  assert.deepEqual(openApiRoutes('openapi.yaml'), [])
})

test('where proof can read the code, the code is the source', () => {
  // Pulling in every path of a large document because one unrelated file moved is the kind of
  // list people learn to skip.
  project({ 'openapi.yaml': SPEC, 'src/app.ts': 'app.get("/health", h)' })

  assert.deepEqual(apiSpecsIn(['src/app.ts']), [])
  assert.deepEqual(apiSpecsIn(['OrderController.java']), ['openapi.yaml'])
  // In the diff means the declared surface itself changed, whatever else moved with it.
  assert.deepEqual(apiSpecsIn(['src/app.ts', 'openapi.yaml']), ['openapi.yaml'])
})

test('a route both the code and the document declare is one gap, not two', () => {
  project({
    'openapi.yaml': 'openapi: 3.0.0\npaths:\n  /health:\n    get: {}\n',
    'app.py': '@app.get("/health")\ndef health(): pass\n',
  })
  // The document is in the diff, so both sources are read.
  const gaps = findGaps(['app.py', 'openapi.yaml'], [])
  const health = gaps.filter(g => g.title === 'GET /health is reachable')

  assert.equal(health.length, 1, JSON.stringify(gaps.map(g => g.title)))
})

test('a route the contract already asserts is not offered again', () => {
  project({ 'openapi.yaml': SPEC })
  const gaps = findGaps(['openapi.yaml'], [{ name: 'list', http: { path: '/orders', expect: { status: 200 } } }])

  assert.ok(!gaps.some(g => g.title === 'GET /orders is reachable'), 'an asserted route came back as a gap')
  assert.ok(gaps.some(g => g.title === 'POST /orders is reachable'), 'method is part of the comparison')
})

test('a conventional subdirectory is found too', () => {
  project({ 'docs/openapi.yaml': SPEC })
  assert.deepEqual(apiSpecsIn(['Program.cs']), ['docs/openapi.yaml'])
})
