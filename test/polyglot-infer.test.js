import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routesIn, envRefsIn, stripPy, isDynamicPath } from '../src/infer.js'
import { isTestFile } from '../src/diff.js'
import { validateSpec } from '../src/validate.js'

/**
 * "Proof cannot look here" was the answer for the two ecosystems `init` already scaffolds
 * serve commands for. Routes and env reads are the same shape in any language; only the
 * import graph stays JS-only, and `changed` still says so.
 */
const withFile = (name, body) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-polyglot-'))
  writeFileSync(join(dir, name), body)
  process.chdir(dir)
  return name
}

test('a Flask route declares its methods, and defaults to GET without them', () => {
  const f = withFile('app.py',
    'import os\nfrom flask import Flask\napp = Flask(__name__)\n\n'
    + '@app.route("/api/checkout", methods=["POST", "PUT"])\ndef checkout(): pass\n\n'
    + '@app.route("/health")\ndef health(): pass\n')

  const routes = routesIn(f)
  assert.deepEqual(routes.map(r => `${r.method} ${r.path}`).sort(),
    ['GET /health', 'POST /api/checkout', 'PUT /api/checkout'])
  assert.equal(routes[0].at, 'app.py:5', 'located at the decorator, not the function')
})

test('the FastAPI / Flask 2 shorthand is a route with its method', () => {
  const f = withFile('api.py',
    'from fastapi import APIRouter\nrouter = APIRouter()\n\n'
    + '@router.post("/api/orders")\nasync def create(): pass\n'
    + '@router.get("/api/orders/{id}")\nasync def get_one(): pass\n')

  const routes = routesIn(f)
  assert.deepEqual(routes.map(r => `${r.method} ${r.path}`),
    ['POST /api/orders', 'GET /api/orders/{id}'])
})

test('a route in a python comment or docstring is not a route', () => {
  // the shorthand form on purpose: the JS ROUTE_CALL regex also matches `app.get(...)`, so
  // a commented `@app.get` distinguishes the python path (which strips #) from a fallback
  // to the JS scanner (which does not)
  const f = withFile('app.py',
    '# @app.get("/commented")\n'
    + 'DOC = """\n@app.get("/in-a-string")\n"""\n'
    + '@app.get("/real")\ndef real(): pass\n')

  assert.deepEqual(routesIn(f).map(r => r.path), ['/real'])
})

test('stripPy preserves byte positions and strings containing #', () => {
  const src = 'color = "#fff"  # a comment\nx = 1\n'
  const out = stripPy(src)

  assert.equal(out.length, src.length, 'lineOf depends on positions surviving')
  assert.match(out, /#fff/, 'the # inside a string is content, not a comment')
  assert.doesNotMatch(out, /a comment/)
})

test('python env reads are found in all three spellings', () => {
  const f = withFile('settings.py',
    'import os\n'
    + 'KEY = os.environ["STRIPE_KEY"]\n'
    + 'DSN = os.environ.get("DATABASE_URL")\n'
    + 'TOK = os.getenv("API_TOKEN")\n')

  assert.deepEqual(envRefsIn(f).map(e => e.name), ['STRIPE_KEY', 'DATABASE_URL', 'API_TOKEN'])
  assert.equal(envRefsIn(f)[0].at, 'settings.py:2')
})

test('go: net/http, a Go 1.22 method pattern, and chi/gin receivers', () => {
  const f = withFile('main.go',
    'package main\n\nimport ("net/http"; "os")\n\nfunc main() {\n'
    + '\thttp.HandleFunc("/health", h)\n'
    + '\thttp.HandleFunc("POST /api/orders", create)\n'
    + '\tr.Get("/api/users", list)\n'
    + '\tg.DELETE("/api/users/:id", remove)\n'
    + '}\n')

  const routes = routesIn(f)
  assert.deepEqual(routes.map(r => `${r.method} ${r.path}`),
    ['GET /health', 'POST /api/orders', 'GET /api/users', 'DELETE /api/users/:id'])
})

test('go env reads are found, and commented ones are not', () => {
  const f = withFile('config.go',
    'package main\n\nimport "os"\n\n'
    + '// key := os.Getenv("COMMENTED_OUT")\n'
    + 'var key = os.Getenv("STRIPE_KEY")\n'
    + 'var dsn, ok = os.LookupEnv("DATABASE_URL")\n')

  assert.deepEqual(envRefsIn(f).map(e => e.name), ['STRIPE_KEY', 'DATABASE_URL'])
})

test("Flask's <id> counts as dynamic, and the validator refuses it unreplaced", () => {
  // a generated check for /users/<int:id> would request that path literally
  assert.equal(isDynamicPath('/users/<int:id>'), true)

  const problems = validateSpec({
    goal: 'g',
    serve: { run: 'x', ready_url: 'http://localhost:1' },
    checks: [{ name: 'u', http: { path: '/users/<int:id>' } }],
  })
  assert.ok(problems.some(p => /still has the route pattern/.test(p)), problems.join('\n'))
})

test('python and go test files are verification, not gaps', () => {
  assert.equal(isTestFile('test_checkout.py'), true)
  assert.equal(isTestFile('app/test_views.py'), true)
  assert.equal(isTestFile('conftest.py'), true)
  assert.equal(isTestFile('handlers_test.go'), true)

  assert.equal(isTestFile('app.py'), false)
  assert.equal(isTestFile('contest.py'), false, 'conftest, not any file ending in test.py')
  assert.equal(isTestFile('main.go'), false)
})

test('an http client call is not a route in either language', () => {
  // requests.get / http.Get fetch things; only paths on a decorator or handler registration count
  const py = withFile('client.py', 'import requests\nrequests.get("https://api.example.com/v1")\n')
  assert.deepEqual(routesIn(py), [])

  const go = withFile('client.go', 'package main\nimport "net/http"\nvar r, _ = http.Get("https://api.example.com/v1")\n')
  assert.deepEqual(routesIn(go), [], 'http.Get with an absolute URL is a client, not a handler')
})
