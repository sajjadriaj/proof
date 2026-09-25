// Would this contract catch a wrong implementation?
//
// `falsify` answers the question behind it — does the contract tell the old code from the new?
// It does not answer this one. A contract can need your change and still miss every plausible
// way the change could be wrong: the endpoint answers, the row is written, the page renders,
// and the authorization check that was supposed to guard it was never exercised.
//
// A challenge injects a fault you name, into a throwaway copy of your code, and runs the
// contract against it. The contract has to fail. A fault the contract does not notice is a
// class of bug this contract cannot report — which is worth knowing before the verdict is
// trusted, not after.
//
// Nothing here is a mutation-testing engine. The faults are the ones you write down, because a
// syntactic mutation ("change > to >=") is cheap to generate and rarely describes anything a
// requirement cares about. `--from` hands the same job to any program — including an agent —
// that can print a list of faults: it proposes, proof executes and judges.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { contractKey, loadSpec, PROOF_DIR, SPEC_PATH, writeError, writeFileAtomic } from './spec.js'
import { save as saveCounterexample } from './counterexample.js'
import { fingerprint, head, inRepo, toplevel, showPrefix } from './git.js'
import { satisfied } from './criteria.js'
import { challengeProblems } from './validate.js'
import { contractHash } from './seal.js'
import { isSuspicious, runContract, withWorktree } from './sandbox.js'
import { slug } from './browser.js'
import { block, columnWidth, padTo, truncateToWidth } from './terminal.js'

const NAME_COLUMN_MAX = 48

export const RECORD_PATH = join(PROOF_DIR, 'challenges.json')

const git = (...args) => {
  try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}

export const challengeList = spec => (Array.isArray(spec?.challenges) ? spec.challenges : [])

export function readChallenges(specPath = SPEC_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(RECORD_PATH, 'utf8'))
    return parsed?.records?.[contractKey(specPath)] ?? null
  } catch { return null }
}

function record(out, specPath) {
  let existing = {}
  try { existing = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) ?? {} } catch {}
  const next = { ...existing, version: 1, records: { ...(existing.records ?? {}), [contractKey(specPath)]: out } }
  try {
    mkdirSync(PROOF_DIR, { recursive: true })
    writeFileAtomic(RECORD_PATH, `${JSON.stringify(next, null, 2)}\n`)
  } catch (e) {
    throw writeError(e, RECORD_PATH, 'the challenge record',
      '`proof done` reads it to decide whether the contract was ever challenged.')
  }
}

/**
 * The code as it stands, as something git can check out.
 *
 * `git stash create` writes a commit object for the working tree without touching it or the
 * stash list. It holds tracked changes, staged and not.
 */
function currentState() {
  const stashed = git('stash', 'create')
  return stashed ? { commit: stashed, includes: 'tracked changes' } : { commit: head(), includes: 'HEAD' }
}

/**
 * The files git has not seen yet, copied into the copy.
 *
 * A stash commit holds tracked changes only, and half of what "your code as it stands" means
 * during a change is a file that is new. Without this the contract ran against a tree missing
 * every new module — which fails, loudly, for a reason that has nothing to do with any fault.
 * Ignored files are left out: that is what `--exclude-standard` means, and build output and
 * dependency directories are not code under test.
 */
export function copyUntracked(root, worktree) {
  const files = (git('-C', root, 'ls-files', '--others', '--exclude-standard') ?? '')
    .split('\n').filter(Boolean)

  const copied = []
  for (const file of files) {
    const from = join(root, file)
    try {
      if (!statSync(from).isFile()) continue
      mkdirSync(dirname(join(worktree, file)), { recursive: true })
      copyFileSync(from, join(worktree, file))
      copied.push(file)
    } catch { /* a file that vanished between the listing and the copy is not worth failing over */ }
  }
  return copied
}

/**
 * Faults from a program rather than from the contract.
 *
 * The plugin seam for everything this file deliberately does not do: semantic probes derived
 * from a criterion, an adversarial agent hypothesising how the change could be wrong, a
 * language-specific mutation tool. Whatever produces them, proof is what runs them and what
 * decides whether the contract noticed — the generator is never the root of trust.
 */
export function generated(command) {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.error) throw Object.assign(new Error(`could not run \`${command}\` — ${r.error.message}`), { code: 'EUSAGE' })
  if (r.status !== 0) {
    throw Object.assign(
      new Error(`\`${command}\` exited ${r.status} and produced no challenges:\n${(r.stdout + r.stderr).trim()}`),
      { code: 'EUSAGE' })
  }

  let parsed
  try { parsed = JSON.parse(r.stdout) } catch {
    throw Object.assign(
      new Error(`\`${command}\` did not print JSON — a challenge generator prints a list of`
        + ' `{name, apply, breaks}` objects on stdout'),
      { code: 'EUSAGE' })
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.challenges
  if (!Array.isArray(list)) {
    throw Object.assign(new Error(`\`${command}\` printed JSON that is not a list of challenges`), { code: 'EUSAGE' })
  }
  const problems = list.flatMap((c, i) => challengeProblems(c, `challenge[${i}] from \`${command}\``))
  if (problems.length) {
    throw Object.assign(
      new Error(`\`${command}\` produced challenges proof cannot run:\n${problems.map(p => `  - ${p}`).join('\n')}`),
      { code: 'EUSAGE' })
  }
  return list.map(c => ({ ...c, source: 'generated' }))
}

const breaksOf = c => (typeof c?.breaks === 'string' ? [c.breaks] : Array.isArray(c?.breaks) ? c.breaks : [])

/** Which criteria a check carries, so a detection can be attributed to a requirement. */
const criteriaOfChecks = (spec, names) => [...new Set((Array.isArray(spec?.checks) ? spec.checks : [])
  .filter(c => names.includes(c?.name))
  .flatMap(satisfied))]

/**
 * One fault, applied and judged.
 *
 * Three outcomes. `detected` is the contract doing its job. `missed` is the finding: every
 * check passed with the fault in place. `inconclusive` is everything that says nothing — the
 * fault command failed, it changed no files, or the only failures were a crashed runner and a
 * missing binary. An inconclusive probe is never counted as detection, for the same reason
 * `falsify` refuses to count one: it would be false reassurance in the place it costs most.
 */
export function judge(run, spec) {
  const results = run.results ?? []
  const failed = results.filter(r => r.status === 'failed')
  const real = failed.filter(r => !isSuspicious(r))

  if (!real.length && failed.length) {
    return {
      status: 'inconclusive',
      reason: `the only failures were ones that say nothing about the fault (${failed.map(r => r.name).join(', ')})`,
      detected_by: [],
      criteria_detected: [],
    }
  }
  if (!real.length) {
    return { status: 'missed', reason: null, detected_by: [], criteria_detected: [] }
  }
  const names = real.map(r => r.name)
  return {
    status: 'detected',
    reason: null,
    detected_by: names,
    criteria_detected: criteriaOfChecks(spec, names),
  }
}

/**
 * What the copy contains, as one hash.
 *
 * Compared either side of the fault to answer "did this actually change anything?". A status
 * listing cannot: a file git has not seen is `??` before and after, whatever the fault did to
 * its contents — and those files are exactly the new modules a change is made of.
 */
const treeHash = worktree => {
  git('-C', worktree, 'add', '-A')            // the copy's own index, thrown away with it
  return git('-C', worktree, 'write-tree')
}

const runOne = (c, { state, root, prefix, absoluteSpec, spec }) => withWorktree(state.commit, root, worktree => {
  copyUntracked(root, worktree)
  const before = treeHash(worktree)
  const cwd = prefix ? join(worktree, prefix) : worktree

  const applied = spawnSync(c.apply, { cwd, shell: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (applied.status !== 0) {
    return {
      status: 'inconclusive',
      reason: `the fault command exited ${applied.status ?? '(signalled)'} — it did not run here:`
        + ` ${(applied.stderr || applied.stdout || '').trim().split('\n')[0]}`,
      detected_by: [],
      criteria_detected: [],
    }
  }
  // A fault that changed nothing is the worst possible reading of MISSED: the contract passed
  // because the code was never broken, and the report would say the contract cannot see this
  // class of bug. Hashed either side, in the copy, so a `sed` that matched nothing is caught.
  const after = treeHash(worktree)
  if (before && after && before === after) {
    return {
      status: 'inconclusive',
      reason: 'the fault command changed no files, so the contract was run against unmodified code'
        + ' — a pattern that matched nothing, or a path that is not in the copy',
      detected_by: [],
      criteria_detected: [],
    }
  }

  // Two passes, cheapest first.
  //
  // A fault that names what it breaks can be judged against the evidence for that criterion
  // alone — which is the sharper question (does AC5's own evidence catch this?) and, on a
  // contract whose first check is the whole test suite, the difference between seconds and
  // minutes. But a fault the criterion's checks do not catch may still be caught by a check
  // elsewhere, and reporting that as MISSED would be a weakness this contract does not have.
  // So the full contract runs before anything is called missed, never to confirm a detection.
  const breaks = breaksOf(c)
  if (breaks.length) {
    const scoped = judge(runContract(cwd, absoluteSpec, { label: `the fault "${c.name}"`, criteria: breaks }), spec)
    if (scoped.status === 'detected') return { ...scoped, scope: breaks }
  }

  const full = judge(runContract(cwd, absoluteSpec, { label: `the fault "${c.name}"` }), spec)
  return breaks.length && full.status === 'detected'
    ? { ...full, scope: null, outside: breaks }
    : full
})

export function challenge({ json = false, specPath, from } = {}) {
  if (!inRepo()) {
    throw Object.assign(
      new Error('not a git repository — `challenge` injects each fault into a throwaway copy of your'
        + ' code, which is a git worktree (or `git init` here)'),
      { code: 'ENOREPO' })
  }
  if (!head()) {
    throw Object.assign(
      new Error('this repository has no commits yet, so there is nothing to copy the code from'
        + ' — commit, then challenge'),
      { code: 'ENOBASE' })
  }

  const path = specPath ?? SPEC_PATH
  const spec = loadSpec(path)
  const absoluteSpec = resolve(path)
  const declared = challengeList(spec).map(c => ({ ...c, source: 'contract' }))
  const faults = [...declared, ...(from ? generated(from) : [])]

  if (!faults.length) {
    throw Object.assign(
      new Error(`${path} declares no challenges — add a \`challenges:\` list of faults the contract`
        + ' must catch (`{name, apply, breaks}`), or pass `--from "<command>"` to generate them.'),
      { code: 'ENOCHALLENGES' })
  }

  const root = toplevel()
  const prefix = showPrefix()
  const state = currentState()

  // The control run. A challenge asks whether a fault makes the contract fail; if the contract
  // already fails on the code as it stands, every fault would "be detected" by a failure that
  // was there beforehand — a report of a strong contract, built entirely from a broken one.
  const control = withWorktree(state.commit, root, worktree => {
    copyUntracked(root, worktree)
    return runContract(prefix ? join(worktree, prefix) : worktree, absoluteSpec, { label: 'your code with no fault applied' })
  })
  if (control.status !== 'passed') {
    const failed = (control.failures ?? []).map(f => f.check).join(', ')
    throw Object.assign(
      new Error(`the contract does not pass on your code as it stands (${control.status}${failed ? `: ${failed}` : ''})`
        + ' — a challenge asks whether a fault makes the contract fail, and it already does.'
        + ' Get `proof check` green first. If it passes here but not in the copy, something the run'
        + ' needs is ignored by git: the copy holds tracked files and untracked ones, never ignored'
        + ' ones.'),
      { code: 'ECONTROL' })
  }

  const results = faults.map(c => {
    const outcome = runOne(c, { state, root, prefix, absoluteSpec, spec })
    return {
      name: c.name,
      source: c.source,
      breaks: breaksOf(c),
      apply: c.apply,
      ...outcome,
    }
  })

  const missed = results.filter(r => r.status === 'missed')
  const out = {
    status: missed.length ? 'weakness' : results.some(r => r.status === 'inconclusive') ? 'incomplete' : 'complete',
    at: new Date().toISOString(),
    spec: path,
    contract_hash: contractHash(spec),
    commit: head(),
    tree: fingerprint(),
    state: state.includes,
    results,
    detected: results.filter(r => r.status === 'detected').map(r => r.name),
    missed: missed.map(r => r.name),
    inconclusive: results.filter(r => r.status === 'inconclusive').map(r => r.name),
    counterexamples: missed.map(r => writeCounterexample(r, { spec, path })),
  }

  record(out, path)
  if (json) console.log(JSON.stringify(out, null, 2))
  else printHuman(out)

  return out.status === 'weakness' ? 1 : 0
}

/**
 * A fault the contract accepted, kept.
 *
 * The finding is a concrete, reproducible thing — this command, applied to this commit,
 * produced code every check passed — and it is exactly what is lost when a terminal scrolls.
 * `proof promote` turns one back into a check, so the contract that missed it once cannot miss
 * it again.
 */
export function writeCounterexample(result, { spec, path }) {
  return saveCounterexample({
    id: slug(result.name),
    challenge: result.name,
    criterion: result.breaks[0] ?? null,
    criteria: result.breaks,
    spec: path,
    contract_hash: contractHash(spec),
    commit: head(),
    found_at: new Date().toISOString(),
    apply: result.apply,
    observed: 'every check passed with this fault applied',
    expected: 'at least one check fails',
  })
}

const TAG = { detected: 'DETECTED', missed: 'MISSED', inconclusive: 'INCONCLUSIVE' }

function printHuman(o) {
  console.log('\nCONTRACT CHALLENGE')
  console.log(`\n${block(`${o.results.length} fault(s) injected into a copy of your code as it`
    + ` stands (${o.state} at ${String(o.commit).slice(0, 12)}), one at a time. The contract has to`
    + ' fail on each.', '  ')}`)

  const w = columnWidth(o.results.map(r => r.name), NAME_COLUMN_MAX)
  console.log('\nFAULT                                        DETECTION')
  for (const r of o.results) {
    const caught = r.detected_by.slice(0, 2).join(', ')
    const rest = r.detected_by.length > 2 ? `, +${r.detected_by.length - 2} more` : ''
    const where = r.status === 'detected' ? `  ${caught}${rest}` : ''
    console.log(`  ${padTo(truncateToWidth(r.name, NAME_COLUMN_MAX), w + 2)}${TAG[r.status]}${where}`)
  }

  const notes = []
  for (const r of o.results.filter(x => x.status === 'inconclusive')) {
    notes.push(`${r.name}: ${r.reason}`)
  }
  // Detected, but not by a check that carries the criterion the fault violates. The contract
  // noticed something; what it did not do is notice it as that requirement failing.
  for (const r of o.results.filter(x => x.status === 'detected' && x.breaks.length)) {
    const overlap = r.breaks.filter(b => r.criteria_detected.includes(b))
    if (overlap.length) continue
    notes.push(`${r.name} breaks ${r.breaks.join(', ')}, and the checks that caught it`
      + ` (${r.detected_by.join(', ')}) carry ${r.criteria_detected.length ? r.criteria_detected.join(', ') : 'no criterion'}`
      + ' — the fault was noticed, but not as that requirement failing.')
  }
  const scoped = o.results.filter(r => r.scope?.length).length
  if (scoped) {
    notes.push(`${scoped} fault(s) were judged against the checks that carry the criterion they break,`
      + ' rather than the whole contract. A fault those checks do not catch is re-run against'
      + ' everything before it is called missed.')
  }
  notes.push('the copy holds your tracked files and the untracked ones git can see; anything your'
    + ' .gitignore excludes is not in it. A fault aimed at an ignored file would apply to nothing.')
  if (notes.length) console.log(`\nNOTE\n${notes.map(n => block(n, '  ')).join('\n\n')}`)

  if (o.missed.length) {
    console.log(`\nWEAKNESS\n${block(`${o.missed.join(', ')} — the contract passed with ${o.missed.length === 1 ? 'this fault' : 'these faults'}`
      + ' applied, so it cannot report this class of wrong implementation.', '  ')}`)
    console.log(`\n${o.counterexamples.map(f => `  ${f}`).join('\n')}`)
    console.log(block('`proof promote <id>` turns one into a check so the contract stops missing it.', '  '))
  }

  console.log(`\nVERDICT\n  ${o.status === 'weakness' ? 'WEAKNESS FOUND' : o.status === 'incomplete' ? 'INCOMPLETE' : 'COMPLETE'}`
    + `\n  ${o.detected.length} detected, ${o.missed.length} missed, ${o.inconclusive.length} inconclusive\n`)
}
