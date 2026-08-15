import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { changed, dependencyChanges, scanWarnings, resetScan } from '../src/changed.js'
import { runHttp } from '../src/check.js'

// Paths the coverage report showed nothing exercising. Each is reachable by an ordinary
// user action; an untested line in a verification tool is a claim nobody has checked.

const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })
const asRoot = process.getuid?.() === 0

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

test('the first thing anyone runs: bare, -h and --help all print usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-help-'))

  for (const args of [[], ['-h'], ['--help']]) {
    const { code, out } = proof(dir, ...args)
    assert.equal(code, 0, `proof ${args.join(' ')} exited ${code}`)
    assert.match(out, /proof init "<requirement>"/, `proof ${args.join(' ')} printed no usage`)
    assert.match(out, /exit codes: 0 passed, 1 failed, 2 configuration error/)
  }
})

test('changed without a contract says how to make one', () => {
  // A first run in a repository with no .proof at all.
  const dir = mkdtempSync(join(tmpdir(), 'proof-nocontract-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  writeFileSync('a.ts', 'export const a = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync('a.ts', 'export const a = 2\n')

  const out = captured(() => changed({}))
  assert.match(out, /no \.proof\/spec\.yaml/)
  assert.match(out, /proof init/)
})

test('changed --json reports the absent contract as a fact, not as coverage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-nocontract-json-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  writeFileSync('a.ts', 'export const a = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync('a.ts', 'export const a = 2\n')

  const out = JSON.parse(captured(() => changed({ json: true })))
  assert.equal(out.spec, false)
  assert.equal(out.coverage, null, 'no contract means no coverage, not empty coverage')
  assert.deepEqual(out.uncovered, [])
})

test('a manifest that will not parse at the base ref is reported', () => {
  // The mirror of the working-copy case: someone fixed a broken package.json, so the diff
  // is against a manifest that cannot be read. Silence there reads as "no dependencies moved".
  const dir = mkdtempSync(join(tmpdir(), 'proof-basemanifest-'))
  process.chdir(dir)
  resetScan()
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  writeFileSync('package.json', '{ "dependencies": { broken\n')
  git('add', '-A')
  git('commit', '-qm', 'a manifest that does not parse')

  writeFileSync('package.json', JSON.stringify({ dependencies: { lodash: '2.0.0' } }))

  assert.deepEqual(dependencyChanges(), [], 'nothing can be derived')
  const warning = scanWarnings().find(w => w.includes('could not be parsed'))
  assert.ok(warning, JSON.stringify(scanWarnings()))
  assert.match(warning, /at HEAD/, 'and says which side of the diff')
})

test('the runner refuses a relative http path with no base, even called directly', async () => {
  // Validation rejects such a contract, so this guard is the last thing standing between a
  // relative path and a request against whatever is running locally.
  const result = await runHttp({ name: 'c', http: { path: '/x' } }, { baseUrl: undefined, runDir: tmpdir() })

  assert.equal(result.status, 'failed')
  assert.match(result.expected, /base URL/)
  assert.match(result.observed, /no serve block/)
})

test('a contract directory that cannot be created is explained, not shown as an errno', {
  skip: asRoot && 'root writes everywhere',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-lockdir-'))
  writeFileSync(join(dir, 'routes.js'), "app.get('/api/x', h)\n")
  chmodSync(dir, 0o500)
  try {
    const { out } = proof(dir, 'infer', '--write')
    assert.match(out.replace(/\s+/g, ' '), /cannot write the contract to \.proof/)
    assert.doesNotMatch(out, /EACCES/)
  } finally { chmodSync(dir, 0o700) }
})
