import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * `.proof/` is excluded from the blast radius — correctly, the contract is not code under
 * test — which made a rewritten definition of "done" invisible. An agent that could not make
 * `proof check` pass deleted the check instead and got a DONE verdict with nothing said.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { exit: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const BASE = 'goal: checkout charges the right amount\nchecks:\n'
  + '  - name: price is correct\n    run: "true"\n'
  + '  - name: no debug logging\n    file: {path: src/cart.js, not_contains: "console.log"}\n'

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-contract-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, '.proof'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/cart.js'), 'export const price = () => 100\n')
  writeFileSync(join(dir, '.proof/spec.yaml'), BASE)
  g('init', '-q', '-b', 'main', '.')
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't')
  g('add', '-A'); g('commit', '-qm', 'base')
  writeFileSync(join(dir, 'src/cart.js'), 'export const price = () => 999\nconsole.log("debug")\n')
  return dir
}

const spec = (dir, body) => writeFileSync(join(dir, '.proof/spec.yaml'), body)
const json = dir => JSON.parse(proof(dir, 'changed', '--json').stdout)
const warned = out => out.warnings.some(w => /also changes the contract/.test(w))

test('a check deleted in the same diff is named', () => {
  const dir = project()
  spec(dir, 'goal: checkout charges the right amount\nchecks:\n  - name: price is correct\n    run: "true"\n')

  const out = json(dir)
  assert.deepEqual(out.contract_changed.removed, ['no debug logging'])
  assert.ok(warned(out), JSON.stringify(out.warnings))
  assert.match(proof(dir, 'changed').out, /a check that was removed cannot fail/)
})

test('a check relaxed in place is named too', () => {
  const dir = project()
  spec(dir, BASE.replace('    run: "true"', '    run: "true # relaxed"'))

  const out = json(dir)
  assert.deepEqual(out.contract_changed.modified, ['price is correct'])
  assert.ok(warned(out))
})

test('a rewritten goal is the loudest of all', () => {
  const dir = project()
  spec(dir, BASE.replace('checkout charges the right amount', 'the code compiles'))

  const out = json(dir)
  assert.equal(out.contract_changed.goal, true)
  assert.match(proof(dir, 'changed').out, /the goal itself was rewritten/)
})

test('checks the diff only adds stay quiet', () => {
  // `infer --write` adds checks as its whole job; warning there would fire on the workflow
  // proof itself recommends, and a check that did not exist cannot make a verdict weaker
  const dir = project()
  spec(dir, BASE + '  - name: extra\n    run: "true"\n')

  const out = json(dir)
  assert.deepEqual(out.contract_changed.added, ['extra'])
  assert.ok(!warned(out), JSON.stringify(out.warnings))
})

test('but they are named once something else has triggered it', () => {
  const dir = project()
  spec(dir, 'goal: checkout charges the right amount\nchecks:\n'
    + '  - name: price is correct\n    run: "true"\n  - name: extra\n    run: "true"\n')

  const out = json(dir)
  assert.deepEqual(out.contract_changed.removed, ['no debug logging'])
  assert.match(proof(dir, 'changed').out, /1 added \(extra\)/)
})

test('an untouched contract says nothing', () => {
  const dir = project()
  const out = json(dir)

  assert.deepEqual(out.contract_changed, { removed: [], added: [], modified: [], goal: false })
  assert.ok(!warned(out))
})

test('a contract that cannot be parsed at both ends says so rather than nothing', () => {
  const dir = project()
  spec(dir, 'goal: [unclosed\n')

  const out = JSON.parse(proof(dir, 'changed', '--json').stdout)
  assert.equal(out.contract_changed, null, 'no detail is claimed')
  assert.ok(out.warnings.some(w => /what moved is unknown/.test(w)), JSON.stringify(out.warnings))
})

test('outside a repository there is nothing to compare against', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-contract-norepo-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), BASE)

  // exit 2 alone is what proof returns for every config error — a CLI that did nothing at
  // all would satisfy it. Claim the reason too.
  const r = proof(dir, 'changed')
  assert.equal(r.exit, 2)
  assert.match(r.out, /not a git repository/)
})

/**
 * `changed` is where you look for a blast radius. `check` is what CI and agents gate on —
 * and a verdict is a claim about a contract, so a contract this diff rewrote makes the
 * verdict a claim against expectations the same diff set.
 */
const check = (dir, ...args) => JSON.parse(proof(dir, 'check', '--json', ...args).stdout)

test('check carries the contract note into the verdict an agent reads', () => {
  const dir = project()
  spec(dir, 'goal: checkout charges the right amount\nchecks:\n  - name: price is correct\n    run: "true"\n')

  const out = check(dir)
  assert.equal(out.status, 'passed', 'still passes — this is a note, not a gate')
  assert.ok(out.warnings.some(w => /also changes the contract/.test(w)), JSON.stringify(out.warnings))
  assert.match(proof(dir, 'check').out, /1 check\(s\) removed \(no debug logging\)/)
})

test('and into report.md, which is read away from the terminal', () => {
  const dir = project()
  spec(dir, 'goal: checkout charges the right amount\nchecks:\n  - name: price is correct\n    run: "true"\n')
  proof(dir, 'check')
  proof(dir, 'report')

  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
  assert.match(md, /also changes the contract/)
})

test('a contract this diff did not touch adds nothing to check', () => {
  const dir = project()
  const out = check(dir)

  assert.ok(out.results.length > 0, 'checks ran, so the absence below is about output that exists')
  assert.ok(!out.warnings.some(w => /also changes the contract/.test(w)), JSON.stringify(out.warnings))
})

test('checks the diff only adds stay quiet in check too', () => {
  const dir = project()
  spec(dir, BASE + '  - name: extra\n    run: "true"\n')

  const out = check(dir)
  assert.ok(out.results.some(r => r.name === 'extra'), 'the added check ran, so it was seen')
  assert.ok(!out.warnings.some(w => /also changes the contract/.test(w)))
})

test('outside a repository check still runs — there is just nothing to compare', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-check-norepo-'))
  mkdirSync(join(dir, '.proof'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/cart.js'), 'export const price = () => 100\n')
  writeFileSync(join(dir, '.proof/spec.yaml'), BASE)

  const out = check(dir)
  assert.equal(out.status, 'passed', JSON.stringify(out.failures))
  assert.ok(!out.warnings.some(w => /also changes the contract/.test(w)))
})
