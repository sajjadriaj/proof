import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { dependencyChanges, changed, resetScan } from '../src/changed.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

const write = (p, body) => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
}

const monorepo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-monodeps-'))
  process.chdir(dir)
  resetScan()
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')

  write('package.json', { name: 'root', private: true, workspaces: ['packages/*'], dependencies: { typescript: '5.0.0' } })
  write('packages/api/package.json', { name: '@acme/api', dependencies: { express: '4.18.0' } })
  write('packages/api/src/server.ts', 'export const s = 1\n')
  write('packages/web/package.json', { name: '@acme/web', dependencies: { react: '18.0.0' } })
  write('packages/web/src/app.ts', 'export const a = 1\n')
  write('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return dir
}

test('the regression: a bump inside a workspace package is a dependency change', () => {
  // Only the root package.json was read, so this showed the file as changed and no
  // dependency change at all — the empty radius the feature exists to prevent, one
  // directory down.
  monorepo()
  write('packages/api/package.json', { name: '@acme/api', dependencies: { express: '5.0.0' } })

  assert.deepEqual(dependencyChanges('HEAD', ['packages/api/package.json']), [
    { name: 'express', from: '4.18.0', to: '5.0.0', manifest: 'packages/api/package.json' },
  ])
})

test('the manifest is part of the answer', () => {
  // `express 4 -> 5` means something different in packages/api than in packages/web, and a
  // monorepo can change both at once.
  monorepo()
  write('packages/api/package.json', { name: '@acme/api', dependencies: { express: '5.0.0' } })
  write('packages/web/package.json', { name: '@acme/web', dependencies: { react: '19.0.0' } })

  const changes = dependencyChanges('HEAD', ['packages/api/package.json', 'packages/web/package.json'])
  assert.deepEqual(changes.map(c => `${c.manifest}: ${c.name}`), [
    'packages/api/package.json: express',
    'packages/web/package.json: react',
  ])
})

test('the root manifest still works on its own', () => {
  monorepo()
  write('package.json', { name: 'root', private: true, workspaces: ['packages/*'], dependencies: { typescript: '5.4.0' } })

  assert.deepEqual(dependencyChanges(), [
    { name: 'typescript', from: '5.0.0', to: '5.4.0', manifest: 'package.json' },
  ])
})

test('changed picks up the manifest without being told which', () => {
  monorepo()
  write('packages/api/package.json', { name: '@acme/api', dependencies: { express: '5.0.0' } })

  const out = JSON.parse(captured(() => changed({ json: true })))
  assert.deepEqual(out.dependencies.map(d => d.name), ['express'])
  assert.equal(out.dependencies[0].manifest, 'packages/api/package.json')
})

test('a file that merely ends in package.json elsewhere is not a manifest', () => {
  // `docs/package.json.md` is prose, not a manifest.
  monorepo()
  write('docs/package.json.md', '# how to read package.json\n')

  assert.deepEqual(dependencyChanges('HEAD', ['docs/package.json.md']), [])
})

test('a lockfile change alone reports nothing', () => {
  monorepo()
  write('package-lock.json', { lockfileVersion: 3 })

  assert.deepEqual(dependencyChanges('HEAD', ['package-lock.json']), [])
})

test('the regression: two packages bumping the same dependency are told apart', () => {
  // Both rendered as the same line, so a monorepo diff read as a duplicate rather than as
  // two different packages moving to two different versions.
  monorepo()
  write('packages/api/package.json', { name: '@acme/api', dependencies: { express: '5.0.0' } })
  write('packages/web/package.json', { name: '@acme/web', dependencies: { express: '4.19.0' } })

  const out = captured(() => changed({}))
  const lines = out.split('\n').filter(l => l.includes('express'))

  assert.equal(lines.length, 2)
  assert.ok(lines.some(l => l.includes('5.0.0') && l.includes('packages/api/package.json')), out)
  assert.ok(lines.some(l => l.includes('4.19.0') && l.includes('packages/web/package.json')), out)
})

test('a root dependency is not labelled with a manifest it does not need', () => {
  // Naming `package.json` on every line in a single-package repo is noise.
  monorepo()
  write('package.json', { name: 'root', private: true, workspaces: ['packages/*'], dependencies: { typescript: '5.4.0' } })

  const line = captured(() => changed({})).split('\n').find(l => l.includes('typescript'))
  assert.match(line, /typescript\s+5\.0\.0 → 5\.4\.0\s*$/, line)
})

test('a long dependency name does not push the line past the terminal width', () => {
  monorepo()
  write('packages/api/package.json', {
    name: '@acme/api',
    dependencies: { '@some-organisation/a-package-with-a-genuinely-very-long-name-indeed': '2.0.0' },
  })

  const out = captured(() => changed({}))
  for (const line of out.split('\n')) assert.ok(line.length <= 100, `${line.length}: ${line}`)
})
