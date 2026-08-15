import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { check } from '../src/check.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

/**
 * A launcher that starts the app in the background and exits 0 — the shape of
 * `docker compose up -d`, `pm2 start`, and every other detaching start command.
 */
const project = (port, launcher) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-detached-'))
  process.chdir(dir)
  mkdirSync('.proof')

  writeFileSync('server.py',
    'import json\n'
    + 'from http.server import BaseHTTPRequestHandler, HTTPServer\n'
    + 'class H(BaseHTTPRequestHandler):\n'
    + '    def do_GET(self):\n'
    + "        self.send_response(200); self.send_header('content-type','application/json'); self.end_headers()\n"
    + '        self.wfile.write(json.dumps({"ok": True}).encode())\n'
    + '    def log_message(self, *a): pass\n'
    + `HTTPServer(('127.0.0.1', ${port}), H).serve_forever()\n`)

  writeFileSync('up.sh', launcher)
  chmodSync('up.sh', 0o755)
  writeFileSync('.proof/spec.yaml',
    `goal: the api answers\nserve:\n  run: ./up.sh\n  ready_url: http://127.0.0.1:${port}/\n  timeout: 20\n`
    + 'checks:\n  - name: api\n    http: {path: /, expect: {status: 200, json: {ok: true}}}\n')
  return dir
}

const result = dir => JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
const stop = port => { try { execFileSync('pkill', ['-f', `server.py`], { stdio: 'ignore' }) } catch {} }

test('the regression: a launcher that exits 0 after starting the app is not a boot failure', async () => {
  // `docker compose up -d` does exactly this. Treating the exit as failure meant proof
  // declared the app dead without ever asking the URL — for a shape the README documents.
  const port = 8241
  const dir = project(port, '#!/bin/bash\nnohup python3 server.py > /dev/null 2>&1 &\necho started\nexit 0\n')
  try {
    const code = await quiet(() => check({ json: true }))
    assert.equal(code, 0, JSON.stringify(result(dir).failures))
    assert.equal(result(dir).checks.api, 'passed')
  } finally { stop(port) }
})

test('the run says the app is still up, because proof cannot stop it', async () => {
  // proof kills the process group it spawned; the app is outside it. Silence would leave a
  // server running after a command that looks like it cleaned up after itself.
  const port = 8242
  const dir = project(port, '#!/bin/bash\nnohup python3 server.py > /dev/null 2>&1 &\nexit 0\n')
  try {
    await quiet(() => check({ json: true }))
    const warning = result(dir).warnings.find(w => w.includes('outside the process group'))

    assert.ok(warning, JSON.stringify(result(dir).warnings))
    assert.match(warning, /stopping it is yours to do/)
  } finally { stop(port) }
})

test('a launcher that fails is still a boot failure, with its exit code', async () => {
  const port = 8243
  const dir = project(port, '#!/bin/bash\necho "compose file not found" >&2\nexit 7\n')

  assert.equal(await quiet(() => check({ json: true })), 1)
  assert.match(result(dir).failures[0].observed, /exited early \(code 7\)/)
})

test('a launcher that exits 0 and starts nothing says what it looked for', async () => {
  // Distinct from a non-zero exit: the command reported success, so the useful thing to
  // report is that nothing answered where proof was told to look.
  const port = 8244
  const dir = project(port, '#!/bin/bash\necho "nothing to do"\nexit 0\n')
  // a short budget: this case waits out the whole timeout by design
  writeFileSync(join(dir, '.proof/spec.yaml'),
    readFileSync(join(dir, '.proof/spec.yaml'), 'utf8').replace('timeout: 20', 'timeout: 3'))

  assert.equal(await quiet(() => check({ json: true })), 1)
  const observed = result(dir).failures[0].observed
  assert.match(observed, /exited 0 without anything answering/)
  assert.match(observed, new RegExp(String(port)))
})

test('a foreground server is unaffected and carries no such warning', async () => {
  const port = 8245
  const dir = project(port, '#!/bin/bash\nexec python3 server.py\n')
  try {
    assert.equal(await quiet(() => check({ json: true })), 0)
    assert.equal(result(dir).warnings.filter(w => w.includes('outside the process group')).length, 0)
  } finally { stop(port) }
})

const withLogGate = (port, launcher) => {
  const dir = project(port, launcher)
  writeFileSync(join(dir, '.proof/spec.yaml'),
    `goal: the api answers without errors\nserve:\n  run: ./up.sh\n  ready_url: http://127.0.0.1:${port}/\n`
    + '  timeout: 20\n  log_must_not_match: "ERROR"\n'
    + 'checks:\n  - name: api\n    http: {path: /, expect: {status: 200}}\n')
  return dir
}

test('the regression: a log gate proof cannot read does not pass', async () => {
  // The launcher took the app's output with it, so proof scanned an empty log and reported
  // "no matching log lines" — passing a gate written precisely to catch what was in the log
  // it never saw. The app was logging ERROR on every request.
  const port = 8246
  const dir = withLogGate(port,
    '#!/bin/bash\nnohup python3 noisy.py > app.log 2>&1 &\nexit 0\n')

  writeFileSync(join(dir, 'noisy.py'),
    'import json, sys\n'
    + 'from http.server import BaseHTTPRequestHandler, HTTPServer\n'
    + 'class H(BaseHTTPRequestHandler):\n'
    + '    def do_GET(self):\n'
    + '        print("ERROR: database connection lost", file=sys.stderr, flush=True)\n'
    + "        self.send_response(200); self.end_headers(); self.wfile.write(b'{}')\n"
    + '    def log_message(self, *a): pass\n'
    + `HTTPServer(('127.0.0.1', ${port}), H).serve_forever()\n`)

  try {
    assert.equal(await quiet(() => check({ json: true })), 1, 'the gate cannot be satisfied silently')
    const gate = result(dir).results.find(r => r.name === 'app logs clean')

    assert.equal(gate.status, 'failed')
    assert.match(gate.observed, /proof has no log to check/)
    assert.match(gate.observed, /Run the app in the foreground/, 'and how to make it checkable')
  } finally {
    try { execFileSync('pkill', ['-f', 'noisy.py'], { stdio: 'ignore' }) } catch {}
  }
})

test('a foreground app still has its log gate applied for real', async () => {
  // The fix must not turn every log gate into a failure.
  const port = 8247
  const dir = withLogGate(port, '#!/bin/bash\nexec python3 server.py\n')
  try {
    assert.equal(await quiet(() => check({ json: true })), 0)
    assert.equal(result(dir).results.find(r => r.name === 'app logs clean').status, 'passed')
  } finally { stop(port) }
})

test('a foreground app that logs the forbidden pattern still fails on it', async () => {
  const port = 8248
  const dir = withLogGate(port, '#!/bin/bash\necho "ERROR: boom" >&2\nexec python3 server.py\n')
  try {
    assert.equal(await quiet(() => check({ json: true })), 1)
    const gate = result(dir).results.find(r => r.name === 'app logs clean')

    assert.equal(gate.status, 'failed')
    assert.match(gate.observed, /ERROR: boom/, 'the offending line itself, not a caveat')
  } finally { stop(port) }
})

test('a detached app with no log gate is unaffected', async () => {
  const port = 8249
  const dir = project(port, '#!/bin/bash\nnohup python3 server.py > /dev/null 2>&1 &\nexit 0\n')
  try {
    assert.equal(await quiet(() => check({ json: true })), 0)
    assert.ok(!result(dir).results.some(r => r.name === 'app logs clean'))
  } finally { stop(port) }
})
