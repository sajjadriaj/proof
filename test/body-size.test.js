import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHttp } from '../src/check.js'

// `res.text()` buffers whatever the endpoint sends. A contract pointed at an export or a
// media route took the whole run down with it — and a run that dies writes no evidence,
// which is the worst way for this tool to fail.

const serve = handler => new Promise(resolve => {
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(r => server.close(r)),
  }))
})

const ctx = base => ({ baseUrl: base, runDir: mkdtempSync(join(tmpdir(), 'proof-body-')), cookies: new Map() })

test('a body past the limit fails the check instead of taking the run down', async () => {
  // 9 MB in 1 MB chunks, streamed, so nothing here depends on content-length being sent.
  const chunk = Buffer.alloc(1024 * 1024, 'a')
  const { base, close } = await serve((q, s) => {
    s.writeHead(200, { 'content-type': 'text/plain' })
    for (let i = 0; i < 9; i++) s.write(chunk)
    s.end()
  })

  try {
    const r = await runHttp({ name: 'big', http: { path: '/', expect: { status: 200 } } }, ctx(base))
    assert.equal(r.status, 'failed')
    assert.match(r.observed, /passed 8 MB and proof stopped reading it/)
    // and it says what to do instead, rather than leaving a size limit as the whole answer
    assert.match(r.observed, /`run:` check/)
  } finally { await close() }
})

test('an absence is never satisfied by the half that was not read', async () => {
  // The direction that costs something: `body_not_contains` over a truncated body would
  // pass for a string sitting past the cut.
  const { base, close } = await serve((q, s) => {
    s.writeHead(200, { 'content-type': 'text/plain' })
    s.write(Buffer.alloc(9 * 1024 * 1024, 'a'))
    s.end('SECRET')
  })

  try {
    const r = await runHttp(
      { name: 'absent', http: { path: '/', expect: { body_not_contains: 'SECRET' } } },
      ctx(base),
    )
    assert.equal(r.status, 'failed')
  } finally { await close() }
})

test('an ordinary body is unaffected', async () => {
  const { base, close } = await serve((q, s) => {
    s.writeHead(200, { 'content-type': 'application/json' })
    s.end(JSON.stringify({ ok: true, who: 'ada' }))
  })

  try {
    const r = await runHttp(
      { name: 'small', http: { path: '/', expect: { status: 200, json: { ok: true }, body_contains: 'ada' } } },
      ctx(base),
    )
    assert.equal(r.status, 'passed', r.observed)
  } finally { await close() }
})

test('a body with no content at all still reads as empty, not as oversized', async () => {
  const { base, close } = await serve((q, s) => { s.writeHead(204); s.end() })

  try {
    const r = await runHttp({ name: 'empty', http: { path: '/', expect: { status: 204 } } }, ctx(base))
    assert.equal(r.status, 'passed', r.observed)
  } finally { await close() }
})
