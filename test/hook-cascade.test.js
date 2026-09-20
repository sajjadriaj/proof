import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * The hook's one-line summary should name the cause, not count the consequences.
 *
 * A fixture that cannot reach the app fails one check and leaves every check that captures
 * from it with nothing to substitute. That was reported as "18 check(s) failed" followed by
 * seventeen identical `no value for ${api_key}` lines, and the one sentence that mattered —
 * the fixture got ECONNREFUSED — sat at the top of a wall the reader had to get past.
 *
 * The downstream checks here use `file:` rather than `run:` on purpose. A shell command keeps
 * whatever proof did not capture — `run: ./verify.sh ${id}` substitutes what it has and leaves
 * the rest to the shell — so a `${var}` that only appears in a command never takes the
 * unmet-dependency path. Every other field does.
 */
const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

// The hook reads its payload on stdin, so every call has to supply one — without it the
// process waits for input that never comes.
const HOOK_INPUT = JSON.stringify({ session_id: 's', hook_event_name: 'Stop', stop_hook_active: false })

const proof = (dir, args, input) =>
  spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', input: input ?? '' })

test('the summary names the check that failed, not the ones that could not run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-cascade-'))
  mkdirSync(join(dir, '.proof'), { recursive: true })
  writeFileSync(join(dir, '.proof/spec.yaml'), `goal: the thing works
criteria:
  - id: AC1
    requirement: the thing works
checks:
  - name: the fixture exists
    run: "false"
    capture:
      token: "match:TOKEN=(.*)"
  - name: the first thing
    satisfies: [AC1]
    file: "\${token}.txt"
  - name: the second thing
    satisfies: [AC1]
    file: "\${token}.txt"
`)

  const r = proof(dir, ['hook', '--max-attempts', '3'], HOOK_INPUT)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const decision = JSON.parse(r.stdout)

  // One real failure, named. The two that never ran are counted, not listed.
  const summary = decision.reason.split('\n')[0]
  assert.match(summary, /1 check\(s\) failed: the fixture exists/)
  assert.match(summary, /2 more could not run without it/)
  assert.doesNotMatch(summary, /the first thing/)
})
