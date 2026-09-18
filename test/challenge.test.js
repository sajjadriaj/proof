import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import YAML from 'yaml'

// `falsify` asks whether the contract tells the old code from the new. This asks the other
// question: would it notice a version of the change that is wrong? A fault the contract
// accepts is a class of bug this contract cannot report.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const flat = out => out.replace(/\s+/g, ' ')

/** A committed repository whose one behaviour is readable from a file. */
const repo = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-chal-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, 'app.txt'), 'token: single-use\n')
  writeFileSync(join(dir, '.proof', 'spec.yaml'), contract)
  g('init', '-q', '-b', 'main', '.')
  g('config', 'user.email', 't@t.t')
  g('config', 'user.name', 't')
  g('add', '-A')
  g('commit', '-qm', 'base')
  return dir
}

const CONTRACT = `goal: tokens are single use
criteria:
  - id: AC1
    requirement: a token cannot be reused
checks:
  - name: the token is single use
    satisfies: [AC1]
    file: {path: app.txt, contains: "single-use"}
challenges:
  - name: allow token reuse
    breaks: [AC1]
    apply: "printf 'token: reusable\\n' > app.txt"
`

test('a fault the contract catches is DETECTED, and says which check caught it', () => {
  const r = proof(repo(CONTRACT), 'challenge')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /allow token reuse\s+DETECTED\s+the token is single use/)
  assert.match(r.out, /1 detected, 0 missed, 0 inconclusive/)
})

test('a fault the contract accepts is the finding: MISSED, exit 1, counterexample on disk', () => {
  const dir = repo(`goal: tokens are single use
criteria:
  - id: AC1
    requirement: a token cannot be reused
checks:
  - name: the file is there
    satisfies: [AC1]
    file: app.txt
challenges:
  - name: allow token reuse
    breaks: [AC1]
    apply: "printf 'token: reusable\\n' > app.txt"
`)

  const r = proof(dir, 'challenge')
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /allow token reuse\s+MISSED/)
  assert.match(flat(r.out), /it cannot report this class of wrong implementation/)

  const file = join(dir, '.proof', 'counterexamples', 'allow-token-reuse.yaml')
  assert.ok(existsSync(file), 'the counterexample is kept')
  const kept = YAML.parse(readFileSync(file, 'utf8'))
  assert.equal(kept.criterion, 'AC1')
  assert.match(kept.apply, /printf/)
  assert.equal(kept.expected, 'at least one check fails')
})

test('a fault that changes nothing is inconclusive, never a missed detection', () => {
  // The worst possible reading of MISSED: the contract passed because the code was never
  // broken, reported as a contract that cannot see this class of bug.
  const dir = repo(`goal: g
checks:
  - name: the token is single use
    file: {path: app.txt, contains: "single-use"}
challenges:
  - name: a pattern that matches nothing
    apply: "sed -i 's/nothing-here/other/' app.txt"
`)

  const r = proof(dir, 'challenge')
  assert.match(r.out, /a pattern that matches nothing\s+INCONCLUSIVE/)
  assert.match(flat(r.out), /the fault command changed no files/)
  assert.equal(r.code, 0)
  assert.ok(!existsSync(join(dir, '.proof', 'counterexamples')), 'nothing is recorded as a miss')
})

test('a fault command that fails is inconclusive rather than counted either way', () => {
  const dir = repo(`goal: g
checks:
  - name: the token is single use
    file: {path: app.txt, contains: "single-use"}
challenges:
  - name: a command that is not there
    apply: "definitely-not-a-command --break-it"
`)
  const r = proof(dir, 'challenge')
  assert.match(r.out, /a command that is not there\s+INCONCLUSIVE/)
  assert.match(flat(r.out), /the fault command exited/)
})

test('challenges are refused while the contract does not pass on the code as it stands', () => {
  const dir = repo(`goal: g
checks:
  - name: something that is not true yet
    file: {path: app.txt, contains: "not in this file"}
challenges:
  - name: allow token reuse
    apply: "printf 'token: reusable\\n' > app.txt"
`)
  const r = proof(dir, 'challenge')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /does not pass on your code as it stands/)
})

test('the working tree is never touched — the fault lives in a copy', () => {
  const dir = repo(CONTRACT)
  proof(dir, 'challenge')
  assert.equal(readFileSync(join(dir, 'app.txt'), 'utf8'), 'token: single-use\n')
  // and nothing is left registered with git
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' })
  assert.equal(worktrees.trim().split('\n').length, 1, worktrees)
})

test('uncommitted work is what gets challenged, not the last commit', () => {
  const dir = repo(CONTRACT)
  // The behaviour only exists in the working tree; a challenge against HEAD would be about
  // code the author has already moved past.
  writeFileSync(join(dir, 'app.txt'), 'token: single-use, rotated\n')
  const r = proof(dir, 'challenge')
  assert.match(r.out, /tracked changes at [0-9a-f]{12}/)
  assert.match(r.out, /DETECTED/)
})

test('a detection by a check that carries no criterion is named as such', () => {
  const dir = repo(`goal: g
criteria:
  - id: AC1
    requirement: a token cannot be reused
checks:
  - name: the token is single use
    satisfies: [AC1]
    file: {path: app.txt, contains: "single-use"}
  - name: an unrelated guard
    file: {path: app.txt, contains: "token"}
challenges:
  - name: drop the token line entirely
    breaks: [AC1]
    apply: "printf 'nothing\\n' > app.txt"
`)
  const r = proof(dir, 'challenge')
  assert.match(r.out, /DETECTED/)
  // Both checks fail here, and one of them carries AC1 — so no weakness note about attribution.
  assert.doesNotMatch(flat(r.out), /but not as that requirement failing/)
})

test('a generator supplies faults, and proof is what judges them', () => {
  const dir = repo(`goal: g
checks:
  - name: the token is single use
    file: {path: app.txt, contains: "single-use"}
`)
  const gen = join(dir, 'propose.sh')
  writeFileSync(gen, `#!/bin/sh\ncat <<'JSON'\n[{"name": "proposed reuse", "apply": "printf 'token: reusable\\n' > app.txt"}]\nJSON\n`, { mode: 0o755 })

  const r = proof(dir, 'challenge', '--from', './propose.sh')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /proposed reuse\s+DETECTED/)

  const record = JSON.parse(readFileSync(join(dir, '.proof', 'challenges.json'), 'utf8'))
  assert.equal(record.records['.proof/spec.yaml'].results[0].source, 'generated')
})

test('a generator that prints something other than challenges is refused', () => {
  const dir = repo(`goal: g
checks:
  - name: the token is single use
    file: {path: app.txt, contains: "single-use"}
`)
  const r = proof(dir, 'challenge', '--from', 'echo not json')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /did not print JSON/)
})

test('a contract with no challenges says so rather than reporting a strong contract', () => {
  const dir = repo(`goal: g
checks:
  - name: the token is single use
    file: {path: app.txt, contains: "single-use"}
`)
  const r = proof(dir, 'challenge')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /declares no challenges/)
})

test('promote turns a counterexample into a check proof then refuses to run', () => {
  const dir = repo(`goal: g
criteria:
  - id: AC1
    requirement: a token cannot be reused
checks:
  - name: the file is there
    satisfies: [AC1]
    file: app.txt
challenges:
  - name: allow token reuse
    breaks: [AC1]
    apply: "printf 'token: reusable\\n' > app.txt"
`)
  proof(dir, 'challenge')
  const [id] = readdirSync(join(dir, '.proof', 'counterexamples')).map(f => f.replace(/\.yaml$/, ''))

  const promoted = proof(dir, 'promote', id)
  assert.equal(promoted.code, 0, promoted.out)

  const spec = YAML.parse(readFileSync(join(dir, '.proof', 'spec.yaml'), 'utf8'))
  const added = spec.checks.find(c => c.name.startsWith('counterexample:'))
  assert.ok(added, 'the check is in the contract')
  assert.deepEqual(added.satisfies, ['AC1'])

  // The assertion is the thing proof cannot write, so the contract is unfinished until it is.
  const r = proof(dir, 'check')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /still Proof's own placeholder/)

  // Promoting twice does not write it twice.
  assert.match(proof(dir, 'promote', id).out, /already has a check named/)
})

test('promote with no id lists what there is to promote', () => {
  const dir = repo(CONTRACT)
  const r = proof(dir, 'promote')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /no counterexamples recorded yet/)
})

test('a file git has not seen yet is in the copy — half of a change is new files', () => {
  // The failure this exists for: every new module missing from the copy, so the contract fails
  // there for a reason that has nothing to do with any fault.
  const dir = repo(`goal: g
checks:
  - name: the new module is there
    file: {path: new-module.txt, contains: "brand new"}
challenges:
  - name: empty the new module
    apply: "printf 'gone\\n' > new-module.txt"
`)
  writeFileSync(join(dir, 'new-module.txt'), 'brand new\n')   // never added to git

  const r = proof(dir, 'challenge')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /empty the new module\s+DETECTED/)
})

test('an ignored file is not in the copy, and the run says so', () => {
  const dir = repo(CONTRACT)
  writeFileSync(join(dir, '.gitignore'), 'secrets.txt\n')
  writeFileSync(join(dir, 'secrets.txt'), 'not code under test\n')

  const r = proof(dir, 'challenge')
  assert.equal(r.code, 0, r.out)
  assert.match(flat(r.out), /anything your .gitignore excludes is not in it/)
})
