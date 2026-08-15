import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { infer } from '../src/infer.js'
import { TERMINAL_WIDTH, truncateToWidth, columnWidth, displayWidth } from '../src/terminal.js'

const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const LONG_ROUTE = '/api/v2/organisations/:organisationId/workspaces/:workspaceId'
  + '/projects/:projectId/settings/notifications/email'

const project = routes => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-infercol-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('package.json', '{}')
  writeFileSync('src/base.ts', 'export const noop = 1\n')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: x\n    run: "true"\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync('src/routes.ts', routes)
  return dir
}

const captured = fn => {
  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { fn() } finally { console.log = real }
  return lines.join('\n')
}

test('the regression: one long route does not widen every gap row', () => {
  project(`app.get('/health', h)\napp.post('${LONG_ROUTE}', h)\n`)
  const out = captured(() => infer({}))

  const widest = Math.max(...out.split('\n').map(l => l.length))
  assert.ok(widest <= TERMINAL_WIDTH + 20, `widest line was ${widest} characters`)
})

test('the short row is not padded out to the long one', () => {
  project(`app.get('/health', h)\napp.post('${LONG_ROUTE}', h)\n`)
  const out = captured(() => infer({}))

  const healthRow = out.split('\n').find(l => l.includes('GET /health'))
  assert.ok(healthRow.length < 100, `short row is ${healthRow.length} characters`)
  assert.match(healthRow, /\(src\/routes\.ts:1\)$/, 'its location is still on the same line')
})

test('the truncated title is marked, and its location still shown', () => {
  project(`app.post('${LONG_ROUTE}', h)\n`)
  const out = captured(() => infer({}))

  const row = out.split('\n').find(l => l.includes('POST /api/v2/organisations'))
  assert.match(row, /…/)
  assert.match(row, /\(src\/routes\.ts:1\)$/)
})

test('short routes are untouched', () => {
  project("app.get('/health', h)\napp.post('/api/login', h)\n")
  const out = captured(() => infer({}))

  assert.doesNotMatch(out, /…/)
  for (const line of out.split('\n')) assert.ok(line.length <= TERMINAL_WIDTH, line)
})

test('the full title reaches agents through --json', () => {
  project(`app.post('${LONG_ROUTE}', h)\n`)
  const out = captured(() => infer({ json: true }))
  const { gaps } = JSON.parse(out)

  assert.ok(gaps.some(g => g.title.includes(LONG_ROUTE)), 'nothing is truncated in the data')
})

test('columnWidth never exceeds the cap it is given', () => {
  const values = ['short', 'x'.repeat(500), '日'.repeat(80)]
  assert.ok(columnWidth(values, 64) <= 64)
  assert.equal(columnWidth(['a', 'bb'], 64), 12, 'a floor keeps narrow columns readable')
  assert.ok(displayWidth(truncateToWidth('日'.repeat(80), 64)) <= 64)
})
