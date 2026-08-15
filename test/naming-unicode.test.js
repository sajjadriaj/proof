import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { slug } from '../src/browser.js'
import { validateSpec } from '../src/validate.js'
import { check } from '../src/check.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

test('the regression: distinct non-Latin names are not rejected as duplicates', () => {
  assert.deepEqual(validateSpec({
    goal: 'g',
    checks: [
      { name: 'ключ', run: 'true' },
      { name: 'сессия', run: 'true' },
      { name: '日本語のテスト', run: 'true' },
      { name: '결제 흐름', run: 'true' },
    ],
  }), [])
})

test('non-Latin names keep their identity in slugs', () => {
  assert.equal(slug('ключ'), 'ключ')
  assert.equal(slug('日本語のテスト'), '日本語のテスト')
  assert.equal(slug('café résumé'), 'café-résumé')
  assert.notEqual(slug('ключ'), slug('сессия'))
})

test('names made only of symbols stay distinct from one another', () => {
  assert.notEqual(slug('✅'), slug('🚀'))
  assert.match(slug('✅'), /^check-[0-9a-f]{8}$/)

  assert.deepEqual(validateSpec({
    goal: 'g',
    checks: [{ name: '✅', run: 'true' }, { name: '🚀', run: 'true' }],
  }), [])
})

test('names that differ only past the length cap stay distinct', () => {
  const prefix = 'a'.repeat(70)
  assert.notEqual(slug(`${prefix}-one`), slug(`${prefix}-two`))
  assert.ok(slug(`${prefix}-one`).length <= 70, 'still bounded for the filesystem')

  assert.deepEqual(validateSpec({
    goal: 'g',
    checks: [{ name: `${prefix}-one`, run: 'true' }, { name: `${prefix}-two`, run: 'true' }],
  }), [])
})

test('genuine duplicates are still caught, including across case and punctuation', () => {
  const p = validateSpec({
    goal: 'g',
    checks: [{ name: 'Ключ', run: 'true' }, { name: 'ключ', run: 'true' }],
  })
  assert.equal(p.length, 1)
  assert.match(p[0], /duplicate check name/)
})

test('a non-Latin check name produces a usable evidence filename', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-unicode-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'unicode evidence',
    checks: [
      { name: 'ключ', http: { url: 'http://127.0.0.1:9/none' } },
      { name: '日本語', run: 'echo ok' },
    ],
  }))

  assert.equal(await quiet(() => check({ json: true })), 1)
  const r = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.deepEqual(Object.keys(r.checks), ['ключ', '日本語'], 'names survive into the results map')

  const files = readdirSync(join(dir, '.proof/runs/0001'))
  assert.ok(files.includes('result.json') && files.includes('commands.log'))
})

test('the checks column stays aligned when names are double-width', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-align-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'alignment',
    checks: [
      { name: 'ascii name', run: 'true' },
      { name: '日本語のテスト', run: 'true' },
      { name: 'ключ', run: 'true' },
    ],
  }))

  const lines = []
  const real = console.log
  console.log = s => lines.push(String(s))
  try { await check({}) } finally { console.log = real }

  // every status must begin at the same terminal column
  const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/
  const widthOf = s => [...s].reduce((n, ch) => n + (wide.test(ch) ? 2 : 1), 0)

  const columns = lines.join('\n').split('\n')
    .filter(l => /\s(PASS|FAIL)$/.test(l))
    .map(l => widthOf(l.replace(/(PASS|FAIL)$/, '')))

  assert.ok(columns.length >= 3, 'found the check rows')
  assert.equal(new Set(columns).size, 1, `status column drifts: ${JSON.stringify(columns)}`)
})
