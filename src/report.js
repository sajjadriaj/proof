import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { PROOF_DIR, writeError } from './spec.js'
import { RUNS, dirSize, humanBytes, missingRunFields } from './runs.js'
import { VERDICT } from './check.js'
import { fingerprint } from './git.js'
import { TERMINAL_WIDTH, truncateToWidth } from './terminal.js'

/** True when the working tree has moved since this run, so its verdict is about older code. */
export const isStale = result => {
  const now = fingerprint()
  return Boolean(result?.tree && now && now !== result.tree)
}


const RUN_ID = /^\d+$/

/** Every run directory, finished or not. A gap in the sequence is something to explain. */
export function listRuns() {
  if (!existsSync(RUNS())) return []
  return readdirSync(RUNS(), { withFileTypes: true })
    .filter(e => e.isDirectory() && RUN_ID.test(e.name))
    .map(e => e.name)
    // Numeric, not lexicographic. Ids are padded to four digits, so the ten-thousandth run
    // sorts "10000" before "9999" — and `proof report` with no id would answer with run
    // 9999 forever after, quietly reporting a stale verdict as the latest one.
    .sort((a, b) => Number(a) - Number(b))
}

/**
 * Runs accumulate forever and the growth notice pointed at `rm`. Keeps the newest `keep`,
 * deletes the rest. `--keep` is a positive integer at the CLI, so the most recent run can
 * never be pruned by a typo'd zero.
 */
export function prune({ keep = 20, json = false } = {}) {
  const all = listRuns()
  if (!all.length) throw Object.assign(new Error('no runs yet — nothing to prune'), { code: 'ENORUNS' })

  const doomed = all.slice(0, Math.max(0, all.length - keep))
  const dir = RUNS()
  const freed = doomed.reduce((n, id) => {
    try { return n + dirSize(join(dir, id)) } catch { return n }
  }, 0)

  const failed = []
  for (const id of doomed) {
    try { rmSync(join(dir, id), { recursive: true, force: true }) } catch (e) { failed.push({ id, error: e.message }) }
  }

  const deleted = doomed.filter(id => !failed.some(f => f.id === id))
  const out = { pruned: deleted, kept: all.length - doomed.length, freed, failed }

  if (json) console.log(JSON.stringify(out, null, 2))
  else if (!deleted.length) console.log(`\nNothing to prune — ${all.length} run(s), keeping ${keep}.\n`)
  else {
    const range = deleted.length === 1 ? deleted[0] : `${deleted[0]}–${deleted.at(-1)}`
    console.log(`\nPruned ${deleted.length} run(s) (${range}), ${humanBytes(freed)} reclaimed.`)
    console.log(`Kept the ${out.kept} most recent in ${dir}.\n`)
  }

  // A partial delete that reported success would leave the user believing space was freed.
  for (const f of failed) console.error(`proof: could not remove ${join(dir, f.id)} — ${f.error}`)
  return failed.length ? 1 : 0
}

const finished = id => existsSync(join(RUNS(), id, 'result.json'))

export const completeRuns = () => listRuns().filter(finished)

export function resolveRun(id) {
  const all = listRuns()
  const complete = all.filter(finished)

  if (!all.length) throw Object.assign(new Error('no runs yet — run `proof check` first'), { code: 'ENORUNS' })
  if (!id) {
    if (!complete.length) throw Object.assign(new Error('no finished runs yet — every run directory is incomplete'), { code: 'ENORUNS' })
    return join(RUNS(), complete.at(-1))
  }

  // Proof prints `.proof/runs/0001/result.json` in every run's Evidence section, and shells
  // complete `.proof/runs/0001/` with a trailing slash. Both came back as "no run" — for a
  // path the tool itself had just handed the reader.
  const asId = String(id)
    .replace(/[\\/]+$/, '')
    .replace(/^.*[\\/]runs[\\/]/, '')
    .replace(/[\\/].*$/, '')

  // by value, so `proof report 1`, `0001` and `00001` all name the same run
  const match = all.find(r => r === asId || (asId !== '' && Number(r) === Number(asId)))
  if (!match) throw Object.assign(new Error(`no run "${id}" (have: ${all.join(', ')})`), { code: 'ENORUN' })
  // An interrupted run has no verdict to render; say that rather than "no such run".
  if (!finished(match)) throw Object.assign(new Error(`run ${match} did not finish — it has no result.json`), { code: 'ENORUN' })
  return join(RUNS(), match)
}

const dur = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)

// A check named "checkout | refund path" would otherwise open an extra column, and the
// renderer would show its kind as "refund path" and its result as "run" — a report that
// misstates the result it exists to record.
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ')

// Long enough to survive whatever backticks the content holds, per CommonMark. A log line
// containing a fence would otherwise close the block early and spill into the document.
const longestRun = (text, re) => {
  let longest = 0
  for (const m of String(text).matchAll(re)) longest = Math.max(longest, m[0].length)
  return longest
}

// Folded, never spread: output can hold hundreds of thousands of backtick runs, and an
// argument list that long throws RangeError while rendering a report.
const fenceFor = text => '`'.repeat(Math.max(3, longestRun(text, /`+/g) + 1))

/** A labelled value: inline when it is one line, fenced when it is not. */
const field = (label, value) => {
  const text = String(value ?? '')
  if (!text.includes('\n')) return `- **${label}:** ${cell(text)}`
  const fence = fenceFor(text)
  return `- **${label}:**\n\n${fence}\n${text.trim()}\n${fence}`
}

const inlineCode = s => {
  const text = String(s ?? '').replace(/\s*\r?\n\s*/g, ' ')
  const ticks = '`'.repeat(Math.max(1, longestRun(text, /`+/g) + 1))
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${text}${pad}${ticks}`
}

export function markdown(r) {
  const out = []
  const p = s => out.push(s)

  p(`# Proof report`)
  p(``)
  p(`**Verdict:** ${VERDICT[r.status] ?? r.status}${r.stale ? ' — STALE' : ''}`)
  if (r.partial) {
    p(`**Subset run:** ${inlineCode(`--only "${r.only}"`)} — ${r.selected_checks} of ${r.contract_checks} check(s)`)
  }
  if (r.goal) p(`**Requirement:** ${cell(r.goal)}`)
  // Only when it is not the default: naming `.proof/spec.yaml` on every report is noise,
  // and the line exists for the case where several contracts share one runs directory.
  if (r.spec && r.spec !== '.proof/spec.yaml') p(`**Contract:** \`${r.spec}\``)
  p(`**Run:** \`${r.run}\``)
  p(`**Verified at:** ${r.at}`)
  if (r.git?.head) p(`**Commit:** \`${r.git.head.slice(0, 12)}\`${r.git.branch ? ` (${r.git.branch})` : ''}`)

  // The report is the artifact people read and share. A caveat that appears only in the
  // terminal output of `proof check` is missing from the document that makes the claim.
  // A report is evidence attached to a review. If the code moved after the run, the report
  // is not evidence about the code being reviewed, and saying so is the whole point.
  if (r.stale) {
    p(``)
    p(`> **Stale:** the working tree has changed since this run. These results describe the`)
    p(`> code as it was at the timestamp above, not the code as it stands now.`)
    p(`> Re-run \`proof check\` for a verdict about the current tree.`)
  }

  if (r.advisory) {
    p(``)
    p(`> **What this run does not prove:** ${r.advisory}`)
  }

  // Adverse things proof watched happen while the check still passed. The report is where
  // a reviewer decides whether a green run is good enough, so it needs the actual text.
  const noisy = r.results.filter(c => c.status === 'passed' && c.consoleErrors?.length)
  if (noisy.length || r.warnings?.length) {
    p(``)
    p(`## Observed but not gated`)

    // result.json carried these and the terminal printed them, but the report — the artifact
    // that gets attached to a review — dropped them entirely. A redirect that was followed,
    // a tree that moved mid-run, a subset that skipped the check establishing the session:
    // all of it was visible only to whoever ran the command.
    if (r.warnings?.length) {
      p(``)
      for (const w of r.warnings) p(`- ${cell(w)}`)
    }

    for (const c of noisy) {
      p(``)
      p(`**${cell(c.name)}** passed with ${c.consoleErrors.length} console error(s):`)
      p(``)
      for (const e of c.consoleErrors.slice(0, 10)) p(`- ${inlineCode(e.text)}${e.at ? ` — ${cell(e.at)}` : ''}`)
      if (c.consoleErrors.length > 10) p(`- …and ${c.consoleErrors.length - 10} more`)
    }
    // Only when there are console errors: the section now also carries warnings that have
    // nothing to do with that flag, and advice for something not present is noise.
    if (noisy.length) {
      p(``)
      p(`Set \`expect_no_console_errors: true\` on a browser check to fail on these.`)
    }
  }

  if (r.git?.changed?.length) {
    p(``)
    p(`## Changed files`)
    p(``)
    for (const f of r.git.changed) p(`- ${inlineCode(f)}`)
  }

  p(``)
  p(`## Checks`)
  p(``)
  // Without the assertion column the report says a check passed but never what it proved,
  // and the contract that would explain it has usually moved on by the time anyone reads this.
  p(`| Check | Asserted | Result | Time |`)
  p(`| --- | --- | --- | --- |`)
  for (const c of r.results) {
    p(`| ${cell(c.name)} | ${cell(c.asserted ?? c.kind)} | ${c.status === 'passed' ? 'PASS' : 'FAIL'} | ${dur(c.ms)} |`)
  }

  // contract checks that were selected but never got to run — synthetic serve checks
  // are not contract checks and must not be counted on either side
  const skipped = (r.selected_checks ?? 0) - (r.ran_checks ?? 0)
  if (skipped > 0) {
    p(``)
    // not always "never booted" — a port already in use stops the run before starting anything
    p(`_${skipped} check(s) never ran — the run stopped when the serve check failed._`)
  }

  if (r.failures.length) {
    p(``)
    p(`## Failures`)
    for (const f of r.failures) {
      p(``)
      p(`### ${cell(f.check)}`)
      p(``)
      // cell() collapses newlines, which is right for a table and wrong here: a crash
      // reason spanning lines came out as one 500-character bullet with its formatting gone,
      // in the artifact that gets attached to a review.
      // The report is what gets attached to a review, where "this used to pass" is the
      // first thing a reader wants and the terminal output is long gone.
      if (f.was === 'passed') p(field('Regression', `passed in run ${f.since}, fails now`))
      else if (f.was === 'failed') p(field('Not new', `also failed in run ${f.since}`))
      else if (f.was === 'changed') p(field('Not comparable', `this check asserted something else in run ${f.since}`))
      if (f.expected) p(field('Expected', f.expected))
      p(field('Observed', f.observed))
      if (f.output) {
        const fence = fenceFor(f.output)
        p(``)
        p(fence)
        p(f.output.trim())
        p(fence)
      }
      // Same as the Evidence section: relative to this file, and a screenshot embedded.
      // A failure is exactly where someone wants to open the response body or the picture.
      for (const e of f.evidence ?? []) {
        const here = relative(r.run, e) || basename(e)
        p(`- **Evidence:** ${evidenceLink(here, here)}`)
      }
    }
  }

  p(``)
  p(`## Evidence`)
  p(``)
  // Linked relative to this file, which lives inside the run directory. Repo-relative paths
  // resolved to `.proof/runs/0001/.proof/runs/0001/...` when the report was opened where it
  // sits — every link in the artifact that gets attached to a review was broken.
  const extra = r.results.flatMap(c => c.evidence ?? [])
  for (const f of [...['result.json', 'commands.log'].map(n => join(r.run, n)), ...extra]) {
    if (!existsSync(f)) continue
    // A screenshot is the evidence a reviewer actually wants to look at; a link they have to
    // resolve by hand is one they do not follow.
    const here = relative(r.run, f) || basename(f)
    p(`- ${evidenceLink(here, here)}`)
  }
  p(``)
  return out.join('\n')
}

/**
 * A link whose label survives odd characters and whose href cannot be broken by them.
 * A path containing a backtick, a bracket or a space is rare but real — check names become
 * filenames — and an unescaped one silently truncates the link.
 */
const evidenceLink = (label, href) =>
  (/\.png$/i.test(label)
    ? `![${basename(label, '.png').replace(/[[\]]/g, '')}](${encodeURI(href)})`
    : `${inlineCode(label)} → [open](${encodeURI(href)})`)

const VERDICT_TAG = { passed: 'PASS', failed: 'FAIL', partial: 'PART', incomplete: '····', unreadable: '····' }

/** How many runs `--list` shows before it starts hiding the oldest. */
export const LIST_LIMIT = 20

export function listRunsDetailed({ limit = Infinity } = {}) {
  const ids = listRuns()
  // Reading and sizing every run costs seconds once a history accumulates, and the rows
  // beyond a screenful are not read anyway. Resolving the ids is cheap; the per-run work
  // is not, so only do it for what is shown.
  return ids.slice(Math.max(0, ids.length - limit)).map(id => {
    const dir = join(RUNS(), id)
    const base = { id, dir, at: null, goal: null, spec: null, checks: 0, failed: 0, stale: false, bytes: dirSize(dir) }

    // A run killed mid-flight leaves a directory and no verdict. Hiding it left a gap in
    // the sequence that proof could explain and did not.
    if (!existsSync(join(dir, 'result.json'))) return { ...base, status: 'incomplete' }

    try {
      const r = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))
      if (missingRunFields(r).length) return { ...base, status: 'unreadable' }
      const failed = r.results.filter(c => c.status === 'failed').length
      return {
        ...base,
        status: r.status,
        at: r.at,
        goal: r.goal,
        spec: r.spec ?? null,
        checks: r.results.length,
        failed,
        stale: isStale(r),
      }
    } catch {
      return { ...base, status: 'unreadable' }
    }
  })
}

function printRunList(json, all) {
  const totalRuns = listRuns().length
  const runs = listRunsDetailed({ limit: all ? Infinity : LIST_LIMIT })
  const hidden = totalRuns - runs.length

  // One walk of the directory, rather than one per run: the total is about the directory,
  // and computing it from the shown rows would understate it whenever rows are hidden.
  const total = existsSync(RUNS()) ? dirSize(RUNS()) : 0

  if (json) {
    console.log(JSON.stringify({ runs, shown: runs.length, total_runs: totalRuns, bytes: total }, null, 2))
    return 0
  }
  if (!runs.length) {
    console.log('\nNo runs yet — run `proof check`.\n')
    return 0
  }
  console.log('\nRUNS')
  const idWidth = runs.reduce((max, r) => Math.max(max, r.id.length), 1) // ids widen past the ten-thousandth run

  // Only when there is something to tell apart. `--spec` lets several contracts share one
  // runs directory, and two of them checking the same requirement produced rows that were
  // identical — the goal is not enough to identify a run once that is possible.
  const contracts = new Set(runs.map(r => r.spec).filter(Boolean))
  const showContract = contracts.size > 1
  // Two contracts both named spec.yaml both labelled `[spec]`, which is the one thing the
  // label exists to prevent. Fall back to the whole path when the basenames collide.
  const short = spec => basename(String(spec ?? '')).replace(/\.ya?ml$/, '')
  const ambiguous = new Set([...contracts].map(short)).size < contracts.size
  const label = spec => (ambiguous ? String(spec ?? '') : short(spec))

  for (const r of runs) {
    const when = r.at ? r.at.replace('T', ' ').slice(0, 16) : '—'.padEnd(16)
    const tally = r.status === 'incomplete' || r.status === 'unreadable' ? '—' : `${r.checks - r.failed}/${r.checks}`
    const note = r.status === 'incomplete' ? 'did not finish'
      : r.status === 'unreadable' ? 'result.json could not be read'
        : `${r.goal ?? ''}${r.stale ? ' (stale)' : ''}`
    // the note is last, so only its own row overflows — but that row is still the one
    // carrying the goal, and a descriptive goal is easily twice the terminal width
    const which = showContract ? `[${label(r.spec) || '?'}] ` : ''
    const prefix = `  ${r.id.padStart(idWidth)}  ${(VERDICT_TAG[r.status] ?? '????').padEnd(5)}${when}  ${tally.padEnd(7)}${which}`
    console.log(prefix + truncateToWidth(note, Math.max(20, TERMINAL_WIDTH - prefix.length)))
  }
  // Evidence accumulates quietly — a browser check writes a full-page screenshot every
  // run. Showing the total lets someone notice before the disk does.
  const stalled = runs.filter(r => r.status === 'incomplete' || r.status === 'unreadable').length
  const note = stalled ? `, ${stalled} without a verdict` : ''
  const shown = hidden ? ` (showing the ${runs.length} most recent, \`--all\` for the rest)` : ''
  console.log(`\n${totalRuns} run(s)${note}${shown}, ${humanBytes(total)} in ${RUNS()}.`
    + ' `proof report <id>` for one of them.\n')
  return 0
}

export function report({ json = false, run, list = false, all = false } = {}) {
  if (list) return printRunList(json, all)

  const dir = resolveRun(run)
  // `--list` already degrades gracefully here; a single run reported the raw parser error
  // ("Unexpected end of JSON input") with no file, no run id and nothing to do about it.
  // A half-written result.json is what an interrupted run or a full disk leaves behind.
  const file = join(dir, 'result.json')
  let result
  try {
    result = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    const why = e.code === 'ENOENT' ? 'it is not there' : `it is not valid JSON (${e.message})`
    const e2 = new Error(
      `${file} could not be read — ${why}. A run interrupted part-way through leaves one like this. `
      + '`proof report --list` shows the runs that can be read; `proof check` records a new one.',
    )
    e2.code = 'EBADRUN'
    throw e2
  }

  // Parseable is not the same as complete. A file cut short at a record boundary still
  // parses, and every reader below assumed `results` was there — the first one to touch it
  // died with `Cannot read properties of undefined (reading 'length')`, which names neither
  // the file nor the problem.
  const missing = missingRunFields(result)
  if (missing.length) {
    const e2 = new Error(
      `${file} is not a proof run record — it parses, but ${missing.map(k => `\`${k}\``).join(' and ')} `
      + `${missing.length > 1 ? 'are' : 'is'} missing or not an array. A run interrupted part-way `
      + 'through leaves one like this. `proof report --list` shows the runs that can be read; '
      + '`proof check` records a new one.',
    )
    e2.code = 'EBADRUN'
    throw e2
  }

  result.run = dir
  result.stale = isStale(result)

  // A stale run cannot claim done. The human output said STALE in capitals and `--json`
  // carried `stale: true`, but the exit code — the part CI and agents actually branch on —
  // still said 0, so `proof report && deploy` shipped on results describing an older tree.
  const code = result.failures.length || result.stale ? 1 : 0

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return code
  }

  const md = markdown(result)
  // The report is on screen and the run is in result.json either way. Failing the command
  // because the saved copy could not be written would withhold the verdict over a duplicate.
  let saveFailed = null
  try {
    writeFileSync(join(dir, 'report.md'), md)
  } catch (e) {
    const explained = writeError(e, join(dir, 'report.md'), 'the report',
      'The report above and `result.json` are unaffected; only the saved copy is missing.')
    saveFailed = explained === e ? `could not save report.md: ${e.message}` : explained.message
  }
  console.log(md)
  if (saveFailed) console.log(`\n> **Not saved:** ${saveFailed}`)
  return code
}
