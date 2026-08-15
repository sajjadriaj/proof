import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check } from '../src/check.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const observedFor = async (url, timeout = 3) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-cause-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    `goal: g\nchecks:\n  - name: c\n    http: {url: "${url}"}\n    timeout: ${timeout}\n`)
  await quiet(() => check({ json: true }))
  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  return r.failures[0]?.observed ?? ''
}

test('the regression: a refused connection says so', async () => {
  // Node reports every connection problem as the same "fetch failed" and hides the real
  // reason in `cause`. Refused, DNS failure and a bad port all read identically without it.
  const observed = await observedFor('http://127.0.0.1:47119/nothing')

  assert.match(observed, /ECONNREFUSED/)
  assert.match(observed, /127\.0\.0\.1:47119/, 'and where')
})

test('a name that does not resolve is distinguishable from a refused connection', async () => {
  const observed = await observedFor('http://no-such-host-anywhere.invalid/x')

  assert.match(observed, /ENOTFOUND/)
  assert.doesNotMatch(observed, /ECONNREFUSED/)
})

test('a timeout still reads as a timeout, not a connection error', async () => {
  // The two are different diagnoses: one means nothing is listening, the other means
  // something is and it never answered.
  const dir = mkdtempSync(join(tmpdir(), 'proof-cause-timeout-'))
  process.chdir(dir)
  mkdirSync('.proof')

  const http = await import('node:http')
  const server = http.createServer(() => {}) // accepts, never responds
  await new Promise(res => server.listen(0, '127.0.0.1', res))
  const port = server.address().port

  try {
    writeFileSync('.proof/spec.yaml',
      `goal: g\nchecks:\n  - name: c\n    http: {url: "http://127.0.0.1:${port}/x"}\n    timeout: 1\n`)
    await quiet(() => check({ json: true }))
    const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

    assert.match(r.failures[0].observed, /timeout/i)
    assert.doesNotMatch(r.failures[0].observed, /ECONNREFUSED/)
  } finally { server.close() }
})

test('the chain is bounded — a deeply nested cause cannot flood the field', async () => {
  const { describeFetchError } = await import('../src/check.js')

  let deepest = new Error('root')
  for (let i = 0; i < 50; i++) deepest = Object.assign(new Error(`level ${i}`), { cause: deepest })
  const described = Object.assign(new Error('fetch failed'), { cause: deepest })

  const text = describeFetchError(described)
  assert.ok(text.split('<-').length <= 4, `chain was not bounded: ${text}`)
})

test('an error with no cause is reported unchanged', async () => {
  const { describeFetchError } = await import('../src/check.js')
  assert.equal(describeFetchError(new Error('something simple')), 'something simple')
})

test('a repeated cause is not printed twice', async () => {
  const { describeFetchError } = await import('../src/check.js')
  const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  const mid = Object.assign(new Error('connect ECONNREFUSED'), { cause: inner, code: 'ECONNREFUSED' })
  const outer = Object.assign(new Error('fetch failed'), { cause: mid })

  // The claim is that the same entry is not repeated in the chain — not that the word
  // appears once, since one entry is "ECONNREFUSED (connect ECONNREFUSED)" by itself.
  const entries = describeFetchError(outer).split(': ').pop().split(' <- ')
  assert.deepEqual(entries, [...new Set(entries)], `chain repeats itself: ${entries.join(' <- ')}`)
})
