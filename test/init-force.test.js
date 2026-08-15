import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { init, loadSpec, BACKUP_PATH } from '../src/spec.js'

const HANDWRITTEN = `# Hand-written over several weeks.
goal: Customers can complete checkout and receive an order id
serve:
  run: npm run dev
  ready_url: http://localhost:3000/health
  timeout: 90
checks:
  - name: checkout flow
    browser:
      visit: /checkout
      flow:
        - fill: {email: buyer@example.com}
        - click: "Place order"
        - expect_request: {method: POST, path: /api/orders, status: 201}
`

const project = (existing = HANDWRITTEN) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-force-'))
  process.chdir(dir)
  writeFileSync('package.json', JSON.stringify({ scripts: { test: 'echo t' } }))
  if (existing) {
    mkdirSync('.proof')
    writeFileSync('.proof/spec.yaml', existing)
  }
  return dir
}

const quiet = fn => {
  const real = console.log
  console.log = () => {}
  try { return fn() } finally { console.log = real }
}

test('the regression: --force keeps the contract it replaces', () => {
  const dir = project()
  const out = quiet(() => init('something else', { json: true, force: true }))

  assert.equal(out.replaced, BACKUP_PATH)
  assert.equal(readFileSync(join(dir, BACKUP_PATH), 'utf8'), HANDWRITTEN, 'byte-for-byte')

  // and the work is recoverable in full
  const recovered = readFileSync(join(dir, BACKUP_PATH), 'utf8')
  assert.match(recovered, /expect_request: \{method: POST, path: \/api\/orders, status: 201\}/)
  assert.match(recovered, /timeout: 90/)
})

test('the terminal says where the old contract went', () => {
  project()
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { init('something else', { force: true }) } finally { console.log = real }

  assert.match(lines.join('\n'), /the previous contract was kept at \.proof\/spec\.yaml\.bak/)
})

test('the new contract is written and valid', () => {
  project()
  quiet(() => init('something else', { json: true, force: true }))

  const spec = loadSpec()
  assert.equal(spec.goal, 'something else')
  assert.deepEqual(spec.checks.map(c => c.name), ['test'])
})

test('a first init has nothing to back up', () => {
  const dir = project(null)
  const out = quiet(() => init('a requirement', { json: true }))

  assert.equal(out.replaced, null)
  assert.equal(existsSync(join(dir, BACKUP_PATH)), false)
})

test('without --force the contract is untouched', () => {
  const dir = project()
  assert.throws(() => init('something else', { json: true }), /already exists — pass --force/)

  assert.equal(readFileSync(join(dir, '.proof/spec.yaml'), 'utf8'), HANDWRITTEN)
  assert.equal(existsSync(join(dir, BACKUP_PATH)), false, 'a refused init writes nothing at all')
})

test('backups are gitignored alongside the other working files', () => {
  const dir = project()
  quiet(() => init('something else', { json: true, force: true }))

  const ignore = readFileSync(join(dir, '.proof/.gitignore'), 'utf8')
  for (const pattern of ['runs/', 'spec.lock', '*.tmp', '*.bak']) {
    assert.ok(ignore.includes(pattern), `${pattern} should be ignored`)
  }
})

test('a second --force overwrites the backup with the contract it just replaced', () => {
  const dir = project()
  quiet(() => init('first replacement', { json: true, force: true }))
  const afterFirst = readFileSync(join(dir, '.proof/spec.yaml'), 'utf8')

  quiet(() => init('second replacement', { json: true, force: true }))
  assert.equal(readFileSync(join(dir, BACKUP_PATH), 'utf8'), afterFirst, 'the backup is always one step back')
})
