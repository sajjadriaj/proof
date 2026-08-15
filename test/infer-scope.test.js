import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { infer } from '../src/infer.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-inferscope-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('package.json', JSON.stringify({ name: 'app' }))
  writeFileSync('package-lock.json', JSON.stringify({ lockfileVersion: 3 }))
  writeFileSync('src/routes.ts', "app.post('/api/checkout', h)\nconst k = process.env.STRIPE_KEY\n")
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: x\n    run: "true"\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return dir
}

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

const inferJson = () => JSON.parse(captured(() => infer({ json: true })))

test('the regression: an unscannable diff does not report a clean bill of health', () => {
  project()
  writeFileSync('package-lock.json', JSON.stringify({ lockfileVersion: 3, note: 'bumped' }))

  const out = captured(() => infer({})).replace(/\s+/g, ' ')
  assert.match(out, /No file in scope is one proof can scan for gaps/)
  assert.doesNotMatch(out, /No verification gaps found/, 'no scan ran, so there is no empty result to report')

  assert.equal(inferJson().scanned, 0)
})

test('the very same repository does have gaps when its code is scanned', () => {
  project()
  git('add', '-A')
  git('commit', '-qm', 'second', '--allow-empty')

  // no diff, so infer scans the repository
  const json = inferJson()
  assert.ok(json.scanned > 0)
  assert.ok(json.gaps.some(g => /POST \/api\/checkout/.test(g.title)))
  assert.ok(json.gaps.some(g => /STRIPE_KEY/.test(g.title)))
})

test('a scannable diff with genuinely nothing to add still says so', () => {
  project()
  writeFileSync('src/plain.ts', 'export const x = 1\n')

  const json = inferJson()
  assert.equal(json.scanned > 0, true)

  const out = captured(() => infer({}))
  // the file yields no routes or env reads; the only gap is that no check names it
  assert.doesNotMatch(out, /Nothing was scanned/)
})

test('the scanned count is reported alongside the scope', () => {
  project()
  writeFileSync('src/routes.ts', "app.post('/api/checkout', h)\nconst k = process.env.STRIPE_KEY // touched\n")
  writeFileSync('package-lock.json', JSON.stringify({ lockfileVersion: 3, note: 'bumped' }))

  const out = captured(() => infer({}))
  assert.match(out, /file\(s\) in scope \(diff\), 1 scannable for gaps/)

  const json = inferJson()
  assert.equal(json.files, 2)
  assert.equal(json.scanned, 1)
})
