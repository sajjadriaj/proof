import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import YAML from 'yaml'
import { check } from '../src/check.js'
import { validateSpec, serveBase, serveCheckNames } from '../src/validate.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'proof-serve-list-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify(spec))
  const code = await quiet(() => check({ json: true }))
  return { dir, code, result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')) }
}

// Announces itself, then stays up. The marker is what the API below refuses to start without.
const DB = `node -e "
  require('fs').writeFileSync('db-up', '1');
  console.log('database system is ready to accept connections');
  setInterval(() => {}, 1e4)
"`

// Exits non-zero if the database has not come up yet, so a run that boots these concurrently
// or in the wrong order cannot pass. That is the whole assertion of the ordering test.
const API = port => `node -e "
  if (!require('fs').existsSync('db-up')) { console.error('no database'); process.exit(1) }
  require('http').createServer((q, s) => s.end('ok')).listen(${port});
  console.log('api listening')
"`

const named = (result, name) => result.results.find(r => r.name === name)

test('the regression: an application that is more than one process can be verified', async () => {
  const port = await freePort()
  const { code, result } = await run({
    goal: 'the API serves once its database is up',
    serve: [
      { name: 'db', run: DB, ready_log: 'ready to accept connections', timeout: 20 },
      { name: 'api', run: API(port), ready_url: `http://127.0.0.1:${port}/`, timeout: 20 },
    ],
    checks: [{ name: 'api answers', http: { path: '/', expect: { status: 200, body_contains: 'ok' } } }],
  })

  assert.equal(code, 0, JSON.stringify(result.failures))
  // Order is the dependency order: the API refuses to start before the database is up.
  assert.equal(named(result, 'app boots (db)').status, 'passed')
  assert.equal(named(result, 'app boots (api)').status, 'passed')
})

test('every process gets its own boots, liveness and log-gate check', async () => {
  const port = await freePort()
  const { result } = await run({
    goal: 'g',
    serve: [
      { name: 'db', run: DB, ready_log: 'ready to accept', timeout: 20, log_must_not_match: 'PANIC' },
      { name: 'api', run: API(port), ready_url: `http://127.0.0.1:${port}/`, timeout: 20 },
    ],
    checks: [{ name: 'ok', http: { path: '/' } }],
  })

  for (const name of ['app boots (db)', 'app boots (api)', 'app still running (db)',
    'app still running (api)', 'app logs clean (db)']) {
    assert.ok(named(result, name), `${name} is missing from ${result.results.map(r => r.name).join(', ')}`)
  }
  // The gate is opt-in per process, so the one that did not ask for it does not get one.
  assert.equal(named(result, 'app logs clean (api)'), undefined)
})

test('one process keeps the unsuffixed names, so existing contracts are untouched', async () => {
  const port = await freePort()
  // Written as a list of one: the shape changed, the output must not.
  const { result } = await run({
    goal: 'g',
    serve: [{ run: API(port).replace('if (!require', 'if (false && !require'), ready_url: `http://127.0.0.1:${port}/`, timeout: 20 }],
    checks: [{ name: 'ok', http: { path: '/' } }],
  })

  assert.ok(named(result, 'app boots'), result.results.map(r => r.name).join(', '))
  assert.ok(named(result, 'app still running'))
  assert.equal(named(result, 'app boots (1)'), undefined)
})

test('each process writes its own log; a single one still writes serve.log', async () => {
  const port = await freePort()
  const { dir } = await run({
    goal: 'g',
    serve: [
      { name: 'db', run: DB, ready_log: 'ready to accept', timeout: 20 },
      { name: 'api', run: API(port), ready_url: `http://127.0.0.1:${port}/`, timeout: 20 },
    ],
    checks: [{ name: 'ok', http: { path: '/' } }],
  })
  const runDir = join(dir, '.proof/runs/0001')

  assert.match(readFileSync(join(runDir, 'serve-db.log'), 'utf8'), /ready to accept connections/)
  assert.match(readFileSync(join(runDir, 'serve-api.log'), 'utf8'), /api listening/)
  // One log holding two processes' output is a log that explains neither.
  assert.equal(existsSync(join(runDir, 'serve.log')), false)
})

test('a process that fails to boot stops the ones after it', async () => {
  // The API cannot come up without its database, so every later failure would be about the
  // first one. A list of failures whose causes are all the same failure is unreadable.
  const port = await freePort()
  const { code, result } = await run({
    goal: 'g',
    serve: [
      { name: 'db', run: 'exit 1', ready_log: 'never', timeout: 5 },
      { name: 'api', run: API(port), ready_url: `http://127.0.0.1:${port}/`, timeout: 5 },
    ],
    checks: [{ name: 'never runs', http: { path: '/' } }],
  })

  assert.equal(code, 1)
  assert.equal(named(result, 'app boots (db)').status, 'failed')
  assert.equal(named(result, 'app boots (api)'), undefined, 'the API was started anyway')
  assert.equal(named(result, 'never runs'), undefined, 'the checks ran against a half-started stack')
})

test('a process that dies mid-run is named, not just "the app"', async () => {
  const port = await freePort()
  const { code, result } = await run({
    goal: 'g',
    serve: [
      { name: 'db', run: `${DB.replace('setInterval(() => {}, 1e4)', 'setTimeout(() => process.exit(0), 900)')}`, ready_log: 'ready to accept', timeout: 20 },
      { name: 'api', run: API(port), ready_url: `http://127.0.0.1:${port}/`, timeout: 20 },
    ],
    checks: [{ name: 'outlives them', run: 'sleep 2' }],
  })

  assert.equal(code, 1)
  assert.equal(named(result, 'app still running (db)').status, 'failed')
  assert.equal(named(result, 'app still running (api)').status, 'passed')
  assert.equal(result.failures[0].check, 'app still running (db)')
})

test('relative paths resolve against the last URL, and the run says so when there are several', async () => {
  const [a, b] = [await freePort(), await freePort()]
  const server = p => `node -e "require('http').createServer((q,s)=>s.end('port ${p}')).listen(${p});console.log('up ${p}')"`
  const { code, result } = await run({
    goal: 'g',
    serve: [
      { name: 'first', run: server(a), ready_url: `http://127.0.0.1:${a}/`, timeout: 20 },
      { name: 'second', run: server(b), ready_url: `http://127.0.0.1:${b}/`, timeout: 20 },
    ],
    checks: [{ name: 'hits the last one', http: { path: '/', expect: { body_contains: `port ${b}` } } }],
  })

  assert.equal(code, 0, JSON.stringify(result.failures))
  assert.match(result.warnings.join('\n'), /2 serve blocks declare a URL/)
  assert.match(result.warnings.join('\n'), new RegExp(`resolve against the last of them \\(http://127.0.0.1:${b}/\\)`))
})

test('both processes are torn down, freeing both ports', async () => {
  const [a, b] = [await freePort(), await freePort()]
  const server = p => `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(${p});console.log('up')" ; true`
  await run({
    goal: 'g',
    serve: [
      { name: 'one', run: server(a), ready_url: `http://127.0.0.1:${a}/`, timeout: 20 },
      { name: 'two', run: server(b), ready_url: `http://127.0.0.1:${b}/`, timeout: 20 },
    ],
    checks: [{ name: 'ok', http: { path: '/' } }],
  })
  await new Promise(r => setTimeout(r, 400))

  const held = port => new Promise(resolve => {
    const s = createServer()
    s.once('error', () => resolve(true))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)))
  })
  assert.equal(await held(a), false, `port ${a} still held`)
  assert.equal(await held(b), false, `port ${b} still held`)
})

// --- the contract itself ------------------------------------------------------

const problemsFor = serve => validateSpec({ goal: 'g', serve, checks: [{ name: 'a', run: 'true' }] })

test('with more than one process, a name is required', () => {
  // Names are how the run reports which one booted, which one died, and whose log matched.
  const problems = problemsFor([
    { run: 'a', ready_log: 'up' },
    { run: 'b', ready_log: 'up' },
  ])
  assert.equal(problems.filter(p => /needs a `name`/.test(p)).length, 2, problems.join('\n'))
})

test('a single process needs no name', () => {
  assert.deepEqual(problemsFor([{ run: 'a', ready_log: 'up' }]), [])
  assert.deepEqual(problemsFor({ run: 'a', ready_log: 'up' }), [])
})

test('two processes cannot share a name', () => {
  // Two checks called `app boots (api)` collapse into one entry in `result.checks`.
  const problems = problemsFor([
    { name: 'api', run: 'a', ready_log: 'up' },
    { name: 'API', run: 'b', ready_log: 'up' },
  ])
  assert.ok(problems.some(p => /duplicate serve name/.test(p)), problems.join('\n'))
})

test('an unknown key inside a list entry is still rejected', () => {
  // The top-level walk recurses into a mapping but not into a list, so a typo there was
  // silently ignored — and a silently ignored `ready_url` is an app proof never waited for.
  const problems = problemsFor([{ name: 'a', run: 'x', redy_url: 'http://127.0.0.1:1' }])
  assert.ok(problems.some(p => /unknown key "redy_url"/.test(p)), problems.join('\n'))
  assert.ok(problems.some(p => /did you mean "ready_url"/.test(p)), problems.join('\n'))
})

test('problems in a list entry say which entry', () => {
  const problems = problemsFor([
    { name: 'a', run: 'x', ready_log: 'up' },
    { name: 'b', ready_log: 'up' },
  ])
  assert.ok(problems.some(p => p.startsWith('spec › serve[1]: needs a `run`')), problems.join('\n'))
})

test('an empty list is refused rather than treated as no serve block', () => {
  assert.ok(problemsFor([]).some(p => /is an empty list/.test(p)))
})

test('a list entry that is not a mapping is refused', () => {
  assert.ok(problemsFor(['npm run dev']).some(p => /spec › serve\[0\]: must be a mapping/.test(p)))
})

test('a contract check cannot collide with a suffixed serve check name either', () => {
  const problems = validateSpec({
    goal: 'g',
    serve: [
      { name: 'api', run: 'a', ready_log: 'up' },
      { name: 'db', run: 'b', ready_log: 'up' },
    ],
    checks: [{ name: 'app boots (api)', run: 'true' }],
  })
  assert.ok(problems.some(p => /proof adds a check of this name itself/.test(p)), problems.join('\n'))
})

test('the base URL is the last one declared, whichever entries have one', () => {
  assert.equal(serveBase([{ ready_log: 'x' }, { ready_url: 'http://a/' }, { ready_log: 'y' }]), 'http://a/')
  assert.equal(serveBase([{ ready_url: 'http://a/' }, { ready_url: 'http://b/' }]), 'http://b/')
  assert.equal(serveBase([{ ready_log: 'x' }]), undefined)
})

test('a relative path with no URL anywhere in the list is still refused', () => {
  // "No guessed host" holds however the serve block is written.
  const problems = validateSpec({
    goal: 'g',
    serve: [{ name: 'w', run: 'a', ready_log: 'up' }, { name: 'x', run: 'b', ready_log: 'up' }],
    checks: [{ name: 'a', http: { path: '/health' } }],
  })
  assert.ok(problems.some(p => /no `serve.ready_url` to resolve it against/.test(p)), problems.join('\n'))
})

test('the generated names are derived in one place', () => {
  assert.deepEqual(serveCheckNames({ serve: { run: 'a' } }), ['app boots', 'app still running', 'app logs clean'])
  assert.deepEqual(serveCheckNames({ serve: [{ name: 'db', run: 'a' }, { name: 'api', run: 'b' }] }), [
    'app boots (db)', 'app still running (db)', 'app logs clean (db)',
    'app boots (api)', 'app still running (api)', 'app logs clean (api)',
  ])
  assert.deepEqual(serveCheckNames({}), [])
})
