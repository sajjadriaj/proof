import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { validateSpec } from '../src/validate.js'

// echoes exactly what it received, so the test asserts on the wire, not on intent
const serve = () => new Promise(resolve => {
  const seen = []
  const s = createServer((req, res) => {
    let body = ''
    req.on('data', d => { body += d })
    req.on('end', () => {
      seen.push({ contentType: req.headers['content-type'] ?? null, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, seen, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async (url, http) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-body-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'request encoding',
    checks: [{ name: 'post', http: { url: `${url}/submit`, method: 'POST', ...http } }],
  }))
  const real = console.log
  console.log = () => {}
  try {
    return await check({ json: true })
  } finally { console.log = real }
}

test('the regression: a form content-type gets a form-encoded body, not JSON', async () => {
  const { s, seen, url } = await serve()
  try {
    await run(url, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: { email: 'user@example.com', plan: 'pro' },
    })
    assert.equal(seen[0].contentType, 'application/x-www-form-urlencoded')
    assert.equal(seen[0].body, 'email=user%40example.com&plan=pro')
  } finally { s.close() }
})

test('a header spelled Content-Type is honoured just the same', async () => {
  const { s, seen, url } = await serve()
  try {
    await run(url, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: { a: '1', b: '2' },
    })
    assert.equal(seen[0].body, 'a=1&b=2')
  } finally { s.close() }
})

test('an object body with no content-type is still JSON, and labelled so', async () => {
  const { s, seen, url } = await serve()
  try {
    await run(url, { body: { email: 'user@example.com' } })
    assert.match(seen[0].contentType, /application\/json/)
    assert.deepEqual(JSON.parse(seen[0].body), { email: 'user@example.com' })
  } finally { s.close() }
})

test('a string body is sent verbatim and is never labelled JSON', async () => {
  const { s, seen, url } = await serve()
  try {
    await run(url, { body: 'raw text payload' })
    assert.equal(seen[0].body, 'raw text payload')
    // proof adds nothing; fetch applies its standard text/plain default, as any client would
    assert.doesNotMatch(seen[0].contentType, /json/, 'a string is not silently declared to be JSON')
    assert.match(seen[0].contentType, /text\/plain/)
  } finally { s.close() }
})

test('a string body keeps the content-type the contract declares', async () => {
  const { s, seen, url } = await serve()
  try {
    await run(url, { headers: { 'content-type': 'application/xml' }, body: '<order id="1"/>' })
    assert.equal(seen[0].contentType, 'application/xml')
    assert.equal(seen[0].body, '<order id="1"/>')
  } finally { s.close() }
})

test('an object body proof cannot encode is a contract error, not a guessed request', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [{
      name: 'a',
      http: { url: 'http://x.test/', headers: { 'content-type': 'application/xml' }, body: { order: 1 } },
    }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /content-type is "application\/xml", which proof cannot encode an object into/)
  assert.match(p[0], /provide the body as a string/)
})

test('nested values in a form body are rejected rather than stringified as [object Object]', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [{
      name: 'a',
      http: {
        url: 'http://x.test/',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: { user: { email: 'a@b.c' } },
      },
    }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /form fields must be scalars/)
})

test('json content-types of every flavour still take an object body', () => {
  assert.deepEqual(validateSpec({
    goal: 'g',
    checks: [{
      name: 'a',
      http: { url: 'http://x.test/', headers: { 'content-type': 'application/vnd.api+json' }, body: { a: 1 } },
    }],
  }), [])
})
