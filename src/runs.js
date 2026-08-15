// The evidence directory: where runs live, how big they have got, and when that is worth
// mentioning. Split out because `check` writes runs and `report` reads them, so both needed
// these — and importing one from the other made a cycle that worked only because every use
// happened to be inside a function.
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROOF_DIR } from './spec.js'

export const RUNS = () => join(PROOF_DIR, 'runs')

export function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(path)
    else { try { total += statSync(path).size } catch {} }
  }
  return total
}

export const humanBytes = n =>
  (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)


// A run costs a few hundred kilobytes, and an agent loop runs `check` hundreds of times.
// Nothing prunes .proof/runs, and the only place its size was ever shown is `report --list`,
// which nobody in that loop runs. Say it where the growth happens — counting directories is
// cheap, so the size walk only happens once there are enough of them to be worth mentioning.
const RUNS_NOTICE_AT = 100

// A template rather than a built string, so the docs test can match what the README quotes
// through the interpolated numbers.
export const EVIDENCE_NOTICE = '{runs} runs ({size}) have collected in {dir}. Nothing prunes them'
  + ' automatically — `proof report --prune` keeps the 20 most recent, or `--keep <n>` to choose.'

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, k) => values[k])

export function evidenceGrowth(runsDir) {
  let names
  try { names = readdirSync(runsDir).filter(n => /^\d+$/.test(n)) } catch { return null }
  if (names.length < RUNS_NOTICE_AT) return null

  return fill(EVIDENCE_NOTICE, { runs: names.length, size: humanBytes(dirSize(runsDir)), dir: runsDir })
}

/**
 * The fields every reader dereferences. A file that parses is not a run record: `--list`
 * read `r.results?.length ?? 0` and showed a structurally broken run as `PASS 0/0`, while
 * `proof report <id>` refused the same file. The listing was the more trusting of the two.
 */
export const RUN_FIELDS = ['results', 'failures']
export const missingRunFields = r =>
  (!r || typeof r !== 'object' ? RUN_FIELDS : RUN_FIELDS.filter(k => !Array.isArray(r[k])))

/**
 * The most recent finished run. A failure that passed there is a regression this diff caused;
 * a failure that has never passed is unfinished work. Rendered identically, they read the
 * same to an agent — and only one of them means "you broke something".
 *
 * The run in flight excludes itself: `result.json` is written last, so a directory without
 * one is never a baseline — the same rule that skips a run killed part-way through.
 *
 * `specPath` restricts the search to runs of the same contract; without it any contract's
 * run can be the baseline.
 */
export function previousResult(specPath = null) {
  let ids
  try {
    ids = readdirSync(RUNS()).filter(n => /^\d+$/.test(n)).sort((a, b) => Number(a) - Number(b))
  } catch { return null }

  for (const id of ids.reverse()) {
    const dir = join(RUNS(), id)
    if (!existsSync(join(dir, 'result.json'))) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))
      // Runs from every contract share one directory. A baseline from a different contract
      // makes "passed in run 0001" a claim about something else entirely.
      if (specPath && parsed.spec && parsed.spec !== specPath) continue
      if (!missingRunFields(parsed).length) return { id, result: parsed }
    } catch { /* a half-written run is not the baseline; keep looking back */ }
  }
  return null
}
