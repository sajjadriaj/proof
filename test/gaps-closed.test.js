import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { batchChecks } from '../src/check.js'
import { flakiness } from '../src/runs.js'
import { junit } from '../src/report.js'
import { validateSpec } from '../src/validate.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const runCli = (dir, args) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { cwd: dir, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ code: err?.code ?? 0, out: stdout + stderr }))
})

const project = (contract, prefix = 'proof-gaps-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), contract)
  return dir
}

const record = (dir, id = '0001') =>
  JSON.parse(readFileSync(join(dir, `.proof/runs/${id}/result.json`), 'utf8'))

// --- skip --------------------------------------------------------------------

test('a skipped check withholds completion instead of disappearing', async () => {
  // The alternative people reach for is deleting the check, which is invisible in the blast
  // radius and leaves the next run reporting DONE.
  const dir = project(`goal: g
checks:
  - name: works
    run: "true"
  - name: quarantined
    run: "false"
    skip: "flaky against the sandbox API — see #412"
`)
  const { code, out } = await runCli(dir, ['check'])

  assert.equal(code, 0, 'a skip is not a failure')
  assert.match(out, /quarantined {2,}SKIP/)
  assert.match(out, /INCOMPLETE/)
  assert.doesNotMatch(out, /DONE\n/)
  assert.match(out, /SKIPPED\n {2}quarantined — flaky against the sandbox API — see #412/)
  assert.match(out, /1 passed, 1 skipped/)

  const r = record(dir)
  assert.equal(r.status, 'partial')
  assert.deepEqual(r.skipped, [{ check: 'quarantined', reason: 'flaky against the sandbox API — see #412' }])
  assert.equal(r.ran_checks, 1, 'a skipped check did not run')
})

test('a skip with no reason is refused', () => {
  const problems = validateSpec({ goal: 'g', checks: [{ name: 'a', run: 'true', skip: true }] })
  assert.match(problems[0], /must be the reason it is skipped/)
})

test('guard refuses to loop against a contract that cannot complete', async () => {
  // `check` reports partial, which guard would never see as a pass — the agent would be
  // relaunched forever over a check the contract itself switched off.
  const dir = project(`goal: g
checks:
  - name: quarantined
    run: "true"
    skip: "waiting on the staging database"
`)
  const { code, out } = await runCli(dir, ['guard', '--max-attempts', '1', '--', 'true'])
  assert.equal(code, 2)
  assert.match(out, /skipped .* every attempt would end without a completion verdict/s)
})

// --- parallel ----------------------------------------------------------------

test('consecutive parallel checks form one batch, and the order is still a barrier', () => {
  const checks = [
    { name: 'seed' },
    { name: 'build', parallel: true },
    { name: 'lint', parallel: true },
    { name: 'assert' },
    { name: 'a', parallel: true },
  ]
  assert.deepEqual(batchChecks(checks).map(b => b.map(e => e.check.name)),
    [['seed'], ['build', 'lint'], ['assert'], ['a']])
})

test('a parallel batch overlaps in time and stays in contract order', async () => {
  const dir = project(`goal: g
checks:
  - name: alpha
    run: sleep 1
    parallel: true
  - name: bravo
    run: sleep 1
    parallel: true
  - name: charlie
    run: sleep 1
    parallel: true
`)
  const started = Date.now()
  const { code } = await runCli(dir, ['check'])
  const elapsed = Date.now() - started

  assert.equal(code, 0)
  assert.ok(elapsed < 2500, `three 1s checks took ${elapsed}ms — they did not overlap`)
  assert.deepEqual(record(dir).results.map(r => r.name), ['alpha', 'bravo', 'charlie'])
})

test('a parallel check cannot capture, because nothing can read it', () => {
  const problems = validateSpec({
    goal: 'g',
    checks: [{ name: 'a', run: 'echo 1', parallel: true, capture: { x: 'output' } }],
  })
  assert.match(problems[0], /`parallel` and `capture` cannot both hold/)
})

// --- timing ------------------------------------------------------------------

test('expect_under_ms fails a check that answered correctly but too late', async () => {
  const dir = project(`goal: g
checks:
  - name: fast enough
    run: "true"
    expect_under_ms: 60000
  - name: too slow
    run: sleep 1
    expect_under_ms: 100
`)
  const { code, out } = await runCli(dir, ['check'])
  assert.equal(code, 1)
  assert.match(out, /Expected:\n {4}a response in under 100ms/)
  assert.match(out, /Observed:\n {4}took \d+ms/)
})

test('a wrong answer is still reported as wrong, not as slow', async () => {
  // Naming the slowness first would hide the failure the check is actually about.
  const dir = project(`goal: g
checks:
  - name: wrong and slow
    run: sleep 1 && exit 3
    expect_under_ms: 100
`)
  const { out } = await runCli(dir, ['check'])
  assert.match(out, /Observed:\n {4}exit 3/)
  assert.doesNotMatch(out, /took \d+ms/)
})

// --- base-url ----------------------------------------------------------------

test('--base-url verifies something already running, and says what it could not check', async () => {
  const server = http.createServer((q, s) => { s.writeHead(200); s.end('live') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const dir = project(`goal: g
serve:
  run: exit 1
  ready_url: http://127.0.0.1:1
checks:
  - name: the deployment answers
    http: {path: /, expect: {status: 200, body_contains: "live"}}
`)
  try {
    const { code, out } = await runCli(dir, ['check', '--base-url', `http://127.0.0.1:${port}`])
    assert.equal(code, 0, out)
    // The serve block was not started, so its three checks are claims proof cannot make.
    const rows = out.split('CHECKS')[1].split('OBSERVED')[0]
    assert.doesNotMatch(rows, /app boots/)
    assert.match(out, /which proof did not start/)
    assert.match(out, /reads proof's own environment rather than that deployment's/)
    assert.equal(record(dir).against, `http://127.0.0.1:${port}`)
  } finally { server.close() }
})

test('a base URL that cannot be fetched is refused before anything runs', async () => {
  const dir = project('goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  const { code, out } = await runCli(dir, ['check', '--base-url', 'localhost:3000'])
  assert.equal(code, 2)
  assert.match(out, /--base-url must be an absolute http\(s\) URL/)
})

// --- flakiness ---------------------------------------------------------------

test('a check whose history holds both outcomes is named', () => {
  const history = ['passed', 'failed', 'passed', 'passed'].map((status, i) => ({
    id: String(i),
    result: { results: [{ name: 'a', asserted: 'X', status }] },
  }))
  assert.deepEqual(flakiness(history, [{ name: 'a', kind: 'run', asserted: 'X', status: 'passed' }]),
    [{ check: 'a', failed: 1, of: 4 }])
})

test('a regression is not a flake, and an edited check is not comparable', () => {
  const allPassed = ['passed', 'passed'].map((status, i) => ({
    id: String(i),
    result: { results: [{ name: 'a', asserted: 'X', status }] },
  }))
  // Passed every time and fails now: that is the change's fault, and calling it a flake
  // would excuse it.
  assert.deepEqual(flakiness(allPassed, [{ name: 'a', kind: 'run', asserted: 'X', status: 'failed' }]), [])

  const mixed = ['passed', 'failed'].map((status, i) => ({
    id: String(i),
    result: { results: [{ name: 'a', asserted: 'OLD', status }] },
  }))
  assert.deepEqual(flakiness(mixed, [{ name: 'a', kind: 'run', asserted: 'NEW', status: 'passed' }]), [])
})

test('a flaky check is reported on a green run, where the false confidence is', async () => {
  const dir = project(`goal: g
checks:
  - name: coin flip
    run: test -f flip.txt
`)
  await runCli(dir, ['check'])                                   // fails: no marker
  writeFileSync(join(dir, 'flip.txt'), '')
  await runCli(dir, ['check'])                                   // passes
  const third = await runCli(dir, ['check'])                     // passes, with both behind it

  assert.equal(third.code, 0)
  assert.match(third.out, /coin flip has not agreed with itself: it failed 1 of the last 2 runs/)
  assert.deepEqual(record(dir, '0003').flaky, [{ check: 'coin flip', failed: 1, of: 2 }])
})

// --- junit -------------------------------------------------------------------

test('a run renders as JUnit XML, with the caveats carried into it', () => {
  const xml = junit({
    status: 'partial',
    goal: 'a & b <c>',
    at: '2026-01-01T00:00:00.000Z',
    advisory: 'nothing asserts content',
    warnings: ['the tree moved'],
    results: [
      { name: 'ok', kind: 'run', status: 'passed', asserted: '`true`, exit 0', ms: 12 },
      { name: 'bad', kind: 'http', status: 'failed', asserted: 'GET /x', ms: 30 },
      { name: 'off', kind: 'run', status: 'skipped', observed: 'waiting on #412', ms: 0 },
    ],
    failures: [{ check: 'bad', expected: 'status 200', observed: 'status 500', output: 'body', evidence: [] }],
  })

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  assert.match(xml, /tests="3" failures="1" skipped="1"/)
  assert.match(xml, /name="a &amp; b &lt;c&gt;"/)
  assert.match(xml, /<testcase name="bad" classname="proof\.http" time="0\.030">/)
  assert.match(xml, /<failure message="status 200">/)
  assert.match(xml, /<skipped message="waiting on #412"\/>/)
  assert.match(xml, /INCOMPLETE — this run makes no completion claim/)
  assert.match(xml, /nothing asserts content/)
})

test('control characters in output cannot break the XML', () => {
  // An ANSI escape in a build log made the whole file unparseable, which a CI reads as
  // "no results" rather than as an encoding problem.
  const xml = junit({
    status: 'failed',
    results: [{ name: 'x', kind: 'run', status: 'failed', ms: 1 }],
    failures: [{ check: 'x', expected: 'e', observed: 'o', output: '[31mred[0m ' }],
  })
  assert.doesNotMatch(xml, /[ --]/)
  assert.match(xml, /red/)
})

test('proof report --junit prints it for a recorded run', async () => {
  const dir = project('goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  await runCli(dir, ['check'])
  const { code, out } = await runCli(dir, ['report', '--junit'])
  assert.equal(code, 0)
  assert.match(out, /<testsuites name="proof"/)
  assert.match(out, /<testcase name="a"/)
})
