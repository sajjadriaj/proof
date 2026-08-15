import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check } from '../src/check.js'
import { report } from '../src/report.js'

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

/** Renders a run and returns the project directory, for tests that read the bundle. */
const renderRunDir = async spec => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-md-dir-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', spec)
  await quiet(() => check({ json: true }))
  await quiet(() => report({}))
  return dir
}

const renderRun = async spec => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-md-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', spec)
  await quiet(() => check({ json: true }))
  await quiet(() => report({}))
  return readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')
}

/** A command whose failure message spans lines and depends on its own alignment. */
const MULTILINE = `goal: g
checks:
  - name: boxed
    run: |
      printf '+------------------+\\n'
      printf '|  aligned column  |\\n'
      printf '+------------------+\\n'
      exit 1
    expect_output: "not present anywhere"
`

test('the regression: a multi-line observed value is fenced, not flattened into a bullet', async () => {
  // cell() collapses newlines — right for a table, wrong for a field. A crash reason came
  // out as one 500-character bullet with its formatting gone, in the artifact that gets
  // attached to a review.
  const md = await renderRun(
    'goal: g\nchecks:\n  - name: c\n    run: "printf \'first line\\\\nsecond line\\\\n\'; exit 7"\n',
  )

  const observed = md.split('\n').find(l => l.startsWith('- **Observed:**'))
  assert.equal(observed, '- **Observed:** exit 7', 'a one-line value stays inline')
})

test('a one-line expected value stays inline', async () => {
  const md = await renderRun('goal: g\nchecks:\n  - name: c\n    run: exit 7\n')
  assert.match(md, /^- \*\*Expected:\*\* exit 0$/m)
})

test('alignment survives the fence', async () => {
  // The box goes through the Output fence here, since the command failed on its exit code
  // before the substring assertion was reached.
  const md = await renderRun(MULTILINE)
  assert.match(md, /^\|  aligned column  \|$/m, `alignment lost:\n${md}`)
})

test('a crash reason spanning lines is fenced under its own label', async () => {
  const { report: reportFn } = await import('../src/report.js')
  const dir = mkdtempSync(join(tmpdir(), 'proof-md-crash-'))
  process.chdir(dir)
  mkdirSync('.proof/runs/0001', { recursive: true })
  writeFileSync('.proof/runs/0001/result.json', JSON.stringify({
    status: 'failed',
    goal: 'g',
    at: new Date(0).toISOString(),
    results: [{ name: 'c', kind: 'browser', asserted: 'visit /', status: 'failed', ms: 1 }],
    failures: [{
      check: 'c',
      expected: 'browser check runs',
      observed: "check crashed: launch failed\n+------------------+\n|  npx playwright  |\n+------------------+",
      output: null,
      evidence: null,
    }],
  }))

  await quiet(() => reportFn({ run: '0001' }))
  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')

  assert.match(md, /^- \*\*Observed:\*\*$/m, 'the label is on its own line')
  assert.match(md, /^\|  npx playwright  \|$/m, 'and the value keeps its shape')
})

test('a fenced field is closed by a fence long enough to contain its content', async () => {
  // Output containing a fence would otherwise end the block early and spill markup.
  const md = await renderRun(
    'goal: g\nchecks:\n  - name: c\n    run: "printf \'before\\\\n```\\\\nafter\\\\n\'; exit 1"\n',
  )

  const fences = md.split('\n').filter(l => /^`{3,}$/.test(l))
  assert.ok(fences.length >= 2, `no fenced block:\n${md}`)
  assert.equal(fences[0], fences[fences.length - 1], 'the block opens and closes with the same fence')
  assert.ok(fences[0].length > 3, 'the fence is longer than the ``` inside it')
})

test('the checks table still collapses newlines — a cell cannot span rows', async () => {
  const md = await renderRun(MULTILINE)
  const rows = md.split('\n').filter(l => l.startsWith('| boxed |'))

  assert.equal(rows.length, 1, 'the check occupies exactly one table row')
  assert.doesNotMatch(rows[0], /\n/)
})

test('the regression: evidence links resolve from where the report lives', async () => {
  // report.md sits inside the run directory, and the links were repo-relative — so opening
  // the report where it sits resolved every one to `.proof/runs/0001/.proof/runs/0001/...`.
  // Every link in the artifact that gets attached to a review was broken.
  const { existsSync } = await import('node:fs')
  const dir = await renderRunDir('goal: g\nchecks:\n  - name: a\n    run: echo hi\n')
  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')

  const links = [...md.matchAll(/^- (?:!\[[^\]]*\]|`[^`]+` → \[open\])\(([^)]+)\)$/gm)]
    .map(m => decodeURI(m[1]))
  assert.ok(links.length >= 2, `no evidence links: ${md}`)

  for (const href of links) {
    assert.ok(!href.startsWith('.proof/'), `${href} is repo-relative, not report-relative`)
    assert.ok(existsSync(join(dir, '.proof/runs/0001', href)), `${href} does not resolve from the report`)
  }
})

test('every evidence entry offers something to click', async () => {
  // A path a reviewer has to copy out of backticks is one they do not follow. The name stays
  // in a code span so odd characters cannot break it; the link is beside it.
  const dir = await renderRunDir('goal: g\nchecks:\n  - name: a\n    run: echo hi\n')
  const md = readFileSync(join(dir, '.proof/runs/0001/report.md'), 'utf8')

  assert.match(md, /^- `result\.json` → \[open\]\(result\.json\)$/m)
  assert.match(md, /^- `commands\.log` → \[open\]\(commands\.log\)$/m)
})
