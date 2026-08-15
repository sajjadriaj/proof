import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * The completion gate: the agent runs, and when it exits the contract decides. The agent
 * stops only when the contract passes or an explicit override is given (Ctrl-C or
 * --max-attempts) — its own opinion of doneness never ends the loop.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const guard = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, 'guard', ...args], { cwd: dir, encoding: 'utf8' })
  return { exit: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const FAILING = 'goal: checkout charges 100\nchecks:\n  - name: always fails\n    run: "false"\n'

// `script` runs with PROOF_GUARD_ATTEMPT / PROOF_GUARD_FEEDBACK in its environment and
// leaves ran-<n> markers, so a test can count attempts without trusting guard's output.
const project = ({ spec = FAILING, script = '' } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-guard-'))
  mkdirSync(join(dir, '.proof'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, '.proof/spec.yaml'), spec)
  writeFileSync(join(dir, 'agent.sh'), `#!/bin/sh\ntouch "ran-$PROOF_GUARD_ATTEMPT"\n${script}`)
  chmodSync(join(dir, 'agent.sh'), 0o755)
  return dir
}

const attempts = dir => readdirSync(dir).filter(f => f.startsWith('ran-')).length

test('the loop ends when the contract passes, not when the agent feels done', () => {
  // fumbles twice, then fixes — like an agent reading its feedback
  const dir = project({
    spec: 'goal: the marker says done\nchecks:\n  - name: marker\n    file: {path: marker.txt, contains: "correct"}\n',
  })
  writeFileSync(join(dir, 'agent.sh'),
    '#!/bin/sh\ntouch "ran-$PROOF_GUARD_ATTEMPT"\n'
    + 'case "$PROOF_GUARD_ATTEMPT" in\n'
    + '  1) echo wrong > marker.txt ;;\n'
    + '  2) echo "still wrong" > marker.txt ;;\n'
    + '  *) echo correct > marker.txt ;;\n'
    + 'esac\n')
  chmodSync(join(dir, 'agent.sh'), 0o755)

  const r = guard(dir, '--max-attempts', '5', '--', './agent.sh')
  assert.equal(r.exit, 0, r.out)
  assert.equal(attempts(dir), 3, 'stopped at the pass, not at max')
  assert.match(r.out, /DONE after 3 attempt\(s\)/)
})

test('failure evidence reaches the next attempt', () => {
  const dir = project({
    spec: 'goal: g\nchecks:\n  - name: marker\n    file: {path: marker.txt, contains: "correct"}\n',
    script: '[ -f "$PROOF_GUARD_FEEDBACK" ] && cp "$PROOF_GUARD_FEEDBACK" seen-feedback.md\n'
      + '[ "$PROOF_GUARD_ATTEMPT" = 2 ] && echo correct > marker.txt || true\n',
  })

  const r = guard(dir, '--max-attempts', '3', '--', './agent.sh')
  assert.equal(r.exit, 0, r.out)

  const seen = readFileSync(join(dir, 'seen-feedback.md'), 'utf8')
  assert.match(seen, /# Verification failed \(attempt 1\)/)
  assert.match(seen, /- Expected: marker\.txt exists/)
  assert.match(seen, /the definition of done, not suggestions/)
})

test('and the feedback file is removed once the contract passes', () => {
  // stale feedback beside a green verdict is a lie waiting for the next reader
  const dir = project({
    spec: 'goal: g\nchecks:\n  - name: marker\n    file: {path: marker.txt}\n',
    script: '[ "$PROOF_GUARD_ATTEMPT" = 2 ] && touch marker.txt || true\n',
  })

  assert.equal(guard(dir, '--max-attempts', '3', '--', './agent.sh').exit, 0)
  assert.ok(!existsSync(join(dir, '.proof/feedback.md')))
})

test('--max-attempts is the override: exhausted means exit 1 and says so', () => {
  const dir = project()
  const r = guard(dir, '--max-attempts', '2', '--', './agent.sh')

  assert.equal(r.exit, 1)
  assert.equal(attempts(dir), 2)
  assert.match(r.out, /2 attempt\(s\) used and the contract still fails/)
  assert.match(r.out, /Raise --max-attempts/)
})

test('a broken contract stops guard before the agent ever runs', () => {
  // relaunching an agent at a wall proof already knows about burns attempts for nothing
  const dir = project({ spec: 'goal: g\nchecks:\n  - name: t\n    http: {path: /x, bogus: 1}\n' })
  const r = guard(dir, '--', './agent.sh')

  assert.equal(r.exit, 2)
  assert.match(r.out, /unknown key "bogus"/)
  assert.equal(attempts(dir), 0, 'the agent never started')
})

test('a placeholder contract is refused upfront for the same reason', () => {
  const dir = project({ spec: 'goal: g\nchecks:\n  - name: t\n    run: echo "replace me with a real command"\n' })
  const r = guard(dir, '--', './agent.sh')

  assert.equal(r.exit, 2)
  assert.match(r.out, /still holds proof's own placeholder/)
  assert.equal(attempts(dir), 0)
})

test('an agent that breaks the contract mid-loop aborts instead of iterating', () => {
  // iteration 175's move, made against the gate itself: rewriting the definition of done
  const dir = project({ script: 'printf "goal: [broken\\n" > .proof/spec.yaml\n' })
  const r = guard(dir, '--max-attempts', '5', '--', './agent.sh')

  assert.equal(r.exit, 2)
  assert.equal(attempts(dir), 1, 'no second attempt against a broken contract')
  assert.match(r.out, /not valid YAML/)
})

test('an agent command that does not exist is a usage error, not a crash', () => {
  const dir = project()
  const r = guard(dir, '--', './no-such-agent')

  assert.equal(r.exit, 2)
  assert.match(r.out, /could not run the agent: \.\/no-such-agent — not found/)
})

test('guard with no command says what it needs', () => {
  const dir = project()
  const r = guard(dir)

  assert.equal(r.exit, 2)
  assert.match(r.out, /guard needs the agent command/)
})

test('an agent flag without -- is refused with the fix named', () => {
  const dir = project()
  const r = guard(dir, './agent.sh', '--dangerously-skip')

  assert.equal(r.exit, 2)
  assert.match(r.out, /unknown flag --dangerously-skip/)
  assert.match(r.out, /put the whole command after `--`/)
})

test('{feedback_file} and {feedback} are substituted into the agent arguments', () => {
  const dir = project({
    spec: 'goal: g\nchecks:\n  - name: marker\n    file: {path: marker.txt}\n',
  })
  writeFileSync(join(dir, 'agent.sh'),
    '#!/bin/sh\ntouch "ran-$PROOF_GUARD_ATTEMPT"\nprintf "%s\\n---\\n%s\\n" "$1" "$2" >> args.log\n'
    + '[ "$PROOF_GUARD_ATTEMPT" = 2 ] && touch marker.txt || true\n')
  chmodSync(join(dir, 'agent.sh'), 0o755)

  const r = guard(dir, '--max-attempts', '3', '--', './agent.sh', '{feedback_file}', '{feedback}')
  assert.equal(r.exit, 0, r.out)

  const log = readFileSync(join(dir, 'args.log'), 'utf8')
  assert.match(log, /\.proof\/feedback\.md/)
  assert.match(log, /no verification has run yet/, 'the first attempt says so instead of an empty arg')
  assert.match(log, /Verification failed/, 'the second attempt carries the real feedback inline')
})

test('an agent ended by a signal stops the loop without a verdict', () => {
  const dir = project({ script: 'kill -TERM $$\n' })
  const r = guard(dir, '--max-attempts', '5', '--', './agent.sh')

  assert.equal(r.exit, 1)
  assert.equal(attempts(dir), 1)
  assert.match(r.out, /ended by SIGTERM — stopping without a verdict/)
})

test('--json emits a final machine-readable summary', () => {
  const dir = project({
    spec: 'goal: g\nchecks:\n  - name: marker\n    file: {path: marker.txt}\n',
    script: 'touch marker.txt\n',
  })
  const r = guard(dir, '--json', '--max-attempts', '2', '--', './agent.sh')

  assert.equal(r.exit, 0)
  const summary = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.equal(summary.status, 'passed')
  assert.equal(summary.attempts, 1)
  assert.match(summary.run, /\.proof\/runs\//)
})

test('a regression is named as one in the feedback', () => {
  // "the recent changes broke it" is the sentence an agent needs most
  const dir = project({
    spec: 'goal: g\nchecks:\n  - name: marker\n    file: {path: marker.txt}\n',
    script: 'rm -f marker.txt\n',
  })
  writeFileSync(join(dir, 'marker.txt'), 'x')
  spawnSync(process.execPath, [CLI, 'check'], { cwd: dir })   // run 0001: passes

  guard(dir, '--max-attempts', '1', '--', './agent.sh')       // the agent deletes it
  const feedback = readFileSync(join(dir, '.proof/feedback.md'), 'utf8')
  assert.match(feedback, /Regression: this passed in run 0001 — the recent changes broke it/)
})
