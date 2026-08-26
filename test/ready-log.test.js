import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { validateSpec } from '../src/validate.js'

// An app with no HTTP surface at all — the shape that could not have a serve block before,
// because polling a URL was the only readiness proof knew. It writes a file, then says it is
// up. The file check is the proof that proof waited: without readiness gating, the check runs
// before the write lands.
const WORKER = `node -e "
  const fs = require('fs');
  setTimeout(() => { fs.writeFileSync('ready.txt', 'up'); console.log('worker listening on queue jobs'); }, 500);
  setInterval(() => {}, 1e4)
"`

// Ports must be genuinely allocated: test files run in parallel, and a guessed one collides.
const freePort = () => new Promise(resolve => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const run = async spec => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-ready-log-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(spec))
  const code = await quiet(() => check({ json: true }))
  return { code, result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')) }
}

const boots = result => result.results.find(r => r.name === 'app boots')
const liveness = result => result.results.find(r => r.name === 'app still running')

test('the regression: an app with no HTTP surface can be verified at all', async () => {
  const { code, result } = await run({
    goal: 'the worker starts and picks up its queue',
    serve: { run: WORKER, ready_log: 'listening on queue', timeout: 15 },
    checks: [{ name: 'worker wrote its marker', file: 'ready.txt' }],
  })

  assert.equal(code, 0, JSON.stringify(result.failures))
  assert.equal(boots(result).status, 'passed')
})

test('what proof observed is the matched line, not the word "matched"', async () => {
  // That line is usually where the app states its port, its mode or its worker count. A run
  // read back months later needs the line, not a restatement of the pattern.
  const { result } = await run({
    goal: 'g',
    serve: { run: WORKER, ready_log: 'listening on queue', timeout: 15 },
    checks: [{ name: 'marker', file: 'ready.txt' }],
  })

  assert.equal(boots(result).observed, 'worker listening on queue jobs')
  assert.match(boots(result).asserted, /logs a line matching \/listening on queue\//)
})

test('a pattern that never matches fails as a log failure, not a URL one', async () => {
  const { code, result } = await run({
    goal: 'g',
    serve: { run: 'node -e "console.log(\'starting up\'); setInterval(()=>{},1e4)"', ready_log: 'listening', timeout: 2 },
    checks: [{ name: 'never runs', run: 'true' }],
  })

  assert.equal(code, 1)
  assert.match(boots(result).observed, /no log line matched \/listening\/ within 2s/)
  assert.doesNotMatch(boots(result).observed, /not ready at/)
  // The output leading up to the failure is what explains it.
  assert.match(boots(result).output ?? '', /starting up/)
})

test('without a ready_url, liveness is whether the process is still there', async () => {
  // `run` is usually a shell wrapper, so this is weaker than asking a URL — and it is the
  // strongest thing observable when there is no URL to ask. It must not silently pass.
  const { code, result } = await run({
    goal: 'g',
    serve: { run: 'node -e "console.log(\'ready\'); setTimeout(()=>process.exit(0), 800)"', ready_log: 'ready', timeout: 15 },
    checks: [{ name: 'outlives the app', run: 'sleep 2' }],
  })

  assert.equal(code, 1)
  assert.equal(liveness(result).status, 'failed')
  assert.match(liveness(result).observed, /exited 0/)
  assert.match(liveness(result).asserted, /the process proof started is still running/)
})

test('a launcher that exits leaves nothing to observe, and the run says so', async () => {
  // No URL to ask and no process proof still holds. Reporting "still running" there would be
  // a claim about something it lost track of, so the check is omitted — and the omission is
  // stated rather than left as a gap in the list.
  const dir = mkdtempSync(join(tmpdir(), 'proof-ready-log-detached-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('up.sh', '#!/bin/sh\nnode -e "console.log(\'worker up\'); setInterval(()=>{},1e4)" &\nexit 0\n')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'g',
    serve: { run: 'sh up.sh', ready_log: 'worker up', timeout: 15 },
    checks: [{ name: 'ok', run: 'true' }],
  }))

  await quiet(() => check({ json: true }))
  const result = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))

  assert.equal(boots(result).status, 'passed')
  assert.equal(liveness(result), undefined, 'a liveness verdict was reported with nothing to observe')
  assert.match(result.warnings.join('\n'), /nothing checks whether the app\s+is still running/)
})

test('with both signals the log gates readiness and the URL still resolves paths', async () => {
  // An app can bind its port before it has finished the work that makes it usable. Polling
  // the port would call that ready; the log is what says the work is done.
  const port = await freePort()
  const app = `node -e "
    require('http').createServer((q, s) => s.end(require('fs').existsSync('warm.txt') ? 'warm' : 'cold')).listen(${port});
    setTimeout(() => { require('fs').writeFileSync('warm.txt', '1'); console.log('cache warmed, accepting traffic'); }, 600)
  "`
  const { code, result } = await run({
    goal: 'g',
    serve: { run: app, ready_url: `http://127.0.0.1:${port}/`, ready_log: 'accepting traffic', timeout: 15 },
    checks: [{ name: 'serves warm', http: { path: '/', expect: { status: 200, body_contains: 'warm' } } }],
  })

  assert.equal(code, 0, JSON.stringify(result.failures))
  assert.equal(boots(result).observed, 'cache warmed, accepting traffic')
  // The URL is still there, so liveness is still the stronger question.
  assert.match(liveness(result).asserted, /still responding/)
})

test('a serve block with no readiness signal at all is refused', () => {
  const [problem] = validateSpec({ goal: 'g', serve: { run: 'x' }, checks: [{ name: 'a', run: 'true' }] })
  assert.match(problem, /needs a `ready_url` to poll, or a `ready_log` pattern/)
})

test('a ready_log that matches anything is refused', () => {
  // An empty pattern matches the empty log the app has not written to yet, so every check
  // would run against an app that is not up.
  const problems = validateSpec({ goal: 'g', serve: { run: 'x', ready_log: '' }, checks: [{ name: 'a', run: 'true' }] })
  assert.ok(problems.some(p => /ready_log: is empty/.test(p)), problems.join('\n'))
})

test('an invalid ready_log regex is caught before anything boots', () => {
  const problems = validateSpec({ goal: 'g', serve: { run: 'x', ready_log: '([' }, checks: [{ name: 'a', run: 'true' }] })
  assert.ok(problems.some(p => /ready_log: invalid regex/.test(p)), problems.join('\n'))
})
