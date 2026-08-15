import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check } from '../src/check.js'
import { init, loadSpec } from '../src/spec.js'

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-'))
  process.chdir(dir)
  return dir
}

const withSpec = yaml => {
  const dir = sandbox()
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', yaml)
  return dir
}

test('check reports pass/fail per verb and exits 1 on any failure', async () => {
  const dir = withSpec(`
goal: sandbox contract
checks:
  - name: passing command
    run: echo hello
  - name: output assertion
    run: echo hello
    expect_output: hello
  - name: failing command
    run: exit 3
  - name: missing file
    file: nope.txt
`)
  const code = await check({ json: true })
  assert.equal(code, 1)

  const result = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.checks, {
    'passing command': 'passed',
    'output assertion': 'passed',
    'failing command': 'failed',
    'missing file': 'failed',
  })
  assert.equal(result.failures.length, 2)
  assert.match(result.failures[0].observed, /exit 3/)
})

test('check exits 0 when every check passes', async () => {
  withSpec(`
goal: all green
checks:
  - name: ok
    run: "true"
`)
  assert.equal(await check({ json: true }), 0)
})

test('http verb resolves paths against serve.ready_url and asserts status', async () => {
  const { createServer } = await import('node:http')
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/ok' ? 200 : 404, { 'content-type': 'text/plain' })
    res.end(req.url === '/ok' ? 'all good' : 'nope')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`

  withSpec(`
goal: http contract
serve:
  run: "sleep 30"
  ready_url: ${url}
  reuse_existing: true
checks:
  - name: ok route
    http:
      path: /ok
      expect: {status: 200, body_contains: all good}
  - name: bad route
    http:
      path: /missing
      expect: {status: 200}
`)
  const code = await check({ json: true })
  server.close()
  assert.equal(code, 1)
})

test('init discovers npm scripts', () => {
  sandbox()
  writeFileSync('package.json', JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }))
  const out = init('users can log in', { json: true })
  assert.deepEqual(out.discovered, ['build', 'test'])
  assert.deepEqual(loadSpec().checks, [
    { name: 'build', run: 'npm run build' },
    { name: 'test', run: 'npm run test' },
  ])
})

test('loadSpec rejects a spec with no checks', () => {
  withSpec('goal: empty\n')
  assert.throws(() => loadSpec(), /`checks` must be a non-empty list/)
})
