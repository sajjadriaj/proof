import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { boundedList, CONSOLE_CAP } from '../src/browser.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const serve = errors => new Promise(resolve => {
  const page = `<!doctype html><meta charset=utf-8><title>t</title><h1>Busy</h1>
<script>for (let i = 0; i < ${errors}; i++) console.error('error number ' + i + ' with padding text')</script>`
  const s = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page) })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async (url, browserExtra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-bbounds-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'busy page',
    checks: [{
      name: 'busy',
      timeout: 40,
      browser: { base_url: url, visit: '/', flow: [{ expect_text: 'Busy' }], ...browserExtra },
    }],
  }))
  const code = await quiet(() => check({ json: true }))
  return {
    code,
    dir,
    result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
    bundle: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/browser-busy.json'), 'utf8')),
  }
}

test('the regression: a page in an error loop does not produce a multi-megabyte bundle', async () => {
  const { s, url } = await serve(20000)
  try {
    const { dir, bundle } = await run(url)

    assert.ok(bundle.consoleErrors.length <= CONSOLE_CAP, `kept ${bundle.consoleErrors.length} entries`)
    assert.ok(bundle.console_errors_total >= 20000, 'the true count is still recorded')
    assert.ok(bundle.console_errors_dropped > 0)

    for (const file of ['browser-busy.json', 'result.json']) {
      const bytes = statSync(join(dir, '.proof/runs/0001', file)).size
      assert.ok(bytes < 200 * 1024, `${file} is ${Math.round(bytes / 1024)} KB`)
    }
  } finally { s.close() }
})

test('both ends are kept, so the first and last errors survive', async () => {
  const { s, url } = await serve(20000)
  try {
    const { bundle } = await run(url)
    const texts = bundle.consoleErrors.map(e => e.text)

    assert.ok(texts.some(t => t.includes('error number 0')), 'the first error explains the failure')
    assert.ok(texts.some(t => /error number 199\d\d/.test(t)), 'the last shows where it ended')
  } finally { s.close() }
})

test('the gate counts every error, not just the retained ones', async () => {
  const { s, url } = await serve(20000)
  try {
    const { code, result } = await run(url, { expect_no_console_errors: true })
    assert.equal(code, 1)
    assert.match(result.failures[0].observed, /^console → 2\d{4} console error\(s\)/, result.failures[0].observed)
  } finally { s.close() }
})

test('the warning counts every error too', async () => {
  const { s, url } = await serve(20000)
  try {
    const { result } = await run(url)
    assert.match(result.warnings[0], /2\d{4} console error\(s\) logged/)
  } finally { s.close() }
})

test('an ordinary page is stored whole, with nothing dropped', async () => {
  const { s, url } = await serve(3)
  try {
    const { bundle } = await run(url)
    assert.equal(bundle.consoleErrors.length, 3)
    assert.equal(bundle.console_errors_total, 3)
    assert.equal(bundle.console_errors_dropped, 0)
    assert.equal(bundle.requests_dropped, 0)
  } finally { s.close() }
})

test('boundedList keeps both ends and counts the gap', () => {
  const list = boundedList(4)
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) list.push(n)

  assert.deepEqual(list.items(), [1, 2, 9, 10])
  assert.equal(list.total, 10)
  assert.equal(list.dropped, 6)
})

test('boundedList under the cap keeps everything', () => {
  const list = boundedList(10)
  for (const n of [1, 2, 3]) list.push(n)

  assert.deepEqual(list.items(), [1, 2, 3])
  assert.equal(list.dropped, 0)
})
