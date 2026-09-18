import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

// Guard reads the verdict off a pipe. spawnSync's default buffer is 1 MB, so a contract with
// enough checks to exceed it came back truncated: JSON.parse failed, and a run that PASSED
// was reported as a broken contract — exit 2, the loop aborted, on a green verdict.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

// The harness needs a bigger buffer than the default for the same reason guard did.
const runCli = (dir, args) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ code: err?.code ?? 0, out: stdout + stderr }))
})

test('the regression: a verdict over 1 MB is read, not reported as a contract error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-bigverdict-'))
  mkdirSync(join(dir, '.proof'))

  // Every check carries its command into the run record, so the payload grows with the
  // contract. 200 × ~6 KB clears the old buffer with room to spare.
  const pad = 'x'.repeat(6000)
  const checks = Array.from({ length: 200 }, (_, i) => `  - name: c${i}\n    run: "true # ${pad}"\n`).join('')
  writeFileSync(join(dir, '.proof/spec.yaml'), `goal: a large contract\nchecks:\n${checks}`)

  const agent = join(dir, 'agent.sh')
  writeFileSync(agent, '#!/bin/sh\ntrue\n')
  chmodSync(agent, 0o755)

  const direct = await runCli(dir, ['check', '--json'])
  assert.equal(direct.code, 0, 'the contract itself passes')
  assert.ok(direct.out.length > 1024 * 1024, `verdict was only ${direct.out.length} bytes`)

  const guarded = await runCli(dir, ['guard', '--max-attempts', '1', '--', './agent.sh'])
  assert.equal(guarded.code, 0, guarded.out.slice(0, 400))
  assert.match(guarded.out, /GUARD DONE after 1 attempt/)
  assert.doesNotMatch(guarded.out, /produced no verdict/)
})
