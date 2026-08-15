import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { infer } from '../src/infer.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })
const asRoot = process.getuid?.() === 0

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-unreadable-infer-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  writeFileSync('src/base.js', 'export const base = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  writeFileSync('src/routes.js', "app.get('/api/secret', h)\nconst k = process.env.SECRET_KEY\n")
  return dir
}

const opts = { skip: asRoot && 'root reads everything' }

test('the regression: a file that could not be read is not counted as scanned', opts, () => {
  // It reported "1 scannable for gaps" for a file it never opened — the route and the env
  // variable in it went undetected, and the count said otherwise.
  project()
  chmodSync('src/routes.js', 0o000)
  try {
    const out = JSON.parse(captured(() => infer({ json: true })))
    assert.equal(out.scanned, 0, 'a file that cannot be opened was not scanned')
    assert.equal(out.files, 1, 'it is still in scope')
  } finally { chmodSync('src/routes.js', 0o644) }
})

test('the warning names what was lost, not only the import graph', opts, () => {
  // The existing warning covers dependents. The gap detectors read the same files, and
  // their silence about a file they could not open reads as "nothing here".
  project()
  chmodSync('src/routes.js', 0o000)
  try {
    const out = captured(() => infer({})).replace(/\s+/g, ' ')
    assert.match(out, /routes and environment variables in them were not detected/)
    assert.match(out, /src\/routes\.js/)
  } finally { chmodSync('src/routes.js', 0o644) }
})

test('a readable file produces no such warning', () => {
  project()
  const out = JSON.parse(captured(() => infer({ json: true })))

  assert.equal(out.scanned, 1)
  assert.equal(out.warnings.filter(w => w.includes('were not detected')).length, 0)
  assert.ok(out.gaps.some(g => g.title.includes('/api/secret')), 'the route is found when the file opens')
})

test('optional .env files that simply do not exist are not reported as unreadable', () => {
  // The same read helper probes .env, .env.example and friends. Listing every one a
  // project does not have would be noise dressed as a degraded scan.
  project()
  const out = JSON.parse(captured(() => infer({ json: true })))

  assert.ok(Array.isArray(out.gaps), 'the scan ran and produced a result')
  const warning = out.warnings.find(w => w.includes('could not be read')) ?? ''
  assert.doesNotMatch(warning, /\.env/, warning)
})

test('the record does not leak between runs', opts, () => {
  project()
  chmodSync('src/routes.js', 0o000)
  try {
    captured(() => infer({ json: true }))
  } finally { chmodSync('src/routes.js', 0o644) }

  const out = JSON.parse(captured(() => infer({ json: true })))
  assert.equal(out.warnings.filter(w => w.includes('were not detected')).length, 0,
    'the second run reports the file it could read')
  assert.equal(out.scanned, 1)
})
