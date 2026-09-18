import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { validateSpec } from '../src/validate.js'
import { captureValue, substitute, referencedVars, selectorProblem } from '../src/vars.js'

// The most ordinary thing there is to say about an API — POST returns an id, then GET that id
// — could not be written at all. Every path had to be a literal, so contracts hardcoded a row
// someone had seen in their own database once.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const runCli = (dir, args) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { cwd: dir }, (err, stdout, stderr) =>
    resolve({ code: err?.code ?? 0, out: stdout + stderr }))
})

// --- the pieces --------------------------------------------------------------

test('a dotted path reads a value out of a JSON body', () => {
  const source = { body: JSON.stringify({ id: 17, user: { email: 'ada@example.com' }, items: [{ sku: 'A' }] }) }
  assert.deepEqual(captureValue('json.id', source), { value: 17 })
  assert.deepEqual(captureValue('json.user.email', source), { value: 'ada@example.com' })
  assert.deepEqual(captureValue('json.items[0].sku', source), { value: 'A' })
})

test('a path that reaches nothing is an error, never an empty value', () => {
  // A variable that silently becomes "" builds a request to `/orders/` and reports whatever
  // that returns — a check passing against a route the contract never named.
  const source = { body: JSON.stringify({ id: 1 }) }
  assert.match(captureValue('json.missing', source).error, /not in the response/)
  assert.match(captureValue('json.id.deeper', source).error, /not in the response/)
  assert.match(captureValue('json.x', { body: 'not json' }).error, /not JSON/)
})

test('an object is refused rather than stringified into a URL', () => {
  const source = { body: JSON.stringify({ user: { id: 1 } }) }
  assert.match(captureValue('json.user', source).error, /an object, not a value a URL/)
})

test('headers, status, output and a regex group', () => {
  const headers = new Map([['location', '/orders/9']])
  assert.deepEqual(captureValue('header.location', { headers }), { value: '/orders/9' })
  assert.match(captureValue('header.etag', { headers }).error, /no `etag` header/)
  assert.deepEqual(captureValue('status', { status: 201 }), { value: 201 })
  assert.deepEqual(captureValue('output', { output: '  abc\n' }), { value: 'abc' })
  assert.deepEqual(captureValue('match:token=(\\w+)', { output: 'token=xyz9' }), { value: 'xyz9' })
  assert.match(captureValue('match:nope=(\\w+)', { output: 'x' }).error, /matched nothing/)
})

test('a selector with no capturing group is refused at load', () => {
  assert.match(selectorProblem('match:token'), /needs a capturing group/)
  assert.equal(selectorProblem('match:(?:a)(b)'), null)     // non-capturing groups do not count
  assert.match(selectorProblem('match:(['), /invalid regex/)
  assert.match(selectorProblem('jsonn.id'), /unknown selector/)
  assert.match(selectorProblem('json.'), /needs a path/)
})

test('a lone reference keeps its type, an embedded one is stringified', () => {
  // `json: {id: "${id}"}` against a numeric id has to compare as a number, or every captured
  // id would have to be asserted as a string it is not.
  const vars = new Map([['id', 17]])
  assert.deepEqual(substitute({ a: '${id}', b: '/orders/${id}' }, vars).filled, { a: 17, b: '/orders/17' })
  assert.deepEqual(substitute('${nope}', new Map()).missing, ['nope'])
  assert.deepEqual([...referencedVars({ http: { path: '/a/${x}/${y}' } })], ['x', 'y'])
})

// --- validation --------------------------------------------------------------

const spec = checks => ({ goal: 'g', serve: { run: 'x', ready_url: 'http://localhost:3000' }, checks })

test('a reference no check captures is a contract error, not a run-time failure', () => {
  const problems = validateSpec(spec([{ name: 'a', http: { path: '/orders/${order_id}' } }]))
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /uses \$\{order_id\}, which no check captures/)
})

test('a reference to a value captured later names the ordering problem', () => {
  const problems = validateSpec(spec([
    { name: 'read', http: { path: '/orders/${id}' } },
    { name: 'create', http: { method: 'POST', path: '/orders' }, capture: { id: 'json.id' } },
  ]))
  assert.equal(problems.length, 1, JSON.stringify(problems))
  assert.match(problems[0], /which check\[1\] captures .* Move this check after that one/s)
})

test('a contract that captures before it uses validates clean', () => {
  assert.deepEqual(validateSpec(spec([
    { name: 'create', http: { method: 'POST', path: '/orders' }, capture: { id: 'json.id' } },
    { name: 'read', http: { path: '/orders/${id}' } },
  ])), [])
})

test('a route pattern is still refused, and a variable is not mistaken for one', () => {
  const patterned = validateSpec(spec([{ name: 'a', http: { path: '/orders/:id' } }]))
  assert.equal(patterned.length, 1)
  assert.match(patterned[0], /still has the route pattern/)
})

test('capture is refused where there is nothing to capture from', () => {
  const problems = validateSpec(spec([{ name: 'a', browser: { visit: '/x' }, capture: { id: 'json.id' } }]))
  assert.match(problems[0], /a `browser` check has no response to capture from/)

  const runHeader = validateSpec(spec([{ name: 'a', run: 'true', capture: { id: 'header.location' } }]))
  assert.match(runHeader[0], /reads a response, and a `run` check has none/)
})

test('a name that could not be written as ${name} is refused', () => {
  const problems = validateSpec(spec([{ name: 'a', run: 'true', capture: { '9lives': 'output' } }]))
  assert.match(problems[0], /not a usable variable name/)
})

test('a shell command keeps the expansions proof did not capture', () => {
  // `${HOME}` is the shell's syntax before it is proof's. Rejecting it would refuse an
  // ordinary command for using the language it is written in.
  assert.deepEqual(validateSpec(spec([{ name: 'a', run: 'echo "$HOME/${OUT_DIR}/x"' }])), [])

  // and everywhere else a reference has no other meaning, so it is still checked
  const elsewhere = validateSpec(spec([{ name: 'a', run: 'true', expect_output: '${nope}' }]))
  assert.match(elsewhere[0], /uses \$\{nope\}, which no check captures/)
})

test('a captured name is substituted into a run command, an unknown one is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-capture-shell-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), `goal: g
checks:
  - name: produce
    run: echo 4242
    capture: {token: output}
  - name: consume
    run: test "\${token}" = "4242" && test -n "\${HOME}"
`)
  const { code, out } = await runCli(dir, ['check'])
  assert.equal(code, 0, out)
})

// --- end to end --------------------------------------------------------------

const app = () => new Promise(resolve => {
  const orders = new Map()
  let next = 100
  const server = http.createServer((q, s) => {
    const id = q.url.match(/^\/orders\/(\d+)$/)?.[1]
    if (q.method === 'POST' && q.url === '/orders') {
      const made = next++
      orders.set(String(made), { id: made, sku: 'ABC-1' })
      s.writeHead(201, { 'content-type': 'application/json', location: `/orders/${made}` })
      return s.end(JSON.stringify({ id: made, sku: 'ABC-1' }))
    }
    if (id && orders.has(id)) {
      s.writeHead(200, { 'content-type': 'application/json' })
      return s.end(JSON.stringify(orders.get(id)))
    }
    s.writeHead(404); s.end('no such order')
  })
  server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise(r => server.close(r)) }))
})

test('an id created by one check is read back by the next', async () => {
  const { port, close } = await app()
  const dir = mkdtempSync(join(tmpdir(), 'proof-capture-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), `goal: an order round-trips
serve:
  run: "true"
  url: http://127.0.0.1:${port}
  reuse_existing: true
  ready_url: http://127.0.0.1:${port}/orders/nope
checks:
  - name: an order is created
    http:
      method: POST
      path: /orders
      body: {sku: ABC-1}
      expect: {status: 201}
    capture:
      order_id: json.id
      where: header.location
  - name: the order is readable at the id it was given
    http:
      path: /orders/\${order_id}
      expect: {status: 200, json: {id: "\${order_id}", sku: ABC-1}}
  - name: and at the location it reported
    http:
      url: http://127.0.0.1:${port}\${where}
      expect: {status: 200}
`)

  try {
    const { code, out } = await runCli(dir, ['check'])
    assert.equal(code, 0, out)
    assert.match(out, /VERDICT\n {2}DONE/)

    // The substituted value is what the evidence records, so a run can be read back.
    const record = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
    const read = record.results.find(r => r.name.startsWith('the order is readable'))
    assert.match(read.asserted, /GET \/orders\/\d+/)
    // Names only — a captured value is as likely to be a token as an id.
    const created = record.results.find(r => r.name === 'an order is created')
    assert.deepEqual(created.captured, ['order_id', 'where'])
  } finally { await close() }
})

test('a capture the response cannot satisfy fails the check that promised it', async () => {
  const { port, close } = await app()
  const dir = mkdtempSync(join(tmpdir(), 'proof-capture-miss-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), `goal: g
checks:
  - name: create
    http:
      url: http://127.0.0.1:${port}/orders
      method: POST
      expect: {status: 201}
    capture: {token: json.token}
  - name: use it
    http: {url: "http://127.0.0.1:${port}/orders/\${token}"}
`)

  try {
    const { code, out } = await runCli(dir, ['check'])
    assert.equal(code, 1)
    assert.match(out, /nothing to capture for \$\{token\} — token is not in the response/)
    // And the check that depended on it says why, rather than failing as a bad request.
    assert.match(out, /no value for \$\{token\}.*captured by "create", which did not run or did not pass/s)
  } finally { await close() }
})
