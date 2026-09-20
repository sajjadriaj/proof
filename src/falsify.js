import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { contractKey, loadSpec, PROOF_DIR, SPEC_PATH, writeError, writeFileAtomic } from './spec.js'
import { forkPoint, head, inRepo, resolveCommit, showPrefix, toplevel } from './git.js'
import { serveList } from './validate.js'
import { criteriaList, satisfied } from './criteria.js'
import { contractHash } from './seal.js'
import { isSuspicious, runContract, withWorktree } from './sandbox.js'
import { block, columnWidth, padTo, truncateToWidth } from './terminal.js'

const NAME_COLUMN_MAX = 48

/** Where the baseline lives, so `proof done` can ask whether falsification ever happened. */
export const RECORD_PATH = join(PROOF_DIR, 'falsification.json')

export function readFalsification(specPath = SPEC_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(RECORD_PATH, 'utf8'))
    return parsed?.records?.[contractKey(specPath)] ?? null
  } catch { return null }
}

/**
 * The baseline run, kept.
 *
 * Falsification is a stage in the lifecycle, not a thing you look at once: `proof done` has to
 * be able to ask whether this contract was ever shown to fail without the change, and for
 * which commit and which contract. A record that lives only in a terminal cannot answer that.
 */
function record(out, specPath) {
  let existing = {}
  try { existing = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) ?? {} } catch {}
  const next = { ...existing, version: 1, records: { ...(existing.records ?? {}), [contractKey(specPath)]: out } }
  try {
    mkdirSync(PROOF_DIR, { recursive: true })
    writeFileAtomic(RECORD_PATH, `${JSON.stringify(next, null, 2)}\n`)
  } catch (e) {
    throw writeError(e, RECORD_PATH, 'the falsification record',
      '`proof done` reads it to decide whether the contract was ever shown to fail without the change.')
  }
}

export function falsify({ json = false, specPath, base = 'HEAD' } = {}) {
  if (!inRepo()) {
    throw Object.assign(
      new Error('not a git repository — `falsify` runs the contract against the commit your change'
        + ' started from, so it needs one (or `git init` here)'),
      { code: 'ENOREPO' })
  }
  if (!head()) {
    throw Object.assign(
      new Error('this repository has no commits yet, so there is no "before" to run the contract against'
        + ' — commit the code as it was, then falsify'),
      { code: 'ENOBASE' })
  }

  const path = specPath ?? SPEC_PATH
  const spec = loadSpec(path)
  const absoluteSpec = resolve(path)

  const from = forkPoint(base)
  const commit = resolveCommit(from)
  if (!commit) {
    throw Object.assign(new Error(`cannot resolve ${from} to a commit`), { code: 'EBADREF' })
  }

  const root = toplevel()
  const prefix = showPrefix()

  const { run, linked } = withWorktree(commit, root, (worktree, links) => ({
    run: runContract(prefix ? join(worktree, prefix) : worktree, absoluteSpec, { label: commit.slice(0, 12) }),
    linked: links,
  }))

  const out = classify(run, { spec, specPath: path, base, from, commit, linked })
  record(out, path)

  if (json) console.log(JSON.stringify(out, null, 2))
  else printHuman(out)

  return { discriminates: 0, inconclusive: 2 }[out.status] ?? 1
}

/**
 * What each criterion's own checks did on the base commit.
 *
 * `falsified` is the answer the lifecycle wants: the requirement was not there before, and
 * these checks are what notices. `already-satisfied` is the finding — the criterion's checks
 * pass on code that predates the change, so they are not evidence for it. Some criteria are
 * legitimately regression guards ("the login page still works"), which is why this is reported
 * per criterion rather than folded into one pass/fail: only the author knows which is which.
 */
export function criteriaFalsification(spec, contractChecks) {
  const status = new Map(contractChecks.map(r => [r.name, r]))

  return criteriaList(spec).map(c => {
    const id = String(c.id)
    const names = (Array.isArray(spec.checks) ? spec.checks : [])
      .filter(check => satisfied(check).includes(id))
      .map(check => check?.name)
      .filter(name => status.has(name))

    if (!names.length) return { id, status: 'uncovered', checks: [] }

    const rows = names.map(n => status.get(n))
    const real = rows.filter(r => r.status === 'failed' && !isSuspicious(r))
    if (real.length) return { id, status: 'falsified', checks: names }
    if (rows.some(r => r.status === 'failed')) return { id, status: 'inconclusive', checks: names }
    return { id, status: 'already-satisfied', checks: names }
  })
}

/**
 * Checks the rest of the contract depends on, which failed on the base commit.
 *
 * A contract's opening steps are usually not claims at all. They sign somebody in, seed a row,
 * start a fixture, and hand an id to everything below. When one of those fails on the base
 * commit every check after it fails for want of a value — and the run reads as a contract that
 * discriminates beautifully, when what actually happened is that the base never reached the
 * state the contract is about. It proved nothing.
 *
 * That is the exact shape of a false DISCRIMINATES, and it is the worst thing this command can
 * produce: falsification is the step that exists to stop somebody fooling themselves, so a
 * confident wrong answer here is worse than no answer. Two real contracts hit it — one reported
 * "18 of 18 check(s) fail without your change" where the fixture had exited 1 and the other
 * seventeen failed with `no value for ${api_key}`.
 *
 * A check is a precondition when it captures a variable that any check uses. Its own failure is
 * then a statement about the harness, not about the change.
 */
export function failedPreconditions(spec, contractChecks) {
  const checks = Array.isArray(spec.checks) ? spec.checks : []
  const produced = new Map()
  for (const c of checks) {
    for (const name of Object.keys(c?.capture ?? {})) produced.set(name, c?.name)
  }
  if (!produced.size) return []

  // Referenced anywhere in the contract, read off the serialized check so a `${var}` inside a
  // header, a body, a path or a shell command all count the same.
  const used = new Set()
  for (const c of checks) {
    for (const [, name] of JSON.stringify(c ?? {}).matchAll(/\$\{([A-Za-z0-9_]+)\}/g)) used.add(name)
  }

  const failed = new Set(contractChecks.filter(r => r.status === 'failed').map(r => r.name))
  return [...new Set([...produced]
    .filter(([name, producer]) => used.has(name) && failed.has(producer))
    .map(([, producer]) => producer))]
}

/**
 * What the base run means.
 *
 * Three answers, not two. A contract that failed because the app never started on the base
 * commit has proved nothing about itself, and reporting that as "it discriminates" would be
 * the same false confidence every other part of this tool refuses to give.
 */
export function classify(run, { spec, specPath = SPEC_PATH, base, from, commit, linked = [] }) {
  const results = run.results ?? []
  const contractChecks = results.filter(r => r.kind !== 'serve' && r.status !== 'skipped')
  const serveFailed = results.filter(r => r.kind === 'serve' && r.status === 'failed')

  const failed = contractChecks.filter(r => r.status === 'failed')
  const suspicious = failed.filter(isSuspicious)
  const evidence = failed.filter(r => !isSuspicious(r))

  const checks = contractChecks.map(r => ({
    check: r.name,
    status: r.status,
    about_the_change: r.status === 'failed' && !isSuspicious(r),
    observed: r.observed ?? null,
  }))

  const criteria = criteriaFalsification(spec, contractChecks)

  const base_ran = serveFailed.length === 0
  const common = {
    at: new Date().toISOString(),
    spec: specPath,
    contract_hash: contractHash(spec),
    base,
    from,
    commit,
    goal: spec.goal ?? null,
    checks,
    criteria,
    // Criteria whose checks all pass on code that predates the change. Named separately
    // because this is the finding of §5: a check that already passes is not testing the change.
    criteria_not_falsified: criteria.filter(c => c.status === 'already-satisfied').map(c => c.id),
    discriminating: evidence.map(r => r.name),
    regression_guards: contractChecks.filter(r => r.status === 'passed').map(r => r.name),
    suspicious: suspicious.map(r => ({ check: r.name, observed: r.observed ?? null })),
    linked_dependencies: linked,
    reused_existing: serveList(spec).some(s => s?.reuse_existing === true),
  }

  if (!base_ran) {
    return {
      ...common,
      status: 'inconclusive',
      reason: `the app did not start on ${commit.slice(0, 12)} (${serveFailed.map(r => r.name).join(', ')}),`
        + ' so no check reached it and none of them said anything about your change',
    }
  }
  if (!contractChecks.length) {
    return { ...common, status: 'inconclusive', reason: 'no check ran against the base commit' }
  }
  // Before any verdict about the change: if the contract could not get the base into the state
  // it asserts against, nothing below that point is evidence either way.
  const unmet = failedPreconditions(spec, contractChecks)
  if (unmet.length) {
    return {
      ...common,
      status: 'inconclusive',
      reason: `${unmet.join(', ')} failed on ${commit.slice(0, 12)}, and the rest of the contract`
        + ' captures values from it — so the checks after it failed for want of a value rather than'
        + ' for want of your change. Seed the state in a way that runs on both commits (SQL or a'
        + ' fixture that predates the change) and falsify again',
    }
  }
  if (evidence.length) {
    return { ...common, status: 'discriminates', reason: null }
  }
  if (suspicious.length) {
    return {
      ...common,
      status: 'inconclusive',
      reason: `every failure on the base commit is one that says nothing about the change`
        + ` (${suspicious.map(r => r.name).join(', ')}) — a crashed runner never reached the code, and a`
        + ' command that exits 127 was not found there',
    }
  }
  return { ...common, status: 'does-not-discriminate', reason: null }
}

/** A few names and a count of the rest: a list nobody can read is a list nobody reads. */
const SAMPLE = 3
const sample = names => (names.length <= SAMPLE
  ? names.join(', ')
  : `${names.slice(0, SAMPLE).join(', ')}, +${names.length - SAMPLE} more`)

const VERDICT = {
  discriminates: 'DISCRIMINATES',
  'does-not-discriminate': 'DOES NOT DISCRIMINATE',
  inconclusive: 'INCONCLUSIVE',
}

/** What each criterion's row means, in the two words a reader needs. */
const CRITERION_MEANING = {
  falsified: 'FAIL  needs your change',
  'already-satisfied': 'PASS  already true before your change',
  uncovered: '····  no check carries it',
  inconclusive: 'FAIL  failed for a reason that is not your change',
}

function printHuman(o) {
  console.log('\nFALSIFY')
  if (o.goal) console.log(`\nRequirement:\n${block(o.goal, '  ')}`)
  console.log(`\n${block(`The contract was run against ${o.commit.slice(0, 12)}`
    + `${o.base === 'HEAD' ? ', the last commit' : `, where this branch left ${o.base}`}`
    + ' — the code as it was before your change. Every check that carries the requirement has'
    + ' to fail there, or it is not testing it.', '  ')}`)

  if (o.criteria.length) {
    const w = columnWidth(o.criteria.map(c => c.id), NAME_COLUMN_MAX)
    console.log('\nCRITERIA AGAINST THE BASE')
    for (const c of o.criteria) {
      console.log(`  ${padTo(truncateToWidth(c.id, NAME_COLUMN_MAX), w + 2)}${CRITERION_MEANING[c.status]}`)
    }
  }

  if (o.checks.length) {
    const w = columnWidth(o.checks.map(c => c.check), NAME_COLUMN_MAX)
    console.log('\nCHECKS AGAINST THE BASE')
    for (const c of o.checks) {
      const tag = c.status === 'failed' ? 'FAIL' : 'PASS'
      const meaning = c.about_the_change ? 'needs your change'
        : c.status === 'failed' ? 'failed for a reason that is not your change'
          : 'would pass without your change'
      console.log(`  ${padTo(truncateToWidth(c.check, NAME_COLUMN_MAX), w + 2)}${tag}  ${meaning}`)
    }
  }

  const notes = []
  if (o.linked_dependencies.length) {
    notes.push(`${o.linked_dependencies.join(', ')} were linked from your working tree rather than installed`
      + ' for the base commit, so the base app ran with the dependencies you have now. A change that is'
      + ' itself a dependency change is not measured by this.')
  }
  if (o.reused_existing) {
    notes.push('the contract sets `reuse_existing: true`, so these checks may have reached an app proof'
      + ' did not start — which would be the current code, not the base. Stop it and run this again.')
  }
  if (o.criteria_not_falsified.length) {
    notes.push(`${o.criteria_not_falsified.join(', ')} already hold on the base commit — the checks that`
      + ' carry them pass without your change, so they are regression guards rather than evidence for it.'
      + ' If one of them is the requirement, its checks are not testing it yet.')
  }
  if (o.status === 'discriminates' && o.suspicious.length) {
    notes.push(`${o.suspicious.length} other check(s) failed for a reason that says nothing about the change`
      + ` (${o.suspicious.map(s => s.check).join(', ')}) — they were not counted as evidence.`)
  }
  if (notes.length) console.log(`\nNOTE\n${notes.map(n => block(n, '  ')).join('\n\n')}`)

  const verdict = VERDICT[o.status] ?? o.status
  if (o.status === 'discriminates') {
    console.log(`\nVERDICT\n  ${verdict}`
      + `\n  ${o.discriminating.length} of ${o.checks.length} check(s) fail without your change, so the contract is about it`)
    if (o.regression_guards.length) {
      console.log(block(`${o.regression_guards.length} would pass either way`
        + ` (${sample(o.regression_guards)}) — regression guards, not the requirement`, '  '))
    }
    console.log('')
    return
  }
  if (o.status === 'does-not-discriminate') {
    console.log(`\nVERDICT\n  ${verdict}`)
    console.log(block('Every check passes on the code from before your change, so this contract would'
      + ' report DONE for a branch that did nothing. The checks that carry the requirement have to fail'
      + ' here. Assert what the change actually produces — a body, a field, a row, a page — rather than'
      + ' that the endpoint answers.', '  '))
    console.log('')
    return
  }
  console.log(`\nVERDICT\n  ${verdict}`)
  console.log(block(`${o.reason}. Nothing here says the contract is wrong, only that this run could not`
    + ' tell. Fix what stopped the base commit from running and try again.', '  '))
  console.log('')
}
