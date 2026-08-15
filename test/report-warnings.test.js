import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { report } from '../src/report.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

/** Renders a run straight from a result.json, so each case states exactly what it tests. */
const renderResult = async result => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-warn-md-'))
  process.chdir(dir)
  mkdirSync('.proof/runs/0001', { recursive: true })
  writeFileSync('.proof/runs/0001/result.json', JSON.stringify({
    status: 'passed',
    goal: 'g',
    at: new Date(0).toISOString(),
    results: [{ name: 'c', kind: 'run', asserted: '`true`, exit 0', status: 'passed', ms: 1 }],
    failures: [],
    warnings: [],
    ...result,
  }))
  await quiet(() => report({ run: '0001' }))
  return readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
}

test('the regression: warnings reach the report, not just the terminal', async () => {
  // result.json carried them and the terminal printed them; the artifact that gets attached
  // to a review dropped them entirely.
  const md = await renderResult({
    warnings: [
      'GET /admin did not answer directly — it redirected to http://localhost/login',
      'the working tree changed while this run was in progress',
    ],
  })

  assert.match(md, /## Observed but not gated/)
  assert.match(md, /it redirected to http:\/\/localhost\/login/)
  assert.match(md, /the working tree changed/)
})

test('a run with nothing to report has no such section', async () => {
  const md = await renderResult({})
  assert.match(md, /\*\*Verdict:\*\*/, 'a report was rendered at all')
  assert.doesNotMatch(md, /Observed but not gated/)
})

test('the console-error advice appears only when there are console errors', async () => {
  // The section now also carries warnings that have nothing to do with that flag, so the
  // advice followed them around: a reader was told to set a flag for errors not present.
  const md = await renderResult({ warnings: ['a redirect happened'] })

  assert.match(md, /a redirect happened/)
  assert.doesNotMatch(md, /expect_no_console_errors/)
})

test('console errors still bring their advice', async () => {
  const md = await renderResult({
    results: [{
      name: 'page',
      kind: 'browser',
      asserted: 'visit /',
      status: 'passed',
      ms: 1,
      consoleErrors: [{ text: 'TypeError: x is not a function', at: 'app.js:3' }],
    }],
  })

  assert.match(md, /## Observed but not gated/)
  assert.match(md, /TypeError: x is not a function/)
  assert.match(md, /Set `expect_no_console_errors: true`/)
})

test('warnings and console errors appear together, each once', async () => {
  const md = await renderResult({
    warnings: ['a redirect happened'],
    results: [{
      name: 'page',
      kind: 'browser',
      asserted: 'visit /',
      status: 'passed',
      ms: 1,
      consoleErrors: [{ text: 'boom', at: 'app.js:1' }],
    }],
  })

  assert.equal(md.split('## Observed but not gated').length - 1, 1, 'one section, not two')
  assert.match(md, /a redirect happened/)
  assert.match(md, /boom/)
  assert.match(md, /expect_no_console_errors/)
})

test('a warning containing a pipe does not break the markdown around it', async () => {
  const md = await renderResult({ warnings: ['a | b | c happened'] })
  assert.match(md, /a \\\| b \\\| c happened/)
})
