import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, describeSignal } from '../src/check.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const run = async checks => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-signals-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', `goal: g\nchecks:\n${checks}`)
  await quiet(() => check({ json: true }))
  return JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
}

test('the regression: a signalled command says which signal, not "exit null"', async () => {
  // A signalled process has no exit code. `exit null` said nothing about the two cases that
  // matter most — the OOM killer and a crash — and read like a bug in proof.
  const r = await run('  - name: killed\n    run: kill -9 $$\n')

  assert.equal(r.failures[0].observed.startsWith('killed by SIGKILL'), true, r.failures[0].observed)
  assert.doesNotMatch(r.failures[0].observed, /null/)
})

test('a crash is distinguishable from a kill', async () => {
  const r = await run('  - name: crashed\n    run: kill -SEGV $$\n')

  assert.match(r.failures[0].observed, /SIGSEGV/)
  assert.match(r.failures[0].observed, /crashed/)
})

test('SIGKILL names its usual cause, which is not the command', async () => {
  // Someone reading "killed by SIGKILL" on a test suite needs to look at memory limits,
  // not at the suite.
  const r = await run('  - name: killed\n    run: kill -9 $$\n')
  assert.match(r.failures[0].observed, /OOM killer or an outer timeout/)
})

test('an ordinary non-zero exit is unchanged', async () => {
  const r = await run('  - name: failed\n    run: exit 3\n')
  assert.equal(r.failures[0].observed, 'exit 3')
})

test('a passing command is unaffected', async () => {
  const r = await run('  - name: fine\n    run: echo ok\n')
  assert.equal(r.status, 'passed')
})

test("proof's own timeout still reports as a timeout, not as the signal it sends", async () => {
  // proof kills the process group on timeout; reporting SIGKILL there would blame the
  // command for something proof did.
  const r = await run('  - name: slow\n    run: sleep 30\n    timeout: 1\n')

  assert.match(r.failures[0].observed, /timed out after 1s/)
  assert.doesNotMatch(r.failures[0].observed, /SIGKILL/)
})

test('an unknown signal is still named', () => {
  assert.equal(describeSignal('SIGUSR1'), 'killed by SIGUSR1')
})

test('the evidence records it too', async () => {
  const r = await run('  - name: killed\n    run: kill -9 $$\n')
  const row = r.results.find(x => x.name === 'killed')

  assert.match(row.observed, /SIGKILL/)
  assert.equal(row.status, 'failed')
})

const bootWith = async (serveRun, port, timeout = 6) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-signals-serve-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml',
    `goal: g\nserve:\n  run: ${serveRun}\n  ready_url: http://127.0.0.1:${port}/\n  timeout: ${timeout}\n`
    + 'checks:\n  - name: api\n    http: {path: /}\n')

  const started = Date.now()
  await quiet(() => check({ json: true }))
  return {
    result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
    elapsed: Date.now() - started,
  }
}

test('the regression: an app that crashes on startup says so, and does not wait out the budget', async () => {
  // A signalled process has no exit code, so the old check saw nothing and polled until the
  // timeout — reporting a crash as slowness, and spending the whole budget to say it.
  const { result, elapsed } = await bootWith('"echo starting; kill -SEGV $$"', 8262, 6)

  assert.match(result.failures[0].observed, /SIGSEGV/)
  assert.match(result.failures[0].observed, /crashed/)
  assert.doesNotMatch(result.failures[0].observed, /not ready/)
  assert.ok(elapsed < 5000, `waited ${elapsed}ms of a 6s budget`)
})

test('the app output leading up to the crash is kept', async () => {
  // The last thing it printed is usually the reason.
  const { result } = await bootWith('"echo connecting to database; kill -SEGV $$"', 8263, 6)
  assert.match(result.failures[0].output ?? '', /connecting to database/)
})

test('a serve command that simply never binds still reports a timeout', async () => {
  // The fix must not turn every boot failure into a signal report.
  const { result } = await bootWith('"sleep 30"', 8264, 3)

  assert.match(result.failures[0].observed, /not ready at .* within 3s/)
  assert.doesNotMatch(result.failures[0].observed, /killed by/)
})

test('the regression: a 128+N exit code names the signal it encodes', async () => {
  // `code 139` is legible only if you know a shell reports a child killed by signal N as
  // 128+N. The app crashing mid-run is exactly when nobody wants to do that arithmetic.
  const { describeExit } = await import('../src/check.js')

  assert.equal(describeExit(139), 'exit 139 — a shell reports SIGSEGV this way')
  assert.equal(describeExit(137), 'exit 137 — a shell reports SIGKILL this way')
  assert.equal(describeExit(130), 'exit 130 — a shell reports SIGINT this way')
})

test('an ordinary exit code is not dressed up as a signal', async () => {
  const { describeExit } = await import('../src/check.js')

  assert.equal(describeExit(0), 'exit 0')
  assert.equal(describeExit(1), 'exit 1')
  assert.equal(describeExit(3), 'exit 3')
  assert.equal(describeExit(127), 'exit 127')
})

test('the annotation is phrased as what a shell reports, not as a claim', async () => {
  // A script may `exit 139` deliberately. Saying "killed by SIGSEGV" would be asserting
  // something proof did not observe.
  const { describeExit } = await import('../src/check.js')
  assert.match(describeExit(139), /a shell reports/)
  assert.doesNotMatch(describeExit(139), /killed by/)
})

test('an app that dies mid-run is reported by the liveness check with the decoded code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-signals-mid-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('server.py',
    'import os, signal, sys\n'
    + 'from http.server import BaseHTTPRequestHandler, HTTPServer\n'
    + 'class H(BaseHTTPRequestHandler):\n'
    + '    def do_GET(self):\n'
    + "        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')\n"
    + "        if self.path == '/boom':\n"
    + '            sys.stdout.flush(); os.kill(os.getpid(), signal.SIGSEGV)\n'
    + '    def log_message(self, *a): pass\n'
    + "HTTPServer(('127.0.0.1', 8272), H).serve_forever()\n")
  writeFileSync('.proof/spec.yaml',
    'goal: g\nserve:\n  run: python3 server.py\n  ready_url: http://127.0.0.1:8272/\n  timeout: 15\n'
    + 'checks:\n  - name: healthy\n    http: {path: /}\n  - name: crashes\n    http: {path: /boom}\n')

  await quiet(() => check({ json: true }))
  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  const liveness = r.results.find(x => x.name === 'app still running')

  assert.equal(liveness.status, 'failed')
  assert.match(liveness.observed, /SIGSEGV/, liveness.observed)
  assert.match(liveness.output ?? '', /Segmentation fault/, 'the app said so too')
})
