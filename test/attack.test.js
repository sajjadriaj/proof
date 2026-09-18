import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import YAML from 'yaml'
import { classify, RESULT, rng, suggestionsFor, BOUNDARY_VALUES, parseBudget } from '../src/attack.js'
import { evaluate, terms, invariantProblem } from '../src/invariant.js'
import { validateSpec } from '../src/validate.js'

// The finding this whole file is about: the contract passes, the claim is violated, and nothing
// else in the tool can see it. A race on a single-use token is the smallest honest example —
// two requests in flight at once, both winning, and a contract that only ever asked twice in a
// row.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const flat = out => out.replace(/\s+/g, ' ')

/** The port the most recent project was built on, for tests that rewrite its server. */
let lastPort = 0

/** A token server with a read-then-write window, or without one. */
const server = (port, { racy }) => `import http from 'node:http'
const issued = new Set(), used = new Set()
let n = 100
const read = q => new Promise(r => { let b = ''; q.on('data', d => b += d).on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } }) })
http.createServer(async (q, s) => {
  const json = (code, body) => { s.writeHead(code, {'content-type': 'application/json'}); s.end(JSON.stringify(body)) }
  if (q.url === '/issue' && q.method === 'POST') { const t = 'tok-' + (n++); issued.add(t); return json(200, {token: t}) }
  if (q.url === '/redeem' && q.method === 'POST') {
    const { token } = await read(q)
    if (typeof token !== 'string' || !issued.has(token)) return json(401, {error: 'unknown token'})
    if (used.has(token)) return json(401, {error: 'already used'})
    ${racy ? "await new Promise(r => setTimeout(r, 5)); used.add(token)" : "used.add(token); await new Promise(r => setTimeout(r, 5))"}
    return json(200, {ok: true})
  }
  json(404, {})
}).listen(${port})
`

const CONTRACT = port => `goal: a reset token can only be redeemed once
serve:
  run: node s.mjs
  ready_url: http://127.0.0.1:${port}/issue
  timeout: 20
criteria:
  - id: AC1
    requirement: a reset token cannot be redeemed twice
    attack:
      surfaces: [concurrency, sequence]
      setup:
        - name: issue
          http: {method: POST, path: /issue}
          capture: {token: json.token}
      actions:
        - name: redeem
          http: {method: POST, path: /redeem, body: {token: "\${token}"}}
      invariants:
        - successful_redeem <= 1
checks:
  - name: a token is issued
    http: {method: POST, path: /issue, expect: {status: 200}}
    capture: {t: json.token}
  - name: redeeming a fresh token works
    http: {method: POST, path: /redeem, body: {token: "\${t}"}, expect: {status: 200, json: {ok: true}}}
  - name: redeeming the same token again is refused
    satisfies: [AC1]
    http: {method: POST, path: /redeem, body: {token: "\${t}"}, expect: {status: 401}}
`

// Ports are per-test so the suite can run these without them colliding with each other.
let nextPort = 8710
const project = ({ racy = true, contract } = {}) => {
  const port = nextPort++
  lastPort = port
  const dir = mkdtempSync(join(tmpdir(), 'proof-attack-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, 's.mjs'), server(port, { racy }))
  writeFileSync(join(dir, '.proof', 'spec.yaml'), (contract ?? CONTRACT)(port))
  g('init', '-q', '-b', 'main', '.')
  g('config', 'user.email', 't@t.t')
  g('config', 'user.name', 't')
  g('add', '-A')
  g('commit', '-qm', 'base')
  return dir
}

test('the contract passes on the racy app — which is why an attack is needed at all', () => {
  const dir = project({ racy: true })
  const r = proof(dir, 'check')
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /VERDICT\n {2}DONE/)
  assert.match(r.out, /AC1\s+a reset token cannot be redeemed twice\s+VERIFIED/)
})

test('a scenario the contract accepts and the claim forbids is a VERIFICATION_GAP', () => {
  const dir = project({ racy: true })
  const r = proof(dir, 'attack')

  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /VERIFICATION_GAP/)
  assert.match(r.out, /successful_redeem was 2/)
  assert.match(r.out, /redeeming the same token again is refused: PASSED/)
  assert.match(flat(r.out), /The checks that carry this criterion passed while it was violated/)
  assert.match(r.out, /VERDICT\n {2}VERIFICATION GAP FOUND/)
})

test('the counterexample carries both oracles, the seed and the minimized steps', () => {
  const dir = project({ racy: true })
  proof(dir, 'attack')

  const [file] = readdirSync(join(dir, '.proof', 'counterexamples'))
  const kept = YAML.parse(readFileSync(join(dir, '.proof', 'counterexamples', file), 'utf8'))

  assert.equal(kept.criterion, 'AC1')
  assert.equal(kept.classification, 'VERIFICATION_GAP')
  assert.equal(kept.contract_result, 'PASS')
  assert.equal(kept.requirement_result, 'VIOLATED')
  assert.equal(kept.invariant, 'successful_redeem <= 1')
  assert.equal(kept.result, 'successful_redeem = 2')
  assert.ok(Number.isInteger(kept.seed))
  // Minimized: two at once is the claim; more of them is the same claim louder.
  assert.deepEqual(kept.steps, [{ parallel: ['redeem', 'redeem'] }])
})

test('an app without the race yields no counterexample, and the report says what that means', () => {
  const dir = project({ racy: false })
  const r = proof(dir, 'attack')

  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /NO COUNTEREXAMPLE FOUND/)
  assert.match(flat(r.out), /This does not establish correctness/)
  assert.match(r.out, /candidates evaluated: \d+/)
  assert.match(r.out, /seed: \d+/)
  assert.ok(!existsSync(join(dir, '.proof', 'counterexamples')), 'nothing is recorded as a finding')
})

test('replay reproduces the counterexample, and stops once the bug is fixed', () => {
  const dir = project({ racy: true })
  const port = lastPort
  proof(dir, 'attack')
  const id = readdirSync(join(dir, '.proof', 'counterexamples'))[0].replace('.yaml', '')

  const reproduced = proof(dir, 'replay', id)
  assert.equal(reproduced.code, 1, reproduced.out)
  assert.match(reproduced.out, /COUNTEREXAMPLE REPRODUCED/)

  // The same app with the window closed: the scenario is unchanged, the behaviour is not.
  writeFileSync(join(dir, 's.mjs'), server(port, { racy: false }))

  const fixed = proof(dir, 'replay', id)
  assert.equal(fixed.code, 0, fixed.out)
  assert.match(fixed.out, /NOT REPRODUCED/)

  // Kept either way: a scenario that stops reproducing is a record, not a mistake.
  const kept = YAML.parse(readFileSync(join(dir, '.proof', 'counterexamples', `${id}.yaml`), 'utf8'))
  assert.equal(kept.last_replay.reproduced, false)
})

test('a promoted counterexample is a check that fails while the scenario still reproduces', () => {
  const dir = project({ racy: true })
  proof(dir, 'attack')
  const id = readdirSync(join(dir, '.proof', 'counterexamples'))[0].replace('.yaml', '')

  assert.equal(proof(dir, 'promote', id).code, 0)
  const spec = YAML.parse(readFileSync(join(dir, '.proof', 'spec.yaml'), 'utf8'))
  const added = spec.checks.find(c => c.name.startsWith('counterexample:'))
  assert.ok(added, 'the check is in the contract')
  assert.deepEqual(added.satisfies, ['AC1'])
  assert.match(added.run, new RegExp(`proof replay ${id}`))
})

test('a criterion that declares no attack surface is named, not silently skipped', () => {
  const dir = project({
    contract: port => CONTRACT(port).replace(/    attack:[\s\S]*?        - successful_redeem <= 1\n/, ''),
  })
  const r = proof(dir, 'attack')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /no criterion in this contract declares an attack surface/)
})

test('a criterion that is not declared at all is refused by name', () => {
  const r = proof(project(), 'attack', 'AC9')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /no criterion "AC9" is declared \(have: AC1\)/)
})

test('a contract that starts nothing has nothing to attack, and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-attack-none-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof', 'spec.yaml'), 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  const r = proof(dir, 'attack')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /there is no running application to attack/)
})

test('the same seed searches in the same order', () => {
  const dir = project({ racy: false })
  const a = proof(dir, 'attack', '--seed', '4242', '--budget', '30s')
  const b = proof(dir, 'attack', '--seed', '4242', '--budget', '30s')
  assert.match(a.out, /seed: 4242/)
  assert.equal(
    a.out.match(/candidates evaluated: (\d+)/)[1],
    b.out.match(/candidates evaluated: (\d+)/)[1],
  )
})

test('--strategy runs one surface, and an unknown one is refused', () => {
  const dir = project({ racy: true })
  const only = proof(dir, 'attack', '--strategy', 'sequence')
  assert.match(only.out, /strategies: sequence/)

  const bad = proof(dir, 'attack', '--strategy', 'telepathy')
  assert.equal(bad.code, 2)
  assert.match(flat(bad.out), /--strategy takes one of input, sequence, concurrency/)
})

test('a generator proposes candidates and proof judges them', () => {
  const dir = project({ racy: true })
  writeFileSync(join(dir, 'propose.sh'),
    '#!/bin/sh\ncat <<\'JSON\'\n[{"hypothesis": "both at once", "steps": [{"parallel": ["redeem", "redeem"]}]}]\nJSON\n',
    { mode: 0o755 })

  const r = proof(dir, 'attack', '--from', './propose.sh')
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /VERIFICATION_GAP/)
  assert.match(r.out, /strategies: generated/)
})

test('a generator cannot invent operations the criterion never declared', () => {
  const dir = project({ racy: true })
  writeFileSync(join(dir, 'propose.sh'),
    '#!/bin/sh\necho \'[{"hypothesis": "h", "steps": [{"action": "drop_database"}]}]\'\n', { mode: 0o755 })

  const r = proof(dir, 'attack', '--from', './propose.sh')
  assert.equal(r.code, 2)
  assert.match(flat(r.out), /uses action "drop_database", which this criterion does not declare/)
})

test('an attack finding blocks `proof done`, gap or violation', () => {
  const dir = project({ racy: true })
  proof(dir, 'check')
  proof(dir, 'attack')

  const r = proof(dir, 'done')
  assert.equal(r.code, 1)
  assert.match(flat(r.out), /satisfies the contract and violates AC1/)
  assert.match(r.out, /Verification gaps {7}1 \(AC1\)/)
})

// --- the requirement oracle, on its own -------------------------------------------------------

test('an invariant counts what the steps did, not what the contract thinks', () => {
  const observation = { steps: [
    { action: 'redeem', ok: true, status: 200 },
    { action: 'redeem', ok: true, status: 200 },
    { action: 'issue', ok: true, status: 201 },
  ] }
  assert.equal(terms(observation).successful_redeem, 2)
  assert.equal(terms(observation).status_2xx, 3)
  assert.equal(evaluate('successful_redeem <= 1', observation).held, false)
  assert.equal(evaluate('successful_redeem <= 2', observation).held, true)
  assert.equal(evaluate('status_500 == 0', observation).held, true)
})

test('an invariant proof cannot evaluate is refused with the terms it does know', () => {
  assert.match(invariantProblem('successful_redeem', 'here', ['redeem']), /not one comparison/)
  assert.match(invariantProblem('redeemed < 1', 'here', ['redeem']), /unknown term "redeemed"/)
  assert.equal(invariantProblem({ expression: 'successes >= 0' }, 'here', ['redeem']), null)
})

test('an attack block with no invariant is refused — there would be no requirement oracle', () => {
  const problems = validateSpec({
    goal: 'g',
    criteria: [{ id: 'AC1', requirement: 'r', attack: { actions: [{ name: 'a', http: { path: '/a' } }] } }],
    serve: { run: 'x', ready_url: 'http://127.0.0.1:1' },
    checks: [{ name: 'c', satisfies: ['AC1'], run: 'true' }],
  })
  assert.ok(problems.some(p => /invariants: needs what must remain true/.test(p)), problems.join('\n'))
})

test('an attack action carrying an expectation is refused', () => {
  const problems = validateSpec({
    goal: 'g',
    criteria: [{
      id: 'AC1',
      requirement: 'r',
      attack: { actions: [{ name: 'a', http: { path: '/a', expect: { status: 200 } } }], invariants: ['successful_a <= 1'] },
    }],
    serve: { run: 'x', ready_url: 'http://127.0.0.1:1' },
    checks: [{ name: 'c', satisfies: ['AC1'], run: 'true' }],
  })
  assert.ok(problems.some(p => /an attack action has no expectations/.test(p)), problems.join('\n'))
})

test('the classification table is the one the design note draws', () => {
  assert.equal(classify({ violated: true, contractPassed: true, anyContract: true }), RESULT.gap)
  assert.equal(classify({ violated: true, contractPassed: false, anyContract: true }), RESULT.violation)
  assert.equal(classify({ violated: false, suspicious: true }), RESULT.candidate)
  assert.equal(classify({ violated: false }), RESULT.none)
  assert.equal(classify({ errored: true, violated: true, contractPassed: true }), RESULT.error)
})

test('a seeded search is a repeatable search', () => {
  const a = Array.from({ length: 5 }, rng(7))
  const b = Array.from({ length: 5 }, rng(7))
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, Array.from({ length: 5 }, rng(8)))
})

test('budgets are written the way people write durations', () => {
  assert.equal(parseBudget('90s'), 90)
  assert.equal(parseBudget('5m'), 300)
  assert.equal(parseBudget('2h'), 7200)
  assert.equal(parseBudget('45'), 45)
  assert.throws(() => parseBudget('soon'), /--budget takes a duration/)
})

test('the pattern library suggests a surface from how a claim is worded', () => {
  assert.deepEqual(suggestionsFor('a reset token can only be redeemed once').map(s => s.surface), ['concurrency', 'sequence'])
  assert.deepEqual(suggestionsFor('users cannot read another tenant\'s documents').map(s => s.surface), ['identity'])
  assert.deepEqual(suggestionsFor('the page renders'), [])
})

test('the boundary values are the ones that break parsing, not a random corpus', () => {
  const labels = BOUNDARY_VALUES.map(v => v.label)
  for (const expected of ['empty string', 'null', 'negative', 'very long', 'unicode', 'wrong type']) {
    assert.ok(labels.includes(expected), `${expected} is tried`)
  }
})
