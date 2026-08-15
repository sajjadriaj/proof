import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

// a payload well past the inline limit, with the interesting value at the very end
const payload = () => ({
  items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item-${i}`, note: 'padding padding padding' })),
  summary: { total: 'not-a-number' },
})

const serve = () => new Promise(resolve => {
  const s = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload()))
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async (url, expect) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-bodyev-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'summary totals are numeric',
    checks: [{ name: 'summary shape', http: { url: `${url}/report`, expect } }],
  }))
  const code = await quiet(() => check({ json: true }))
  return { code, dir, result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')) }
}

test('the regression: a clipped body says so instead of looking complete', async () => {
  const { s, url } = await serve()
  try {
    const { result } = await run(url, { json: { summary: { total: '<number>' } } })
    const check0 = result.results[0]

    assert.equal(check0.body_clipped, true)
    assert.match(check0.output, /more character\(s\)/)
  } finally { s.close() }
})

test('the full body is kept beside a failure, and holds the offending value', async () => {
  const { s, url } = await serve()
  try {
    const { code, dir, result } = await run(url, { json: { summary: { total: '<number>' } } })
    assert.equal(code, 1)

    const f = result.failures[0]
    assert.match(f.observed, /\$\.summary\.total was "not-a-number"/)

    const [file] = f.evidence
    assert.match(file, /response-summary-shape\.txt$/)
    const full = readFileSync(join(dir, file.replace(/^\.proof/, '.proof')), 'utf8')
    assert.match(full, /not-a-number/, 'the evidence contains what the failure describes')
    assert.deepEqual(JSON.parse(full).summary, { total: 'not-a-number' }, 'and it is the whole, valid body')
  } finally { s.close() }
})

test('assertions still run against the whole body, never the clipped copy', async () => {
  const { s, url } = await serve()
  try {
    // `summary` sits past the inline limit; matching it proves the parse used the full text
    const { code } = await run(url, { json: { summary: { total: 'not-a-number' } } })
    assert.equal(code, 0)
  } finally { s.close() }
})

test('a passing check does not write a body file', async () => {
  const { s, url } = await serve()
  try {
    const { dir, result } = await run(url, { status: 200 })
    assert.equal(result.results[0].status, 'passed')
    assert.equal(result.results[0].body_clipped, true, 'still marked as clipped')

    const files = readdirSync(join(dir, '.proof/runs/0001'))
    assert.deepEqual(files.filter(f => f.startsWith('response-')), [], 'no megabytes stored for nobody')
  } finally { s.close() }
})

test('a small body is stored whole and unmarked', async () => {
  const small = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false }))
  })
  await new Promise(r => small.listen(0, '127.0.0.1', r))
  try {
    const { result } = await run(`http://127.0.0.1:${small.address().port}`, { json: { ok: true } })
    assert.equal(result.results[0].body_clipped, false)
    assert.equal(result.failures[0].output, '{"ok":false}')
    assert.equal(result.failures[0].evidence, null, 'the key is always present, null when there is none')
  } finally { small.close() }
})

test('a single enormous line does not flood the terminal', async () => {
  const { s, url } = await serve()
  const lines = []
  const real = console.log
  console.log = x => lines.push(String(x))
  try {
    const dir = mkdtempSync(join(tmpdir(), 'proof-wide-'))
    process.chdir(dir)
    mkdirSync('.proof')
    writeFileSync('.proof/spec.yaml', YAML.stringify({
      goal: 'wide output',
      checks: [{ name: 'summary shape', http: { url: `${url}/report`, expect: { json: { summary: { total: '<number>' } } } } }],
    }))
    await check({})
  } finally {
    console.log = real
    s.close()
  }

  const widest = Math.max(...lines.join('\n').split('\n').map(l => l.length))
  assert.ok(widest < 260, `terminal line of ${widest} characters printed`)
  assert.match(lines.join('\n'), /more character\(s\) on this line/)
})
