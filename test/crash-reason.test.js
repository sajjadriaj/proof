import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crashReason } from '../src/check.js'
import { block, TERMINAL_WIDTH } from '../src/terminal.js'
import { validateSpec } from '../src/validate.js'

// The message Playwright produces when the package is installed but the browsers are not.
// The line naming the fix is the fifth, not the first.
const PLAYWRIGHT_MISSING_BROWSERS = [
  "browserType.launch: Executable doesn't exist at /home/u/.cache/ms-playwright/chromium/headless",
  '╔════════════════════════════════════════════════════════════╗',
  '║ Looks like Playwright was just installed or updated.       ║',
  '║ Please run the following command to download new browsers: ║',
  '║                                                            ║',
  '║     npx playwright install                                 ║',
  '╚════════════════════════════════════════════════════════════╝',
].join('\n')

test('the regression: a crash keeps the line that says how to fix it', () => {
  // Only the first line was kept, so the remedy was thrown away.
  const reason = crashReason(new Error(PLAYWRIGHT_MISSING_BROWSERS))
  assert.match(reason, /npx playwright install/)
})

test('the stack is left out — it belongs in the evidence, not the verdict', () => {
  const e = new Error('something broke\nwith a second line of explanation')
  e.stack = `${e.message}\n    at foo (/x/y.js:1:1)\n    at bar (/x/y.js:2:2)`

  const reason = crashReason({ message: `${e.message}\n    at foo (/x/y.js:1:1)` })
  assert.match(reason, /second line of explanation/)
  assert.doesNotMatch(reason, /at foo/)
})

test('a runaway message is bounded', () => {
  const reason = crashReason(new Error(Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')))
  assert.ok(reason.split('\n').length <= 13, `kept ${reason.split('\n').length} lines`)
  assert.match(reason, /…/)
})

test('a non-Error is still described', () => {
  assert.equal(crashReason('a bare string'), 'a bare string')
  assert.match(crashReason(null), /null/)
})

test('the regression: a pre-formatted block keeps its alignment', () => {
  // block() re-flowed every line, and wrap() collapses runs of whitespace — which turned
  // the box Playwright draws into ragged nonsense.
  const rendered = block(PLAYWRIGHT_MISSING_BROWSERS)

  const bar = rendered.split('\n').find(l => l.includes('npx playwright install'))
  assert.match(bar, /║ {5}npx playwright install {33}║/, `alignment lost: ${JSON.stringify(bar)}`)
})

test('a line that does not fit is still re-flowed', () => {
  const long = `a sentence that keeps going ${'and going '.repeat(20)}until it does not fit`
  for (const line of block(long).split('\n')) {
    assert.ok(line.length <= TERMINAL_WIDTH, `line was ${line.length}`)
  }
})

test('the regression: a problem is reported once, not twice', () => {
  // The check-level walk already recurses into `browser` and `serve`; walking them again
  // reported every unknown key twice, so a reader counted two problems and looked for a
  // second one that was not there.
  const cases = [
    { goal: 'g', serve: { run: 'x', ready_url: 'http://localhost:1', tmeout: 5 }, checks: [{ name: 'a', run: 'x' }] },
    {
      goal: 'g',
      serve: { run: 'x', ready_url: 'http://localhost:1' },
      checks: [{ name: 'p', browser: { visit: '/', expect_text: 'x' } }],
    },
  ]

  for (const spec of cases) {
    const problems = validateSpec(spec)
    assert.deepEqual(problems, [...new Set(problems)], `duplicated: ${problems.join(' | ')}`)
    assert.equal(problems.length, 1, problems.join(' | '))
  }
})

test('two genuinely different problems are both still reported', () => {
  // The fix must not have been "report fewer problems".
  const problems = validateSpec({
    goal: 'g',
    serve: { run: 'x', ready_url: 'http://localhost:1' },
    checks: [{ name: 'p', browser: { flow: [{ clik: 'x' }] } }],
  })
  assert.equal(problems.length, 2, problems.join(' | '))
})
