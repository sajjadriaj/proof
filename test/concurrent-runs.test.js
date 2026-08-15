import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import YAML from 'yaml'

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const sandbox = contract => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-concurrent-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'), YAML.stringify(contract))
  return dir
}

const runCli = (dir, args = ['check']) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { cwd: dir }, (err, stdout) => resolve({ err, stdout }))
})

test('the regression: concurrent runs each get their own evidence directory', async () => {
  const N = 8
  const dir = sandbox({ goal: 'concurrent runs', checks: [{ name: 'quick', run: 'true' }] })

  await Promise.all(Array.from({ length: N }, () => runCli(dir)))

  const runs = readdirSync(join(dir, '.proof/runs')).sort()
  assert.equal(runs.length, N, `expected ${N} run directories, got ${runs.length} — evidence was overwritten`)
  assert.equal(new Set(runs).size, N, 'directory names are unique')
})

test('every concurrent run keeps a complete, readable bundle', async () => {
  const N = 6
  const dir = sandbox({ goal: 'complete bundles', checks: [{ name: 'quick', run: 'echo hello' }] })

  await Promise.all(Array.from({ length: N }, () => runCli(dir)))

  for (const id of readdirSync(join(dir, '.proof/runs'))) {
    const runDir = join(dir, '.proof/runs', id)
    assert.ok(existsSync(join(runDir, 'result.json')), `${id} has result.json`)
    assert.ok(existsSync(join(runDir, 'commands.log')), `${id} has commands.log`)

    const r = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'))
    assert.equal(r.status, 'passed')
    assert.equal(r.run, join('.proof/runs', id), 'the bundle names the directory it lives in')
  }
})

test('run ids stay sequential and gapless', async () => {
  const dir = sandbox({ goal: 'sequential', checks: [{ name: 'quick', run: 'true' }] })
  await Promise.all(Array.from({ length: 5 }, () => runCli(dir)))

  assert.deepEqual(readdirSync(join(dir, '.proof/runs')).sort(), ['0001', '0002', '0003', '0004', '0005'])
})

test('a later serial run continues after concurrent ones', async () => {
  const dir = sandbox({ goal: 'serial after parallel', checks: [{ name: 'quick', run: 'true' }] })
  await Promise.all(Array.from({ length: 3 }, () => runCli(dir)))
  await runCli(dir)

  assert.deepEqual(readdirSync(join(dir, '.proof/runs')).sort(), ['0001', '0002', '0003', '0004'])
})
