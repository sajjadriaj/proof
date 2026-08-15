import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const asRoot = process.getuid?.() === 0
const opts = { skip: asRoot && 'root writes everywhere' }

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: (r.stdout + r.stderr).replace(/\s+/g, ' ') }
}

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-evidence-write-'))
  mkdirSync(join(dir, '.proof'), { recursive: true })
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: a\n    run: echo ok\n')
  return dir
}

test('the regression: a read-only .proof explains itself instead of showing an errno', opts, () => {
  // `EACCES: permission denied, mkdir '.proof/runs'` says nothing about what proof was
  // doing or what to do about it, and a read-only mount is ordinary in a CI container.
  const dir = project()
  chmodSync(join(dir, '.proof'), 0o500)
  try {
    const { code, out } = proof(dir, 'check')

    assert.equal(code, 2)
    assert.match(out, /cannot write evidence to \.proof\/runs/)
    assert.match(out, /permission denied/)
    assert.match(out, /make the directory writable/)
    assert.doesNotMatch(out, /EACCES/, 'the errno is translated, not echoed')
  } finally { chmodSync(join(dir, '.proof'), 0o700) }
})

test('a read-only runs directory is explained too', opts, () => {
  const dir = project()
  mkdirSync(join(dir, '.proof/runs'), { recursive: true })
  chmodSync(join(dir, '.proof/runs'), 0o500)
  try {
    const { code, out } = proof(dir, 'check')

    assert.equal(code, 2)
    assert.match(out, /cannot write evidence to \.proof\/runs\/0001/, out)
  } finally { chmodSync(join(dir, '.proof/runs'), 0o700) }
})

test('--json reports it as an error rather than crashing', opts, () => {
  const dir = project()
  chmodSync(join(dir, '.proof'), 0o500)
  try {
    const { code, out } = proof(dir, 'check', '--json')

    assert.equal(code, 2)
    const parsed = JSON.parse(out.replace(/\s+/g, ' '))
    assert.equal(parsed.status, 'error')
    assert.match(parsed.error, /cannot write evidence/)
  } finally { chmodSync(join(dir, '.proof'), 0o700) }
})

test('a run cannot report DONE when its evidence was never written', opts, () => {
  // The point of stopping: a verdict with no record behind it is the thing this tool exists
  // not to produce.
  const dir = project()
  chmodSync(join(dir, '.proof'), 0o500)
  try {
    const r = proof(dir, 'check')
    assert.match(r.out, /cannot write evidence/, 'it stopped for the reason claimed')
    assert.doesNotMatch(r.out, /DONE/)
  } finally { chmodSync(join(dir, '.proof'), 0o700) }
})

test('a writable project is unaffected', () => {
  const dir = project()
  const { code, out } = proof(dir, 'check')

  assert.equal(code, 0, out)
  assert.match(out, /DONE/)
})

test('an unrelated error is not dressed up as an evidence problem', async () => {
  // The translation must only fire on the codes it knows; anything else keeps its own text.
  const { evidenceError } = await import('../src/check.js')

  const other = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
  assert.equal(evidenceError(other, '.proof/runs'), other, 'an unknown code is passed through unchanged')
})

test('each cause it knows about is named in its own words', async () => {
  const { evidenceError } = await import('../src/check.js')

  const cases = [
    ['EROFS', /read-only/],
    ['ENOSPC', /disk is full/],
    ['EDQUOT', /quota/],
    ['EACCES', /permission denied/],
  ]
  for (const [code, expected] of cases) {
    const translated = evidenceError(Object.assign(new Error('raw'), { code }), '.proof/runs')
    assert.match(translated.message, expected, code)
    assert.equal(translated.code, 'EWRITE')
    assert.doesNotMatch(translated.message, new RegExp(code), `${code} is echoed rather than explained`)
  }
})

test('the regression: init explains a read-only directory instead of showing an errno', opts, () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-init-ro-'))
  chmodSync(dir, 0o500)
  try {
    const { code, out } = proof(dir, 'init', 'a requirement')

    assert.equal(code, 2)
    assert.match(out, /cannot write the contract to \.proof/)
    assert.doesNotMatch(out, /EACCES/)
  } finally { chmodSync(dir, 0o700) }
})

test('the regression: infer --write explains it, and points at the read-only alternative', opts, () => {
  const dir = project()
  writeFileSync(join(dir, 'routes.js'), "router.get('/api/x', h)\n")
  chmodSync(join(dir, '.proof'), 0o500)
  try {
    const { out } = proof(dir, 'infer', '--write')

    assert.match(out, /cannot write the contract lock/)
    assert.match(out, /without `--write` only reads/, 'it names the command that still works')
  } finally { chmodSync(join(dir, '.proof'), 0o700) }
})

test('the regression: report still renders when it cannot save its copy', opts, () => {
  // The report is on screen and the run is in result.json either way. Failing the command
  // over a duplicate would withhold the verdict the command exists to show.
  const dir = project()
  proof(dir, 'check')
  chmodSync(join(dir, '.proof/runs/0001'), 0o500)
  try {
    const { code, out } = proof(dir, 'report')

    assert.equal(code, 0, 'the verdict is what the exit code reports')
    assert.match(out, /Verdict:\*\* DONE/, 'the report is rendered')
    assert.match(out, /Not saved:.*cannot write the report/, 'and the missing copy is stated')
  } finally { chmodSync(join(dir, '.proof/runs/0001'), 0o700) }
})

test('report says nothing about saving when it saved', () => {
  const dir = project()
  proof(dir, 'check')

  const out = proof(dir, 'report').out
  assert.match(out, /Proof report/, 'a report was rendered')
  assert.doesNotMatch(out, /Not saved/)
})
