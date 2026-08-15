import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'

const captured = async fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { await fn() } finally { console.log = real }
  return lines.join('\n')
}

// redirects to a long URL, the way an auth gate with a return path does
const serve = () => new Promise(resolve => {
  const s = createServer((req, res) => {
    if (req.url.startsWith('/admin')) {
      res.writeHead(302, {
        location: '/login?redirected=true&reason=unauthenticated&next=%2Fadmin%2Fdashboard%2Fsettings',
      })
      return res.end()
    }
    res.writeHead(200)
    res.end('ok')
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async url => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-warnwrap-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'admin area',
    checks: [{ name: 'admin dashboard', http: { url: `${url}/admin/dashboard/settings`, expect: { status: 200 } } }],
  }))
  return captured(() => check({}))
}

test('the regression: a warning containing a long URL is wrapped, not left to overflow', async () => {
  const { s, url } = await serve()
  try {
    const out = await run(url)
    const widest = Math.max(...out.split('\n').map(l => l.length))
    assert.ok(widest <= 100, `widest line was ${widest} characters`)
  } finally { s.close() }
})

test('the wrapped warning is still readable and complete', async () => {
  const { s, url } = await serve()
  try {
    const out = await run(url)
    const start = out.split('\n').findIndex(l => l.includes('OBSERVED BUT NOT GATED'))
    const body = out.split('\n').slice(start + 1).join(' ').replace(/\s+/g, ' ')

    assert.match(body, /admin dashboard: GET \/admin\/dashboard\/settings did not answer directly/)
    assert.match(body, /follow_redirects: false/, 'the advice survives the wrap')
  } finally { s.close() }
})

test('every wrapped line is indented under its heading', async () => {
  const { s, url } = await serve()
  try {
    const out = await run(url)
    const lines = out.split('\n')
    const start = lines.indexOf('OBSERVED BUT NOT GATED')
    const body = lines.slice(start + 1, start + 4)

    assert.ok(body.length > 1, 'the warning wrapped onto several lines')
    for (const line of body) assert.match(line, /^ {2}\S/, `expected two-space indent: ${JSON.stringify(line)}`)
  } finally { s.close() }
})

test('a short warning stays on one line', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-warnwrap-short-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'g',
    checks: [{ name: 'a', run: 'true' }],
  }))

  const out = await captured(() => check({}))
  assert.doesNotMatch(out, /OBSERVED BUT NOT GATED/, 'nothing to warn about here')
  assert.match(out, /NOTE/, 'but the run-only advisory still appears')

  const noteLines = out.split('\n').slice(out.split('\n').indexOf('NOTE') + 1, -1)
  for (const line of noteLines.filter(l => l.trim())) {
    assert.ok(line.length <= 100, `advisory line is ${line.length} characters`)
  }
})
