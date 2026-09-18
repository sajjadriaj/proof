// What the contract would prove, before spending a run on it.
//
// `check` says all of this — but only after booting the app and running everything, and only
// on a pass. Someone writing a contract wants the answer while the file is open: does this
// exercise the running app, does anything assert content, is anything still a placeholder.
// A two-minute run to learn that a check asserts nothing is a two-minute run wasted.
//
// Nothing here executes. The verdict a check produces is still `check`'s to give.
import { loadSpec, SPEC_PATH } from './spec.js'
import { placeholderChecks, serveList, serveLabel, VERBS } from './validate.js'
import { contractAdvisory, assertsContent, describe } from './check.js'
import { block } from './terminal.js'


/**
 * Each check as the sentence it asserts.
 *
 * The contract is the definition of "done", which makes it something a human has to be able to
 * review — and a file you cannot read is a file you cannot review. This is the same string the
 * run records as `asserted`, so what `lint` reads back is exactly what the evidence will claim,
 * rather than a second description of the language that can drift from the first.
 */
export function sentences(spec) {
  const out = serveList(spec).map((srv, i) => ({
    check: serveList(spec).length > 1 ? `app boots (${serveLabel(srv, i)})` : 'app boots',
    says: srv.ready_log
      ? `\`${srv.run}\` logs a line matching /${srv.ready_log}/`
      : `\`${srv.run}\` answers at ${srv.ready_url ?? srv.url}`,
    added: true,
  }))

  for (const [i, c] of spec.checks.entries()) {
    const kind = VERBS.find(v => v in c)
    out.push({
      check: c.name ?? `${kind} check ${i + 1}`,
      says: c.skip !== undefined ? `skipped — ${c.skip}` : describe(c, kind),
      skipped: c.skip !== undefined,
    })
  }
  return out
}

export function lint({ json = false, specPath } = {}) {
  const path = specPath ?? SPEC_PATH
  const spec = loadSpec(path)                    // a broken contract throws the usual coded error

  const checks = spec.checks
  const runtime = checks.filter(c => 'http' in c || 'browser' in c)
  const content = runtime.filter(assertsContent)
  const unfinished = placeholderChecks(spec).map(u => u.name ?? `check[${u.i}]`)
  const skipped = checks.filter(c => c?.skip !== undefined).map(c => ({ check: c.name ?? '(unnamed)', reason: c.skip }))

  // Per check, not only per contract: the advisory names the class, and the reader wants to
  // know which lines to edit.
  const statusOnly = runtime.filter(c => !assertsContent(c)).map(c => c.name ?? '(unnamed)')

  const out = {
    spec: path,
    goal: spec.goal ?? null,
    says: sentences(spec),
    checks: checks.length,
    runtime_checks: runtime.length,
    content_checks: content.length,
    serve: serveList(spec).length,
    // With a serve block the app would be started, so the narrower advisory is the honest one.
    advisory: contractAdvisory(spec, { appStarted: serveList(spec).length > 0 }),
    status_only: statusOnly,
    skipped,
    unfinished,
    // Unfinished is what `check` refuses; everything else is a caveat about strength.
    status: unfinished.length ? 'unfinished' : 'ok',
  }

  if (json) console.log(JSON.stringify(out, null, 2))
  else printHuman(out)
  return unfinished.length ? 2 : 0
}

function printHuman(o) {
  console.log(`\nCONTRACT ${o.spec}`)
  if (o.goal) console.log(`\nRequirement:\n${block(o.goal, '  ')}`)
  console.log(`\n${block(`${o.checks} check(s); ${o.runtime_checks} exercise the running app;`
    + ` ${o.content_checks} assert what it returns`
    + (o.serve ? `; ${o.serve} process(es) started by a serve block` : '; no serve block'), '  ')}`)

  // The contract read back as what it asserts. A definition of "done" nobody can read is a
  // definition nobody reviews, and the checks are structured precisely so this is derivable.
  //
  // Two lines per check rather than two columns: the sentence is the whole point of the
  // section, and a column narrow enough to fit a name cut the sentence off mid-assertion.
  if (o.says.length) {
    console.log('\nWHAT IT SAYS')
    for (const r of o.says) {
      console.log(`  ${r.check}`)
      console.log(block(r.says, '      '))
    }
    if (o.says.some(r => r.added)) {
      console.log('\n  `app boots` and `app still running` are checks proof adds for the serve block.')
    }
  }

  const notes = []
  if (o.unfinished.length) {
    notes.push(`${o.unfinished.length} check(s) still hold proof's own placeholder command (${o.unfinished.join(', ')})`
      + ' — `proof check` refuses to run until they are replaced or deleted.')
  }
  if (o.advisory) notes.push(o.advisory)
  if (o.status_only.length && o.content_checks > 0) {
    // Only when the contract-level advisory did not already say it: naming the same gap twice
    // in two shapes is the kind of output people learn to skip.
    notes.push(`${o.status_only.length} check(s) only assert a status (${o.status_only.join(', ')})`
      + ' — a 200 with the wrong body passes them.')
  }
  if (o.skipped.length) {
    notes.push(`${o.skipped.length} check(s) are skipped (${o.skipped.map(s => `${s.check}: ${s.reason}`).join('; ')})`
      + ' — a run cannot report completion while they are.')
  }

  if (notes.length) console.log(`\nNOTE\n${notes.map(n => block(n, '  ')).join('\n\n')}`)
  else console.log('\nNothing to add: every runtime check asserts content, and nothing is a placeholder.')

  console.log(o.status === 'unfinished'
    ? '\nSTATUS\n  UNFINISHED — `proof check` would refuse this contract\n'
    : '\nSTATUS\n  OK — this is what a passing run would prove\n')
}
