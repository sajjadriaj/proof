import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { check } from '../src/check.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

/** A contract kept outside the project it describes — a release contract, say. */
const layout = () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-specpath-'))
  mkdirSync(join(root, 'project/dist'), { recursive: true })
  mkdirSync(join(root, 'contracts'), { recursive: true })
  writeFileSync(join(root, 'project/dist/bundle.js'), 'built\n')
  writeFileSync(join(root, 'contracts/release.yaml'),
    'goal: the bundle is built\nchecks:\n'
    + '  - name: bundle exists\n    file: dist/bundle.js\n'
    + '  - name: built here\n    run: test -f dist/bundle.js\n')
  return root
}

test('relative paths in the contract resolve against the working directory, not the contract', async () => {
  // The contract is a document proof reads; the working directory is the subject it reads
  // it about. Resolving `dist/bundle.js` beside the contract would look for it in contracts/.
  const root = layout()
  process.chdir(join(root, 'project'))

  assert.equal(await quiet(() => check({ json: true, specPath: '../contracts/release.yaml' })), 0)
})

test('run: commands execute in the working directory too', async () => {
  const root = layout()
  process.chdir(join(root, 'project'))
  await quiet(() => check({ json: true, specPath: '../contracts/release.yaml' }))

  const r = JSON.parse(readFileSync(join(root, 'project/.proof/runs/0001/result.json'), 'utf8'))
  assert.equal(r.checks['built here'], 'passed')
})

test('the evidence goes beside the project, not beside the contract', async () => {
  // A contract shared by several projects would otherwise collect all their runs in one place.
  const root = layout()
  process.chdir(join(root, 'project'))
  await quiet(() => check({ json: true, specPath: '../contracts/release.yaml' }))

  assert.ok(existsSync(join(root, 'project/.proof/runs/0001/result.json')))
  assert.ok(!existsSync(join(root, 'contracts/.proof')), 'nothing is written beside the contract')
})

test('the same contract run from elsewhere describes that place instead', async () => {
  // The contract does not carry a project with it: run it somewhere without the artifact
  // and it fails, which is the point of it being about the working directory.
  const root = layout()
  mkdirSync(join(root, 'other'), { recursive: true })
  process.chdir(join(root, 'other'))

  assert.equal(await quiet(() => check({ json: true, specPath: '../contracts/release.yaml' })), 1)
})

const withContract = (body, files = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'proof-specflag-'))
  process.chdir(root)
  execFileSync('git', ['init', '-q', '.'], { stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 't@t.t'], { stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 't'], { stdio: 'ignore' })
  mkdirSync('contracts', { recursive: true })
  mkdirSync('src', { recursive: true })
  writeFileSync('src/base.ts', 'export const base = 1\n')
  writeFileSync('contracts/release.yaml', body)
  execFileSync('git', ['add', '-A'], { stdio: 'ignore' })
  execFileSync('git', ['commit', '-qm', 'init'], { stdio: 'ignore' })
  for (const [p, b] of Object.entries(files)) writeFileSync(p, b)
  return root
}

const CONTRACT = 'goal: g\nserve:\n  run: sleep 30\n  ready_url: http://localhost:9\n  reuse_existing: true\n'
  + 'checks:\n  - name: users\n    http: {method: GET, path: /api/users, expect: {status: 200}}\n'

const capture = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

test('the regression: changed reads the contract --spec names', async () => {
  // Without this, a project keeping its contract elsewhere got "no .proof/spec.yaml" and
  // no coverage at all — the feature silently unavailable rather than reported missing.
  const { changed } = await import('../src/changed.js')
  withContract(CONTRACT, { 'src/routes.ts': "app.get('/api/users', h)\n" })

  const out = JSON.parse(capture(() => changed({ json: true, specPath: 'contracts/release.yaml' })))
  assert.equal(out.spec, true, 'the contract was found')
  assert.ok(Array.isArray(out.coverage), 'coverage was computed rather than skipped')
  assert.ok(out.coverage.some(c => c.file === 'src/routes.ts'), JSON.stringify(out.coverage))

  // Without the flag the same command finds no contract at all.
  const without = JSON.parse(capture(() => changed({ json: true })))
  assert.equal(without.spec, false)
  assert.equal(without.coverage, null)
})

test('infer deduplicates against the contract --spec names', async () => {
  const { infer } = await import('../src/infer.js')
  withContract(CONTRACT, { 'src/routes.ts': "app.get('/api/users', h)\napp.get('/api/orders', h)\n" })

  const out = JSON.parse(capture(() => infer({ json: true, specPath: 'contracts/release.yaml' })))
  const titles = out.gaps.map(g => g.title)

  assert.ok(titles.some(t => t.includes('/api/orders')), 'the uncovered route is offered')
  assert.ok(!titles.some(t => t.includes('/api/users is reachable')), 'the covered one is not')
})

test('infer --write appends to that contract, not to .proof/spec.yaml', async () => {
  // The bug this would otherwise be: generated checks written to a file nothing reads.
  const { infer } = await import('../src/infer.js')
  const root = withContract(CONTRACT, { 'src/routes.ts': "app.get('/api/orders', h)\n" })

  capture(() => infer({ write: true, specPath: 'contracts/release.yaml' }))

  assert.match(readFileSync(join(root, 'contracts/release.yaml'), 'utf8'), /\/api\/orders/)
  assert.ok(!existsSync(join(root, '.proof/spec.yaml')), 'nothing was written to the default path')
})

test('the run says which contract it would append to', async () => {
  const { infer } = await import('../src/infer.js')
  withContract(CONTRACT, { 'src/routes.ts': "app.get('/api/orders', h)\n" })

  const out = capture(() => infer({ specPath: 'contracts/release.yaml' }))
  assert.match(out, /append them to contracts\/release\.yaml/)
})

test('the regression: init creates a contract where --spec says', async () => {
  // Uniform with the other three: a contract kept elsewhere should be creatable the same
  // way it is read, rather than written to the default path and moved by hand.
  const { init } = await import('../src/spec.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-initspec-'))
  process.chdir(root)
  writeFileSync('package.json', JSON.stringify({ scripts: { test: 'vitest' } }))

  capture(() => init('the release is verifiable', { specPath: 'contracts/release.yaml' }))

  assert.ok(existsSync(join(root, 'contracts/release.yaml')))
  assert.ok(!existsSync(join(root, '.proof/spec.yaml')), 'not also at the default path')
  assert.match(readFileSync(join(root, 'contracts/release.yaml'), 'utf8'), /npm run test/)
})

test('the directory is created, and proof still gets its own .gitignore', async () => {
  // Evidence and locks live in .proof whatever the contract's path; writing a .gitignore
  // into someone else's directory is not proof's business.
  const { init } = await import('../src/spec.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-initspec-dir-'))
  process.chdir(root)

  capture(() => init('r', { specPath: 'deep/nested/contract.yaml' }))

  assert.ok(existsSync(join(root, 'deep/nested/contract.yaml')))
  assert.ok(existsSync(join(root, '.proof/.gitignore')))
  assert.ok(!existsSync(join(root, 'deep/nested/.gitignore')), 'nothing written beside the contract')
})

test('the backup lands beside the contract it replaced', async () => {
  const { init } = await import('../src/spec.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-initspec-force-'))
  process.chdir(root)

  capture(() => init('first', { specPath: 'contracts/release.yaml' }))
  capture(() => init('second', { specPath: 'contracts/release.yaml', force: true }))

  assert.match(readFileSync(join(root, 'contracts/release.yaml'), 'utf8'), /second/)
  assert.match(readFileSync(join(root, 'contracts/release.yaml.bak'), 'utf8'), /first/)
})

test('without --force an existing contract at that path is refused by name', async () => {
  const { init } = await import('../src/spec.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-initspec-refuse-'))
  process.chdir(root)
  capture(() => init('first', { specPath: 'contracts/release.yaml' }))

  assert.throws(() => init('second', { specPath: 'contracts/release.yaml' }),
    /contracts\/release\.yaml already exists/)
})

test('the default path still works exactly as before', async () => {
  const { init } = await import('../src/spec.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-initspec-default-'))
  process.chdir(root)

  capture(() => init('r', {}))
  assert.ok(existsSync(join(root, '.proof/spec.yaml')))
  assert.ok(existsSync(join(root, '.proof/.gitignore')))
})

test('the regression: a run records which contract it verified', async () => {
  // With --spec a project can have several contracts, and they all write into one
  // .proof/runs. Two sharing a goal produced runs nothing could tell apart.
  const { check } = await import('../src/check.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-multispec-'))
  process.chdir(root)
  mkdirSync('contracts', { recursive: true })

  const contract = 'goal: the service is healthy\nchecks:\n  - name: a\n    run: "true"\n'
  writeFileSync('contracts/staging.yaml', contract)
  writeFileSync('contracts/prod.yaml', contract)

  await quiet(() => check({ json: true, specPath: 'contracts/staging.yaml' }))
  await quiet(() => check({ json: true, specPath: 'contracts/prod.yaml' }))

  const first = JSON.parse(readFileSync(join(root, '.proof/runs/0001/result.json'), 'utf8'))
  const second = JSON.parse(readFileSync(join(root, '.proof/runs/0002/result.json'), 'utf8'))

  assert.equal(first.spec, 'contracts/staging.yaml')
  assert.equal(second.spec, 'contracts/prod.yaml')
  assert.equal(first.goal, second.goal, 'the goals are identical — the contract is what tells them apart')
})

test('the report names the contract when it is not the default', async () => {
  const { check } = await import('../src/check.js')
  const { report } = await import('../src/report.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-multispec-md-'))
  process.chdir(root)
  mkdirSync('contracts', { recursive: true })
  writeFileSync('contracts/prod.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')

  await quiet(() => check({ json: true, specPath: 'contracts/prod.yaml' }))
  await quiet(() => report({ run: '0001' }))

  assert.match(readFileSync(join(root, '.proof/runs/0001/report.md'), 'utf8'),
    /\*\*Contract:\*\* `contracts\/prod\.yaml`/)
})

test('a default-path run does not carry a line naming the obvious', async () => {
  // Naming `.proof/spec.yaml` on every report is noise; the line exists for the case where
  // several contracts share one runs directory.
  const { check } = await import('../src/check.js')
  const { report } = await import('../src/report.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-multispec-default-'))
  process.chdir(root)
  mkdirSync('.proof', { recursive: true })
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')

  await quiet(() => check({ json: true }))
  await quiet(() => report({ run: '0001' }))

  const md = readFileSync(join(root, '.proof/runs/0001/report.md'), 'utf8')
  assert.doesNotMatch(md, /\*\*Contract:\*\*/)

  // but the data still records it, because evidence should not depend on the renderer
  const r = JSON.parse(readFileSync(join(root, '.proof/runs/0001/result.json'), 'utf8'))
  assert.equal(r.spec, '.proof/spec.yaml')
})

const twoContracts = async () => {
  const { check } = await import('../src/check.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-listspec-'))
  process.chdir(root)
  mkdirSync('contracts', { recursive: true })
  const contract = 'goal: the service is healthy\nchecks:\n  - name: a\n    run: "true"\n'
  writeFileSync('contracts/staging.yaml', contract)
  writeFileSync('contracts/prod.yaml', contract)

  await quiet(() => check({ json: true, specPath: 'contracts/staging.yaml' }))
  await quiet(() => check({ json: true, specPath: 'contracts/prod.yaml' }))
  return root
}

test('the regression: the run list labels rows when contracts differ', async () => {
  // Two contracts checking the same requirement produced identical rows. The goal is not
  // enough to identify a run once several contracts share one runs directory.
  const { report } = await import('../src/report.js')
  await twoContracts()

  const out = capture(() => report({ list: true }))
  assert.match(out, /\[staging\] the service is healthy/)
  assert.match(out, /\[prod\] the service is healthy/)
})

test('a single contract gets no label', async () => {
  // The label exists to disambiguate; adding it when there is nothing to disambiguate is noise.
  const { check } = await import('../src/check.js')
  const { report } = await import('../src/report.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-listspec-one-'))
  process.chdir(root)
  mkdirSync('.proof', { recursive: true })
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')

  await quiet(() => check({ json: true }))
  await quiet(() => check({ json: true }))

  const listed = capture(() => report({ list: true }))
  assert.match(listed, /0001[\s\S]*0002/, 'both runs are listed — there is a list to label')
  assert.doesNotMatch(listed, /\[spec\]|\[/)
})

test('--list --json carries the contract per run', async () => {
  const { report } = await import('../src/report.js')
  await twoContracts()

  const out = JSON.parse(capture(() => report({ list: true, json: true })))
  assert.deepEqual(out.runs.map(r => r.spec), ['contracts/staging.yaml', 'contracts/prod.yaml'])
})

test('rows stay within the terminal width when labelled', async () => {
  const { check } = await import('../src/check.js')
  const { report } = await import('../src/report.js')
  const root = mkdtempSync(join(tmpdir(), 'proof-listspec-wide-'))
  process.chdir(root)
  mkdirSync('contracts', { recursive: true })

  const goal = 'verify that customers can complete checkout with a saved card and a coupon while '
    + 'the inventory service is degraded'
  writeFileSync('contracts/a-long-contract-name.yaml', `goal: ${goal}\nchecks:\n  - name: a\n    run: "true"\n`)
  writeFileSync('contracts/another.yaml', `goal: ${goal}\nchecks:\n  - name: a\n    run: "true"\n`)

  await quiet(() => check({ json: true, specPath: 'contracts/a-long-contract-name.yaml' }))
  await quiet(() => check({ json: true, specPath: 'contracts/another.yaml' }))

  for (const line of capture(() => report({ list: true })).split('\n')) {
    assert.ok(line.length <= 100, `${line.length}: ${line}`)
  }
})
