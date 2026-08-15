import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { findGaps, migrateCommand } from '../src/infer.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const serve = body => new Promise(resolve => {
  const s = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><title>t</title><p>ready</p><script>${body}</script>`)
  })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const run = async (url, browser) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-console-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'g',
    checks: [{ name: 'page', timeout: 25, browser: { base_url: url, ...browser } }],
  }))
  await quiet(() => check({ json: true }))
  return {
    result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
    bundle: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/browser-page.json'), 'utf8')),
  }
}

test('the regression: an ordinary console.log is not reported as an error', async () => {
  // Nothing exercised the filter. If it broke, every log line in a healthy app would be
  // reported as a console error — and with `expect_no_console_errors` set, would fail it.
  const { s, url } = await serve("console.log('starting'); console.info('ready'); console.warn('careful')")
  try {
    const { result, bundle } = await run(url, { flow: [{ visit: '/' }, { expect_text: 'ready' }] })

    assert.equal(result.status, 'passed')
    assert.deepEqual(bundle.consoleErrors, [], `non-errors were collected: ${JSON.stringify(bundle.consoleErrors)}`)
  } finally { s.close() }
})

test('a console.error alongside logs is still caught', async () => {
  // The filter must not be "collect nothing".
  const { s, url } = await serve("console.log('fine'); console.error('actually broken')")
  try {
    const { bundle } = await run(url, { flow: [{ visit: '/' }, { expect_text: 'ready' }] })

    assert.equal(bundle.consoleErrors.length, 1, JSON.stringify(bundle.consoleErrors))
    assert.match(bundle.consoleErrors[0].text, /actually broken/)
  } finally { s.close() }
})

test('a console error with no source location is still recorded', async () => {
  // From an eval, an extension, or a stripped bundle: no url, no line. Dropping it would
  // lose the error; inventing a location would be worse.
  const { s, url } = await serve("eval(\"console.error('from an eval')\")")
  try {
    const { bundle } = await run(url, { flow: [{ visit: '/' }, { expect_text: 'ready' }] })

    const hit = bundle.consoleErrors.find(e => e.text.includes('from an eval'))
    assert.ok(hit, JSON.stringify(bundle.consoleErrors))
    assert.ok(hit.at === null || typeof hit.at === 'string', 'at is a location or explicitly absent')
  } finally { s.close() }
})

test('the console gate counts errors only, not every message', async () => {
  const { s, url } = await serve("console.log('a'); console.warn('b'); console.log('c')")
  try {
    const { result } = await run(url, {
      flow: [{ visit: '/' }, { expect_text: 'ready' }],
      expect_no_console_errors: true,
    })

    assert.equal(result.status, 'passed', 'logs and warnings are not errors')
  } finally { s.close() }
})

test('a project with no recognisable migrator still reports the migration gap', () => {
  // The gap is real — migrations changed and nothing asserts them. What proof cannot supply
  // is the command, so it says so rather than inventing one.
  const dir = mkdtempSync(join(tmpdir(), 'proof-migrate-'))
  process.chdir(dir)
  mkdirSync('migrations', { recursive: true })
  writeFileSync('migrations/001_init.sql', 'create table users (id int);\n')

  assert.equal(migrateCommand(), null, 'no package.json, so no migrator')

  const gap = findGaps(['migrations/001_init.sql'], [], { reportUncovered: false })
    .find(g => g.title.includes('migrations'))

  assert.ok(gap, 'the migration gap is still reported')
  assert.match(gap.note, /no migrator detected/)
  assert.match(gap.check.run, /TODO/, 'and the generated check is an explicit placeholder')
})

test('a package.json that will not parse yields no migrator rather than a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-migrate-bad-'))
  process.chdir(dir)
  writeFileSync('package.json', '{ not json')

  assert.equal(migrateCommand(), null)
})

test('a recognised migrator is used instead of the placeholder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-migrate-ok-'))
  process.chdir(dir)
  writeFileSync('package.json', JSON.stringify({ dependencies: { prisma: '5.0.0' } }))

  assert.match(migrateCommand(), /prisma migrate deploy/)
})
