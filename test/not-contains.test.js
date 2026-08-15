import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Verifying a removal — the debug log, the hardcoded key, the TODO the agent promised to
 * delete — had no verb. `run: "! grep -q ..."` expresses it but fails with `exit 1`.
 *
 * One contract, one run: these are assertions about a single `proof check`, not six.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const CHUNK = 65536
const BOUNDARY = 'sk-live-boundary'

const project = spec => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-notcontains-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, 'dirty.js'), 'OK\nconst KEY = "sk-live-abc-SURROUNDING"\n')
  writeFileSync(join(dir, 'clean.js'), 'const KEY = process.env.KEY\n')
  writeFileSync(join(dir, 'big.js'), 'x'.repeat(CHUNK - 8) + BOUNDARY + 'y'.repeat(100))
  writeFileSync(join(dir, '.proof/spec.yaml'), spec)
  return dir
}

const check = dir => {
  const r = spawnSync(process.execPath, [CLI, 'check', '--json'], { cwd: dir, encoding: 'utf8' })
  // `code` in the JSON is the error code; keep the exit status under its own name
  return { exit: r.status, raw: r.stdout, ...JSON.parse(r.stdout) }
}

const CONTRACT = `goal: the hardcoded key was removed
checks:
  - name: still there
    file: {path: dirty.js, not_contains: "sk-live"}
  - name: removed
    file: {path: clean.js, not_contains: "sk-live"}
  - name: missing file
    file: {path: gone.js, not_contains: "sk-live"}
  - name: both directions
    file: {path: dirty.js, contains: "OK", not_contains: "sk-live"}
  - name: across a chunk boundary
    file: {path: big.js, not_contains: "${BOUNDARY}"}
`

const only = (out, name) => out.results.find(r => r.name === name)

test('not_contains, end to end', () => {
  const out = check(project(CONTRACT))
  assert.equal(out.exit, 1)

  const still = only(out, 'still there')
  assert.equal(still.status, 'failed', 'the string is present, so the removal did not happen')
  assert.equal(still.expected, 'dirty.js does not contain "sk-live"')
  assert.equal(still.observed, 'still present')

  assert.equal(only(out, 'removed').status, 'passed')

  // "the secret is not in a file that does not exist" is true and worthless: renaming the
  // file would turn a removal check green without anything being removed.
  const missing = only(out, 'missing file')
  assert.equal(missing.status, 'failed')
  assert.equal(missing.observed, 'not found')

  // the streaming scanner carries an overlap between reads; not_contains inherits it, or a
  // secret landing on a chunk boundary reads as removed
  assert.equal(only(out, 'across a chunk boundary').status, 'failed')

  assert.match(only(out, 'both directions').asserted, /contains "OK", does not contain "sk-live"/)
})

test('the matched line is never echoed — not_contains is aimed at secrets', () => {
  // evidence bundles get shared
  const out = check(project(CONTRACT))
  assert.match(out.raw, /sk-live/, 'the needle itself is reported — it is in the contract already')
  assert.doesNotMatch(out.raw, /SURROUNDING/)
})

const invalid = spec => {
  const r = spawnSync(process.execPath, [CLI, 'check', '--json'], { cwd: project(spec), encoding: 'utf8' })
  return { exit: r.status, ...JSON.parse(r.stdout) }
}

test('exists: false and not_contains cannot both hold', () => {
  // the runner returns on the absent branch before reading, so the not_contains would
  // never run — and the check would pass with an assertion the author wrote untested
  const out = invalid('goal: g\nchecks:\n  - name: x\n    file: {path: a.js, exists: false, not_contains: "k"}\n')

  assert.equal(out.exit, 2)
  assert.equal(out.code, 'EBADSPEC')
  assert.match(out.error, /`exists: false` and `not_contains` cannot both hold/)
})

test('a near-miss key is named, not silently ignored', () => {
  const out = invalid('goal: g\nchecks:\n  - name: x\n    file: {path: a.js, not_contain: "k"}\n')
  assert.match(out.error, /unknown key "not_contain" — did you mean "not_contains"\?/)
})

test('an empty not_contains is refused — it matches everything', () => {
  const out = invalid('goal: g\nchecks:\n  - name: x\n    file: {path: a.js, not_contains: ""}\n')
  assert.equal(out.exit, 2)
})

/**
 * The response-side removal: a stack trace that should no longer leak, a debug banner, an
 * admin link a normal user must not see. There is no `run:` workaround for this one — it
 * needs the app proof already started.
 */
const APP = `import http from 'node:http'
http.createServer((q, s) => {
  if (q.url === '/leaky') { s.writeHead(500); return s.end('<pre>at Object.foo (/app/src/db.js:42)</pre>') }
  s.writeHead(200); s.end('<h1>Something went wrong</h1>')
}).listen(PORT)
`

const app = (port, expects) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-bnc-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, 'server.mjs'), APP.replace('PORT', String(port)))
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: internal paths are no longer leaked in error pages\n'
    + `serve:\n  run: node server.mjs\n  ready_url: http://127.0.0.1:${port}/\n  timeout: 20\nchecks:\n`
    + expects)
  return dir
}

test('body_not_contains catches a response that still leaks', () => {
  const out = check(app(8373,
    '  - name: error page\n    http:\n      path: /leaky\n'
    + '      expect: {status: 500, body_not_contains: "/app/src"}\n'))

  const r = only(out, 'error page')
  assert.equal(r.status, 'failed')
  assert.equal(r.expected, 'body does not contain "/app/src"')
  assert.equal(r.observed, 'still present')
  assert.match(r.asserted, /body does not contain "\/app\/src"/)
})

test('and passes on a response that does not', () => {
  const out = check(app(8374,
    '  - name: clean page\n    http:\n      path: /\n'
    + '      expect: {status: 200, body_not_contains: "/app/src"}\n'))

  assert.equal(only(out, 'clean page').status, 'passed')
})

test('it does not silence the content advisory — absence is not evidence', () => {
  // `body_contains` proves the response carries the requirement. `body_not_contains` proves
  // one thing is missing from it, which leaves "a 200 with the wrong body" entirely open.
  const out = check(app(8375,
    '  - name: clean page\n    http:\n      path: /\n'
    + '      expect: {status: 200, body_not_contains: "/app/src"}\n'))

  assert.equal(out.status, 'passed')
  assert.match(out.advisory ?? '', /asserts what the app actually returned/)
})

test('while body_contains still does', () => {
  const out = check(app(8376,
    '  - name: clean page\n    http:\n      path: /\n'
    + '      expect: {status: 200, body_contains: "went wrong"}\n'))

  assert.equal(out.status, 'passed')
  assert.equal(out.advisory, null)
})
