import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { jsonMismatch } from '../src/json-match.js'
import { validateSpec } from '../src/validate.js'
import { check } from '../src/check.js'

const matches = (expected, actual) => assert.equal(jsonMismatch(expected, actual), null)
const mismatch = (expected, actual) => jsonMismatch(expected, actual)

test('extra keys in the response are allowed; named keys must match', () => {
  matches({ ok: true }, { ok: true, requestId: 'abc', extra: { deep: 1 } })

  const p = mismatch({ ok: true }, { ok: false })
  assert.deepEqual(p, { path: '$.ok', expected: 'true', observed: 'false' })
})

test('a missing key is reported by path, not as a generic failure', () => {
  assert.deepEqual(mismatch({ user: { email: 'a@b.c' } }, { user: {} }), {
    path: '$.user.email',
    expected: '"a@b.c"',
    observed: 'missing',
  })
})

test('type tokens assert shape where values are generated', () => {
  matches(
    { id: '<number>', token: '<string>', active: '<boolean>', tags: '<array>', meta: '<object>', deleted: '<null>' },
    { id: 7, token: 'x', active: false, tags: [], meta: {}, deleted: null },
  )

  assert.deepEqual(mismatch({ id: '<number>' }, { id: '7' }), {
    path: '$.id',
    expected: '<number>',
    observed: '"7"',
  })
  assert.deepEqual(mismatch({ id: '<any>' }, {}), { path: '$.id', expected: '"<any>"', observed: 'missing' })
})

test('arrays match element-wise and require at least the asserted length', () => {
  matches([{ id: '<number>' }], [{ id: 1 }, { id: 2 }, { id: 3 }])

  assert.deepEqual(mismatch([1, 2], [1]), { path: '$.length', expected: 'at least 2', observed: '1' })
  assert.deepEqual(mismatch({ items: '<array>' }, { items: {} }), {
    path: '$.items',
    expected: '<array>',
    observed: '{}',
  })
  assert.deepEqual(mismatch([{ a: 1 }], [{ a: 2 }]), { path: '$[0].a', expected: '1', observed: '2' })
})

test('type confusion between object, array and null is caught', () => {
  assert.deepEqual(mismatch({ a: 1 }, [1]), { path: '$', expected: 'an object', observed: '[1]' })
  assert.deepEqual(mismatch({ a: 1 }, null), { path: '$', expected: 'an object', observed: 'null' })
  assert.deepEqual(mismatch([1], { 0: 1 }), { path: '$', expected: 'an array', observed: '{"0":1}' })
})

test('a mistyped type token is a contract error, not a literal comparison', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [{ name: 'a', http: { url: 'http://x.test/', expect: { json: { user: { id: '<strig>' } } } } }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /unknown type token "<strig>" at \$\.user\.id — did you mean "<string>"\?/)
})

// --- through the CLI, against a live server ----------------------------------

const serveJson = (payload, contentType = 'application/json') => new Promise(resolve => {
  const s = createServer((_, res) => {
    res.writeHead(200, { 'content-type': contentType })
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const runAgainst = async (url, expect) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-json-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'schema',
    checks: [{ name: 'shape', http: { url, expect } }],
  }))
  const real = console.log
  console.log = () => {}
  try {
    const code = await check({ json: true })
    return { code, result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')) }
  } finally { console.log = real }
}

test('a response whose shape drifted fails with the exact path', async () => {
  const { s, url } = await serveJson({ user: { id: 'not-a-number', email: 'a@b.c' }, ok: true })
  try {
    const { code, result } = await runAgainst(url, { status: 200, json: { user: { id: '<number>' }, ok: true } })
    assert.equal(code, 1)
    assert.equal(result.failures[0].expected, '$.user.id = <number>')
    assert.match(result.failures[0].observed, /\$\.user\.id was "not-a-number"/)
  } finally { s.close() }
})

test('a matching shape passes even with extra fields', async () => {
  const { s, url } = await serveJson({ user: { id: 42, email: 'a@b.c', createdAt: 'x' }, ok: true, trace: 'z' })
  try {
    const { code } = await runAgainst(url, { json: { user: { id: '<number>', email: '<string>' }, ok: true } })
    assert.equal(code, 0)
  } finally { s.close() }
})

test('an HTML error page where JSON was expected says so', async () => {
  const { s, url } = await serveJson('<html>oops</html>', 'text/html')
  try {
    const { code, result } = await runAgainst(url, { json: { ok: true } })
    assert.equal(code, 1)
    assert.equal(result.failures[0].expected, 'a JSON body')
    assert.match(result.failures[0].observed, /not JSON \(content-type: text\/html\)/)
  } finally { s.close() }
})

test('the matcher walks the expectation, not the response', async () => {
  // A hostile or merely enormous response cannot drive proof's recursion: depth is bounded
  // by what the contract asserts, which its author wrote. Walking both sides would make a
  // 50,000-deep body a stack overflow reported as "check crashed".
  const deep = n => {
    const root = {}
    let cursor = root
    for (let i = 0; i < n; i++) { cursor.next = {}; cursor = cursor.next }
    cursor.leaf = 1
    return root
  }

  const response = Object.assign(deep(50_000), { ok: true })
  assert.equal(jsonMismatch({ ok: true }, response), null, 'a shallow expectation matches whatever the depth')
})

test('a huge array response is likewise bounded by the expectation', async () => {
  const response = Array.from({ length: 100_000 }, (_, i) => ({ id: i }))
  assert.equal(jsonMismatch([{ id: 0 }], response), null)
})

test('and a mismatch deep inside a large response is still found', async () => {
  // The bound must not become "stop looking".
  const response = { user: { profile: { contact: { email: 'a@b.c' } } }, noise: Array.from({ length: 10_000 }, (_, i) => i) }

  assert.equal(jsonMismatch({ user: { profile: { contact: { email: 'a@b.c' } } } }, response), null)
  const problem = jsonMismatch({ user: { profile: { contact: { email: 'z@z.z' } } } }, response)
  assert.equal(problem.path, '$.user.profile.contact.email')
})
