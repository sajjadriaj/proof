import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { report } from '../src/report.js'

const PAGE = noisy => `<!doctype html><meta charset=utf-8><title>t</title><h1>Dashboard</h1>
<script>
${noisy ? "console.error('Failed to load analytics: window.analytics is undefined');setTimeout(()=>{undefinedFunction()},30)" : ''}
</script>`

const serve = noisy => new Promise(resolve => {
  const s = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE(noisy)) })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async (url, browserExtra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-observed-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'dashboard loads',
    checks: [{
      name: 'dashboard flow',
      timeout: 20,
      browser: { base_url: url, visit: '/dashboard', flow: [{ expect_text: 'Dashboard' }, { wait: 300 }], ...browserExtra },
    }],
  }))
  const real = console.log
  const lines = []
  console.log = s => lines.push(String(s))
  try {
    const code = await check({})
    return {
      code,
      out: lines.join('\n'),
      dir,
      result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
    }
  } finally { console.log = real }
}

test('the regression: console errors on a passing check are reported, not swallowed', async () => {
  const { s, url } = await serve(true)
  try {
    const { code, out, result } = await run(url)

    assert.equal(code, 0, 'still a pass — the gate is opt-in')
    assert.equal(result.checks['dashboard flow'], 'passed')

    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /dashboard flow: 2 console error\(s\) logged/)
    assert.match(out, /OBSERVED BUT NOT GATED/)
    assert.match(out, /expect_no_console_errors/)
  } finally { s.close() }
})

test('the report lists the actual error text a reviewer needs', async () => {
  const { s, url } = await serve(true)
  try {
    const { dir } = await run(url)
    const real = console.log
    console.log = () => {}
    try { report({}) } finally { console.log = real }

    const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
    assert.match(md, /## Observed but not gated/)
    assert.match(md, /\*\*dashboard flow\*\* passed with 2 console error\(s\)/)
    assert.match(md, /window\.analytics is undefined/)
    assert.match(md, /undefinedFunction is not defined/)
  } finally { s.close() }
})

test('a clean page produces no warnings at all', async () => {
  const { s, url } = await serve(false)
  try {
    const { code, out, result, dir } = await run(url)
    assert.equal(code, 0)
    assert.deepEqual(result.warnings, [])
    assert.doesNotMatch(out, /OBSERVED BUT NOT GATED/)

    const real = console.log
    console.log = () => {}
    try { report({}) } finally { console.log = real }
    assert.doesNotMatch(readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8'), /Observed but not gated/)
  } finally { s.close() }
})

test('opting into the gate turns the same errors into a failure', async () => {
  const { s, url } = await serve(true)
  try {
    const { code, result } = await run(url, { expect_no_console_errors: true })
    assert.equal(code, 1)
    assert.equal(result.checks['dashboard flow'], 'failed')
    assert.match(result.failures[0].expected, /no console errors/)
    assert.deepEqual(result.warnings, [], 'a failure is reported as a failure, not a warning')
  } finally { s.close() }
})
