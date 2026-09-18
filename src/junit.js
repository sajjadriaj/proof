// Reading what another test runner already wrote.
//
// `run: npx playwright test` works today and tells proof one thing: the exit code. Three tests
// failed and the verdict says `exit 1`, so the evidence bundle — the thing an agent reads to
// decide what to fix next — holds less than the terminal it was captured from.
//
// Every runner worth using can write JUnit XML: Playwright and Vitest natively, pytest with
// `--junitxml`, Jest and Mocha with a reporter, Go through gotestsum, Rust through nextest.
// One format reaches all of them, which is the whole reason to read a format rather than
// reimplement a runner.
//
// ponytail: regexes, not an XML parser. The shape is fixed and shallow, this repository ships
// one runtime dependency, and the writer on the other side of this file is a string template
// too. Swap in a parser when a real report defeats it.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

const decode = s => String(s ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name])

const attrs = text => {
  const out = {}
  for (const m of String(text).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decode(m[2])
  return out
}

// `<testcase .../>` is a pass; `<testcase ...>…</testcase>` may hold a failure, an error or a skip.
const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
const OUTCOME = /<(failure|error|skipped)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/

/** A test's name as a reader would say it: `classname › name`, without repeating either. */
const label = a => {
  const name = a.name ?? '(unnamed)'
  const suite = a.classname ?? a.class
  return suite && suite !== name && !name.startsWith(suite) ? `${suite} › ${name}` : name
}

/**
 * @returns {{tests, failed, skipped, failures: [{test, message}]}|null} null when this is not
 * a JUnit report at all, which is a different problem from a report of zero tests.
 */
export function parseJUnit(xml) {
  const text = String(xml ?? '')
  if (!/<testsuites?\b/.test(text)) return null

  const cases = []
  for (const m of text.matchAll(TESTCASE)) {
    const a = attrs(m[1])
    const outcome = OUTCOME.exec(m[2] ?? '')
    cases.push({
      test: label(a),
      kind: outcome?.[1] ?? 'passed',
      // The message attribute is the summary, the body is the detail. Runners use both, and
      // which one carries the useful half is not consistent between them.
      message: outcome ? (attrs(outcome[2]).message ?? decode(outcome[3] ?? '').trim() ?? '') : '',
      detail: outcome ? decode(outcome[3] ?? '').trim() : '',
    })
  }

  const failures = cases.filter(c => c.kind === 'failure' || c.kind === 'error')
  return {
    tests: cases.length,
    failed: failures.length,
    skipped: cases.filter(c => c.kind === 'skipped').length,
    failures: failures.map(c => ({
      test: c.test,
      // Trimmed to a line: the whole stack is in the report, which is attached as evidence.
      message: (c.message || c.detail || 'failed').split('\n')[0].slice(0, 300),
    })),
  }
}

/** How many failures to name before counting the rest. A wall of them is one nobody reads. */
const SHOWN = 10

export const describeFailures = report => {
  const shown = report.failures.slice(0, SHOWN).map(f => `  ${f.test} — ${f.message}`)
  const rest = report.failures.length - shown.length
  return [...shown, ...(rest > 0 ? [`  …and ${rest} more`] : [])].join('\n')
}
