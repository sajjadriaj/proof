import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

/** EBADREF only fires inside a repository: outside one there is no HEAD to compare against. */
const withRepo = () => {
  const dir = withSpec('goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  for (const args of [['init', '-q', '.'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 't']]) {
    spawnSync('git', args, { cwd: dir })
  }
  writeFileSync(join(dir, 'a.txt'), 'x\n')
  spawnSync('git', ['add', '-A'], { cwd: dir })
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

const withSpec = body => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-jsonerr-'))
  mkdirSync(join(dir, '.proof'), { recursive: true })
  writeFileSync(join(dir, '.proof/spec.yaml'), body)
  return dir
}

test('the regression: an invalid contract reports its problems as a list', () => {
  // An agent fixing a contract wants them one at a time; re-parsing `  - ` out of a
  // multi-line string is a parser nobody should have to write against a tool built for agents.
  const dir = withSpec('goal: g\nchecks:\n  - name: a\n    http: {path: /x, url: "http://y.test/z"}\n    expct: 1\n')
  const { code, out } = proof(dir, 'check', '--json')

  assert.equal(code, 2)
  const parsed = JSON.parse(out)
  assert.equal(parsed.status, 'error')
  assert.equal(parsed.problems.length, 2)
  assert.ok(parsed.problems.every(p => typeof p === 'string' && !p.includes('\n')), 'one problem per entry')
})

test('the message still carries them too, for a human reading a terminal', () => {
  const dir = withSpec('goal: g\nchecks:\n  - name: a\n    expct: 1\n    run: "true"\n')
  const parsed = JSON.parse(proof(dir, 'check', '--json').out)

  assert.match(parsed.error, /is invalid/)
  assert.ok(parsed.error.includes(parsed.problems[0]), 'the list and the message agree')
})

test('an error with no list of problems omits the field rather than sending an empty one', () => {
  // `problems: []` would read as "no problems", which is the opposite of what happened.
  const dir = mkdtempSync(join(tmpdir(), 'proof-jsonerr-none-'))
  const parsed = JSON.parse(proof(dir, 'check', '--json').out)

  assert.equal(parsed.status, 'error')
  assert.match(parsed.error, /no spec at/)
  assert.equal('problems' in parsed, false)
})

test('infer --write on an unreadable contract lists its problem too', () => {
  const dir = withSpec('goal: g\nchecks:\n  - name: a\n    run: "true"\n    expct: 1\n')
  writeFileSync(join(dir, 'routes.js'), "app.get('/api/x', h)\n")

  const parsed = JSON.parse(proof(dir, 'infer', '--write', '--json').out)
  assert.equal(parsed.status, 'error')
  assert.equal(parsed.problems.length, 1)
  assert.match(parsed.problems[0], /unknown key "expct"/)
})

test('the regression: every error carries a machine-readable code', async () => {
  // Without one an agent branches on the wording of a sentence proof is free to reword.
  const cases = [
    [['check'], 'ENOSPEC', d => d],
    [['report'], 'ENORUNS', d => d],
    [['check', '--frobnicate'], 'EUSAGE', d => d],
    [['frobnicate'], 'EUSAGE', d => d],
    [['check'], 'EBADSPEC', () => withSpec('goal: g\nchecks:\n  - name: a\n    expct: 1\n    run: "true"\n')],
    [['check'], 'EUNFINISHED', () => withSpec('goal: g\nchecks:\n  - name: t\n    run: echo "replace me with a real command"\n')],
    [['check', '--only', 'nothing'], 'ENOMATCH', () => withSpec('goal: g\nchecks:\n  - name: a\n    run: "true"\n')],
    [['changed', '--base', 'no-such-ref'], 'EBADREF', () => withRepo()],
  ]

  for (const [args, expected, makeDir] of cases) {
    const dir = makeDir(mkdtempSync(join(tmpdir(), 'proof-codes-')))
    const { out } = proof(dir, ...args, '--json')
    const parsed = JSON.parse(out)

    assert.equal(parsed.code, expected, `proof ${args.join(' ')} reported ${parsed.code}: ${parsed.error}`)
    assert.equal(parsed.status, 'error')
  }
})

test('a usage error is distinguishable from a problem with the project', () => {
  // The distinction an agent needs most: did I call it wrong, or is something wrong there?
  const dir = withSpec('goal: g\nchecks:\n  - name: a\n    run: "true"\n')

  assert.equal(JSON.parse(proof(dir, 'check', '--nope', '--json').out).code, 'EUSAGE')
  assert.equal(JSON.parse(proof(dir, 'check', '--json').out).status, 'passed')
})

test('every documented code is one proof can actually produce', async () => {
  // A table of codes nothing emits is worse than no table.
  const { readFileSync, readdirSync } = await import('node:fs')
  const readme = ['../README.md', ...readdirSync(new URL('../docs', import.meta.url)).filter(f => f.endsWith('.md')).map(f => `../docs/${f}`)]
    .map(f => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n\n')
  const documented = [...readme.matchAll(/^\| `(E[A-Z]+)`(?: \/ `(E[A-Z]+)`)? \|/gm)].flatMap(m => [m[1], m[2]]).filter(Boolean)

  // Every source, not a hand-maintained list — moving an error between modules is a refactor,
  // and it once failed this as though the code had been deleted.
  const dirs = ['src', 'bin'].flatMap(d =>
    readdirSync(new URL(`../${d}`, import.meta.url))
      .filter(f => f.endsWith('.js'))
      .map(f => `${d}/${f}`))
  const sources = dirs.map(f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n')

  assert.ok(documented.length >= 10, `only ${documented.length} codes documented`)
  for (const code of documented) {
    assert.ok(sources.includes(`'${code}'`), `README documents ${code} but no source emits it`)
  }
})
