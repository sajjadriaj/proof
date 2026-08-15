import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'

// each phrase appears 1.2s after the last, so a three-step flow needs ~3.6s of browser work
const PAGE = `<!doctype html><meta charset=utf-8><title>t</title>
<div id=a></div><div id=b></div><div id=c></div>
<script>
setTimeout(()=>{document.getElementById('a').textContent='alpha'},1200)
setTimeout(()=>{document.getElementById('b').textContent='bravo'},2400)
setTimeout(()=>{document.getElementById('c').textContent='charlie'},3600)
</script>`

const serve = () => new Promise(resolve => {
  const s = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const runFlow = async (url, timeout) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-timeout-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'timeout budget',
    checks: [{
      name: 'slow flow',
      timeout,
      browser: {
        base_url: url,
        visit: '/',
        flow: [{ expect_text: 'alpha' }, { expect_text: 'bravo' }, { expect_text: 'charlie' }],
      },
    }],
  }))
  const real = console.log
  console.log = () => {}
  const started = Date.now()
  try {
    const code = await check({ json: true })
    return {
      code,
      elapsed: Date.now() - started,
      result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
    }
  } finally { console.log = real }
}

test('the regression: timeout bounds the whole check, not each step', async () => {
  const { s, url } = await serve()
  try {
    const { code, result } = await runFlow(url, 2)

    // Passing would require waiting out all three texts (~3.6s of page time), so failing
    // with the budget message *is* the evidence that it stopped early. Wall-clock around
    // the whole call is not: browser launch varies with how many tests run in parallel.
    assert.equal(code, 1, 'a flow needing ~3.6s must not pass under a 2s budget')
    assert.match(result.failures[0].expected, /the flow completes within 2s/)
    assert.match(result.failures[0].observed, /timeout budget exhausted/)
  } finally { s.close() }
})

test('a budget large enough for the whole flow passes', async () => {
  const { s, url } = await serve()
  try {
    const { code } = await runFlow(url, 30)
    assert.equal(code, 0)
  } finally { s.close() }
})

test('the failure names the step the budget ran out on', async () => {
  const { s, url } = await serve()
  try {
    const { result } = await runFlow(url, 2)
    assert.match(result.failures[0].observed, /timeout budget exhausted (before|during) this step/)
    // whichever step it dies on is named — under parallel load that is not always the same one
    assert.match(result.failures[0].observed, /^(Visit|Expect text "(alpha|bravo|charlie)")/)
  } finally { s.close() }
})

test('run: timeout keeps its meaning — the whole command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-timeout-run-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'run budget',
    checks: [{ name: 'slow command', timeout: 1, run: 'sleep 5' }],
  }))
  const real = console.log
  console.log = () => {}
  const started = Date.now()
  try {
    assert.equal(await check({ json: true }), 1)
  } finally { console.log = real }
  assert.ok(Date.now() - started < 4000, 'killed at its budget')

  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.match(r.failures[0].observed, /timed out after 1s/)
})
