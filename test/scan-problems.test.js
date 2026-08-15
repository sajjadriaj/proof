import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { changed } from '../src/changed.js'
import { infer } from '../src/infer.js'

const asRoot = process.getuid?.() === 0
const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-scan-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src/secret', { recursive: true })
  mkdirSync('.proof')
  writeFileSync('src/core.ts', 'export const core = 1\n')
  writeFileSync('src/consumer.ts', "import { core } from './core'\n")
  writeFileSync('src/locked.ts', "import { core } from './core'\n")
  writeFileSync('src/secret/hidden.ts', 'export const s = 1\n')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: x\n    run: "true"\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync('src/core.ts', 'export const core = 2\n')
  return dir
}

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

test('the regression: an unreadable file is reported, not silently dropped from the graph', { skip: asRoot && 'root reads everything' }, () => {
  project()
  chmodSync('src/locked.ts', 0o000)
  try {
    const out = captured(() => changed({}))
    assert.match(out, /src\/consumer\.ts/, 'the readable dependent is still found')
    assert.match(out, /could not be read/)
    assert.match(out, /src\/locked\.ts/)
    assert.match(out.replace(/\s+/g, ' '), /dependents may be missing/)
  } finally { chmodSync('src/locked.ts', 0o644) }
})

test('the regression: an unreadable directory degrades the scan instead of killing the command', { skip: asRoot && 'root reads everything' }, () => {
  project()
  chmodSync('src/secret', 0o000)
  try {
    // previously: EACCES propagated and the whole command exited 2
    const out = captured(() => changed({}))
    assert.match(out, /Changed:/, 'the command still produces its report')
    assert.match(out, /could not be read/)
    assert.match(out, /src\/secret/)
  } finally { chmodSync('src/secret', 0o755) }
})

test('a clean tree reports no scan problems', () => {
  project()
  const out = JSON.parse(captured(() => changed({ json: true })))
  assert.deepEqual(out.warnings, [])
})

test('infer surfaces scan problems too', { skip: asRoot && 'root reads everything' }, () => {
  project()
  chmodSync('src/locked.ts', 0o000)
  try {
    const json = JSON.parse(captured(() => infer({ json: true })))
    assert.ok(json.warnings.some(w => /could not be read/.test(w)))
  } finally { chmodSync('src/locked.ts', 0o644) }
})

test('problems do not leak between runs', { skip: asRoot && 'root reads everything' }, () => {
  project()
  chmodSync('src/locked.ts', 0o000)
  try {
    assert.ok(JSON.parse(captured(() => changed({ json: true }))).warnings.length > 0)
  } finally { chmodSync('src/locked.ts', 0o644) }

  // same process, readable again: the warning must not persist from the earlier scan
  assert.deepEqual(JSON.parse(captured(() => changed({ json: true }))).warnings, [])
})
