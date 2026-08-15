import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Runs from every contract share one `.proof/runs` directory. The baseline for "passed in run
 * 0001" was the most recent run of any of them, and two contracts both named `spec.yaml` were
 * both labelled `[spec]` — the one thing the label exists to prevent.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, W: '1' } })
  return { exit: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const project = specs => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-xcontract-'))
  mkdirSync(join(dir, '.proof'))
  for (const [path, body] of Object.entries(specs)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}

const SAME_NAME = {
  '.proof/spec.yaml': 'goal: contract A\nchecks:\n  - name: smoke\n    run: "true"\n',
  'other/spec.yaml': 'goal: contract B\nchecks:\n  - name: smoke\n    run: "false"\n',
}

test('a run of another contract is not used as the baseline', () => {
  const dir = project(SAME_NAME)
  proof(dir, 'check')                              // 0001, contract A, passes

  const r = proof(dir, 'check', '--spec', 'other/spec.yaml')
  assert.match(r.out, /FAILURE/, 'the run happened and failed')
  assert.doesNotMatch(r.out, /Regression|Not new|Not comparable/,
    'no claim at all is right when there is no comparable run')
})

test('and the failure carries no baseline in --json either', () => {
  const dir = project(SAME_NAME)
  proof(dir, 'check')
  const out = JSON.parse(proof(dir, 'check', '--spec', 'other/spec.yaml', '--json').stdout)

  const f = out.failures.find(x => x.check === 'smoke')
  assert.ok(f, 'the check failed')
  assert.equal(f.was, null)
  assert.equal(f.since, null)
})

test('the same contract still gets its regression marker', () => {
  // the restriction must not silence the feature it is protecting
  const dir = project({ '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: smoke\n    run: sh -c "exit $W"\n' })
  spawnSync(process.execPath, [CLI, 'check'], { cwd: dir, encoding: 'utf8', env: { ...process.env, W: '0' } })

  const r = proof(dir, 'check')
  assert.match(r.out, /Regression:\n {4}passed in run 0001, fails now/)
})

test('two contracts with the same basename get labels that differ', () => {
  const dir = project(SAME_NAME)
  proof(dir, 'check')
  proof(dir, 'check', '--spec', 'other/spec.yaml')

  const listed = proof(dir, 'report', '--list').out
  assert.match(listed, /\[\.proof\/spec\.yaml\]/)
  assert.match(listed, /\[other\/spec\.yaml\]/)
})

test('distinct basenames keep the short label', () => {
  const dir = project({
    '.proof/spec.yaml': 'goal: A\nchecks:\n  - name: a\n    run: "true"\n',
    '.proof/nightly.yaml': 'goal: B\nchecks:\n  - name: a\n    run: "true"\n',
  })
  proof(dir, 'check')
  proof(dir, 'check', '--spec', '.proof/nightly.yaml')

  const listed = proof(dir, 'report', '--list').out
  assert.match(listed, /\[spec\]/)
  assert.match(listed, /\[nightly\]/)
})

test('one contract still gets no label at all', () => {
  const dir = project({ '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: a\n    run: "true"\n' })
  proof(dir, 'check')
  proof(dir, 'check')

  const listed = proof(dir, 'report', '--list').out
  assert.match(listed, /0001[\s\S]*0002/, 'both runs are listed')
  assert.doesNotMatch(listed, /\[/)
})
