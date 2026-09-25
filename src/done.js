// The question the whole tool exists to answer, asked once.
//
// `proof check` executes the contract and reports what happened. That is one link in the
// chain, and on its own it is the weakest claim in this repository: the checks passed. `done`
// evaluates the chain — was every criterion covered by evidence, did the contract ever fail
// without the change, did it survive the faults it was challenged with, is the contract the
// one that was reviewed, and is the evidence about the code that is here now.
//
// It decides nothing itself. Every input is a record some earlier command wrote, and the
// verdict is derived from them under a policy the project wrote down. An implementation agent
// cannot make this say DONE by asserting that it is finished; it can only make it say DONE by
// producing the evidence.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { contractKey, loadSpec, PROOF_DIR, SPEC_PATH, writeError, writeFileAtomic } from './spec.js'
import { coverage, criteriaList } from './criteria.js'
import { contractHash, integrity, shortHash } from './seal.js'
import { readFalsification } from './falsify.js'
import { readChallenges, challengeList } from './challenge.js'
import { readAttacks, attackable, RESULT } from './attack.js'
import { recentResults } from './runs.js'
import { isStale } from './report.js'
import { fingerprint, head, resolveCommit } from './git.js'
import { slug } from './browser.js'
import { block, padTo, truncateToWidth } from './terminal.js'

/**
 * How much evidence this project requires before DONE.
 *
 * Coverage and falsification are on by default because they are the two failures this tool was
 * built around: a criterion nothing verifies, and a contract that would have passed anyway.
 * Sealing and challenges are off because they are opt-in workflows — a contract that was never
 * sealed is not a weaker contract, it is one nobody has anchored yet, and saying otherwise
 * would make every existing contract fail on the day it upgrades.
 */
export const DEFAULT_POLICY = {
  require_criteria_coverage: true,
  require_criteria_falsification: false,
  require_falsification: true,
  require_sealed_contract: false,
  require_challenges: false,
  require_attack: false,
  allow_flakes: false,
  allow_skipped: false,
}

export const policyOf = spec => ({ ...DEFAULT_POLICY, ...(spec?.policy ?? {}) })

/** One manifest per contract. `--spec` lets a repository hold several, and they share `.proof`. */
export const manifestPath = (specPath = SPEC_PATH) => {
  const key = contractKey(specPath)
  return join(PROOF_DIR, key === SPEC_PATH ? 'report.json' : `report-${slug(key)}.json`)
}

const VERDICT = { done: 'DONE', incomplete: 'INCOMPLETE', invalid: 'INVALID' }

/**
 * The one command to run next.
 *
 * A verdict that lists eight missing things is a verdict somebody reads twice and acts on
 * once. The lifecycle has an order — a contract, then evidence it discriminates, then a run,
 * then the searches — and at any moment exactly one step is the one in front of you. Ordered
 * by that, not by severity: fixing a failing check before the contract is even the one that
 * was agreed is work done against a moving target.
 */
const idOf = (paths = []) => {
  // One finding names itself; several are a list the reader picks from.
  const ids = paths.map(p => String(p).split(/[\\/]/).pop().replace(/\.yaml$/, ''))
  return ids.length === 1 ? ids[0] : '<id>'
}

export function nextStep(o) {
  const c = o.criteria ?? []
  const uncovered = c.filter(r => r.status === 'uncovered').map(r => r.id)

  if (o.contract.modified) return { run: 'proof diff', why: 'the contract moved after it was sealed — see what changed, then `proof seal` to accept it' }
  if (uncovered.length) return { run: null, why: `write a check for ${uncovered.join(', ')}, or add \`satisfies: [${uncovered[0]}]\` to the one that proves it` }
  if (o.invalid.length) return { run: 'proof check', why: 'the evidence on record is about other code' }
  if (o.checks.total === null) return { run: 'proof check', why: 'nothing has run this contract yet' }
  if ((o.checks.passed ?? 0) < (o.checks.total ?? 0)) return { run: 'proof report', why: 'read the evidence for the checks that failed, then fix and re-run' }
  if (o.falsification.result === 'missing') return { run: 'proof falsify', why: 'the contract has never been shown to fail without the change' }
  if (['stale', 'baseline-missing'].includes(o.falsification.result)) return { run: 'proof falsify', why: 'the falsification on record is about a different contract' }
  if (o.falsification.result === 'does-not-discriminate') return { run: null, why: 'assert what the change produces — a body, a field, a row — so the contract fails without it' }
  if (o.challenges.missed.length) {
    return { run: `proof promote ${idOf(o.challenges.counterexamples)}`, why: 'a fault went unnoticed — promote it, then write the assertion that catches it' }
  }
  if (o.attack.gaps.length || o.attack.violations.length) {
    return { run: `proof replay ${idOf(o.attack.counterexamples)}`, why: 'a scenario satisfies the contract and violates the claim — fix it, then replay until it stops reproducing' }
  }
  if (o.policy.require_challenges && o.challenges.result === 'missing') return { run: 'proof challenge', why: 'the contract has not been challenged' }
  if (o.policy.require_attack && o.attack.result === 'missing') return { run: 'proof attack', why: 'nothing has gone looking for a counterexample' }
  if (['stale', 'outdated'].includes(o.challenges.result)) return { run: 'proof challenge', why: 'the challenge on record is about other code' }
  if (['stale', 'outdated'].includes(o.attack.result)) return { run: 'proof attack', why: 'the attack on record is about other code' }
  if (o.flakes.length) return { run: 'proof report --list', why: 'a check does not agree with itself — find the nondeterminism, or make it wait for what it needs' }
  return null
}

/**
 * The verification chain, evaluated.
 *
 * Split from the printing and the file writing so it can be tested without a repository, and
 * so `proof done --json` and the manifest are the same object rather than two renderings that
 * can disagree.
 */
export function evaluate({ spec, specPath = SPEC_PATH, run = null, runId = null, policy, seal, falsification, challenges, attacks, commit, tree = null }) {
  const reasons = []
  const invalid = []

  /**
   * Whether a record describes the code that is here now.
   *
   * A challenge or an attack is a claim about a tree, and both are cheap to invalidate: one
   * uncommitted edit after the search, and what it found (or did not find) is about something
   * else. Reported as its own state rather than folded into "missing" — "never run" and "run
   * against other code" call for different next steps.
   */
  const freshness = record => {
    if (!record) return 'missing'
    if (record.contract_hash !== contractHash(spec)) return 'stale'
    if (record.tree && tree && record.tree !== tree) return 'outdated'
    return null
  }

  const hash = contractHash(spec)
  const criteria = criteriaList(spec)

  // --- the contract itself ---------------------------------------------------------------
  if (seal.status === 'modified') {
    const message = `the contract has changed since it was sealed (sealed ${shortHash(seal.sealed)},`
      + ` now ${shortHash(hash)}) — \`proof diff\` shows what moved, \`proof seal\` accepts it`
    if (policy.require_sealed_contract) invalid.push(message)
    else reasons.push(message)
  }
  if (seal.status === 'unsealed' && policy.require_sealed_contract) {
    reasons.push('the contract has never been sealed, and this project requires a sealed contract'
      + ' — `proof seal` records it as reviewed')
  }

  // --- the run ---------------------------------------------------------------------------
  const checks = { total: null, passed: null, run: runId }
  let coverageRows = coverage(spec)

  if (!run) {
    reasons.push('no run of this contract has been recorded — `proof check` executes it')
  } else {
    coverageRows = coverage(spec, run.results ?? [])
    const results = (run.results ?? []).filter(r => r.kind !== 'serve')
    checks.total = results.length
    checks.passed = results.filter(r => r.status === 'passed').length

    if (run.contract_hash === undefined) {
      reasons.push(`run ${runId} predates contract fingerprinting, so proof cannot tell which contract`
        + ' it was a verdict about — run `proof check` again')
    } else if (run.contract_hash !== hash) {
      invalid.push(`run ${runId} was a verdict about contract ${shortHash(run.contract_hash)}, and the`
        + ` contract here is ${shortHash(hash)} — evidence does not carry across contract changes`)
    }
    if (run.git?.head && commit && run.git.head !== commit) {
      invalid.push(`run ${runId} verified ${run.git.head.slice(0, 12)} and HEAD is ${commit.slice(0, 12)}`
        + ' — that evidence is about other code')
    } else if (isStale(run)) {
      invalid.push(`the working tree has changed since run ${runId}, so its verdict describes code that`
        + ' is no longer here — `proof check` records one about this tree')
    }
    if (run.status === 'failed') {
      reasons.push(`${(run.failures ?? []).length} check(s) failed in run ${runId}`
        + ` (${(run.failures ?? []).map(f => f.check).join(', ')})`)
    }
    if (run.partial) {
      reasons.push(`run ${runId} was a subset run (--only "${run.only}"), which makes no claim about the`
        + ' whole contract')
    }
    if (run.against) {
      reasons.push(`run ${runId} ran against ${run.against}, which proof did not start — the checks a serve`
        + ' block earns were not part of it')
    }
    if ((run.skipped ?? []).length && !policy.allow_skipped) {
      reasons.push(`${run.skipped.length} check(s) are skipped in the contract`
        + ` (${run.skipped.map(s => s.check).join(', ')})`)
    }
    if ((run.flaky ?? []).length && !policy.allow_flakes) {
      reasons.push(`${run.flaky.length} check(s) do not agree with themselves`
        + ` (${run.flaky.map(f => f.check).join(', ')}) — a verdict resting on one is a coin flip`)
    }
  }

  // --- requirement coverage --------------------------------------------------------------
  const uncovered = coverageRows.filter(r => r.status === 'uncovered').map(r => r.id)
  const unverified = coverageRows.filter(r => r.status === 'unverified').map(r => r.id)
  const failedCriteria = coverageRows.filter(r => r.status === 'failed').map(r => r.id)

  if (policy.require_criteria_coverage) {
    if (uncovered.length) {
      reasons.push(`${uncovered.join(', ')} ${uncovered.length === 1 ? 'has' : 'have'} no verification`
        + ' evidence — no check declares `satisfies` for them')
    }
    if (unverified.length) {
      reasons.push(`${unverified.join(', ')} ${unverified.length === 1 ? 'is' : 'are'} covered by a check`
        + ' this run did not produce a result for — skipped, or never selected')
    }
    if (failedCriteria.length) {
      reasons.push(`${failedCriteria.join(', ')} ${failedCriteria.length === 1 ? 'is' : 'are'} not satisfied`
        + ' — their checks failed')
    }
  }

  // --- falsification ---------------------------------------------------------------------
  const falsified = { baseline: falsification?.commit ?? null, result: 'missing', at: falsification?.at ?? null }
  if (falsification) {
    falsified.result = falsification.status
    if (falsification.contract_hash && falsification.contract_hash !== hash) {
      falsified.result = 'stale'
    } else if (falsification.commit && !resolveCommit(falsification.commit)) {
      falsified.result = 'baseline-missing'
    }
  }
  if (policy.require_falsification) {
    if (falsified.result === 'missing') {
      reasons.push('the contract has never been shown to fail without the change — `proof falsify` runs it'
        + ' against the commit your change started from')
    } else if (falsified.result === 'stale') {
      reasons.push(`the falsification on record is about contract ${shortHash(falsification.contract_hash)},`
        + ` not ${shortHash(hash)} — run \`proof falsify\` again`)
    } else if (falsified.result === 'baseline-missing') {
      invalid.push(`the baseline commit ${String(falsification.commit).slice(0, 12)} is no longer in this`
        + ' repository, so the falsification cannot be reproduced')
    } else if (falsified.result === 'does-not-discriminate') {
      reasons.push('every check passes on the code from before the change, so this contract would report'
        + ' DONE for a branch that did nothing')
    } else if (falsified.result === 'inconclusive') {
      reasons.push(`the falsification run could not tell (${falsification.reason ?? 'inconclusive'})`)
    }
  }
  if (policy.require_criteria_falsification) {
    const notFalsified = (falsification?.criteria_not_falsified ?? [])
    if (notFalsified.length) {
      reasons.push(`${notFalsified.join(', ')} already hold on the base commit — their checks pass without`
        + ' the change, so they are not evidence for it')
    }
  }

  // --- challenges -------------------------------------------------------------------------
  const declared = challengeList(spec)
  const challenge = {
    detected: challenges?.detected ?? [],
    missed: challenges?.missed ?? [],
    inconclusive: challenges?.inconclusive ?? [],
    counterexamples: challenges?.counterexamples ?? [],
    result: freshness(challenges) ?? challenges.status,
  }
  if (challenge.missed.length && !['stale', 'outdated'].includes(challenge.result)) {
    reasons.push(`the contract accepted ${challenge.missed.length} injected fault(s)`
      + ` (${challenge.missed.join(', ')}) — it cannot report that class of wrong implementation`)
  }
  if (policy.require_challenges) {
    if (!declared.length) {
      reasons.push('this project requires challenges and the contract declares none — add a `challenges:`'
        + ' list of faults the contract must catch')
    } else if (challenge.result === 'missing') {
      reasons.push('the contract has never been challenged — `proof challenge` injects each declared fault'
        + ' and checks that the contract fails')
    } else if (challenge.result === 'stale') {
      reasons.push('the challenge run on record is about a different contract — `proof challenge` again')
    } else if (challenge.result === 'outdated') {
      reasons.push('the challenge run on record is about code that has changed since — `proof challenge` again')
    } else if (challenge.result === 'incomplete') {
      reasons.push(`${challenge.inconclusive.join(', ')} could not be judged — a fault that did not apply`
        + ' says nothing about the contract')
    }
  }

  // --- attack ------------------------------------------------------------------------------
  const attackableCriteria = attackable(spec).map(c => String(c.id))
  const attack = {
    result: freshness(attacks) ?? attacks.status,
    gaps: attacks?.gaps ?? [],
    violations: attacks?.violations ?? [],
    counterexamples: attacks?.counterexamples ?? [],
    seed: attacks?.seed ?? null,
    attackable: attackableCriteria,
  }
  // A gap always blocks, whatever the policy says. It is the contract agreeing with something the
  // requirement forbids — the one finding this whole tool exists to make impossible to ship.
  if (!['stale', 'outdated'].includes(attack.result) && attack.gaps.length) {
    reasons.push(`a scenario satisfies the contract and violates ${attack.gaps.join(', ')}`
      + ` (${attack.counterexamples.join(', ')}) — the checks that carry it cannot see this`)
  }
  if (!['stale', 'outdated'].includes(attack.result) && attack.violations.length) {
    reasons.push(`${attack.violations.join(', ')} can be violated by a scenario proof found`
      + ` (${attack.counterexamples.join(', ')})`)
  }
  if (policy.require_attack) {
    if (!attackableCriteria.length) {
      reasons.push('this project requires an attack and no criterion declares an attack surface — add an'
        + ' `attack:` block with the actions it may compose and the invariants that must hold')
    } else if (attack.result === 'missing') {
      reasons.push('nothing has gone looking for a counterexample — `proof attack` searches for a scenario'
        + ' the contract would accept and the requirement forbids')
    } else if (attack.result === 'stale') {
      reasons.push('the attack on record is about a different contract — `proof attack` again')
    } else if (attack.result === 'outdated') {
      reasons.push('the attack on record is about code that has changed since — `proof attack` again')
    } else if (attack.result === 'error') {
      reasons.push('the attack could not execute its scenarios, so nothing was searched')
    }
  }

  const verdict = invalid.length ? 'invalid' : reasons.length ? 'incomplete' : 'done'

  return {
    verdict: VERDICT[verdict],
    at: new Date().toISOString(),
    spec: specPath,
    goal: spec.goal ?? null,
    implementation: { git_commit: commit ?? null, run: runId },
    contract: {
      hash,
      // The fingerprint that was reviewed, beside the one on disk. "MODIFIED since abc123" has
      // to name the seal it moved away from, not the contract it moved to.
      sealed_hash: seal.sealed,
      sealed: seal.status !== 'unsealed',
      modified: seal.status === 'modified',
      sealed_at: seal.sealed_at,
    },
    criteria: coverageRows,
    coverage: Object.fromEntries(coverageRows.map(r => [r.id, r.status])),
    criteria_declared: criteria.length,
    checks,
    // Named on its own row rather than only in the reasons: a verdict resting on a check that
    // does not agree with itself is the one kind of green nobody should read past.
    flakes: (run?.flaky ?? []).map(f => f.check),
    falsification: falsified,
    challenges: challenge,
    attack,
    policy,
    reasons: [...invalid, ...reasons],
    invalid,
  }
}

/** Filled after the verdict object exists, so `--json` and the terminal agree on the step. */
export const withNext = out => ({ ...out, next: nextStep(out) })

export function done({ json = false, specPath } = {}) {
  const path = specPath ?? SPEC_PATH
  const spec = loadSpec(path)
  const latest = recentResults(path, 1)[0] ?? null

  const out = evaluate({
    spec,
    specPath: path,
    run: latest?.result ?? null,
    runId: latest?.id ?? null,
    policy: policyOf(spec),
    seal: integrity(spec, path),
    falsification: readFalsification(path),
    challenges: readChallenges(path),
    attacks: readAttacks(path),
    commit: head(),
    tree: fingerprint(),
  })

  const file = manifestPath(path)
  try {
    mkdirSync(PROOF_DIR, { recursive: true })
    writeFileAtomic(file, `${JSON.stringify(out, null, 2)}\n`)
  } catch (e) {
    throw writeError(e, file, 'the verification manifest',
      'It is the artifact CI and reviewers read; the verdict above is unaffected.')
  }

  if (json) console.log(JSON.stringify(withNext(out), null, 2))
  else printHuman(out, file)

  return out.verdict === 'DONE' ? 0 : 1
}

const ROW = (label, value) => `  ${label.padEnd(24)}${value}`

const criteriaTally = o => {
  if (!o.criteria_declared) return 'none declared'
  const verified = o.criteria.filter(c => c.status === 'verified').length
  return `${verified}/${o.criteria_declared} VERIFIED`
}

const attackTally = o => ({
  missing: o.attack.attackable.length ? 'NOT RUN' : 'NO ATTACK SURFACE DECLARED',
  stale: 'STALE — a different contract',
  outdated: 'OUTDATED — the code has changed since',
  no_counterexample_found: 'COMPLETE — no counterexample found',
  verification_gap: `GAP — ${o.attack.gaps.join(', ')}`,
  claim_violation: `VIOLATION — ${o.attack.violations.join(', ')}`,
  error: 'ERROR — the scenarios could not run',
}[o.attack.result] ?? String(o.attack.result))

const challengeTally = o => ({
  missing: 'NOT RUN',
  stale: 'STALE — a different contract',
  outdated: 'OUTDATED — the code has changed since',
  complete: 'COMPLETE',
  weakness: `WEAKNESS — ${o.challenges.missed.length} fault(s) missed`,
  incomplete: `INCOMPLETE — ${o.challenges.inconclusive.length} inconclusive`,
}[o.challenges.result] ?? String(o.challenges.result))

const falsificationTally = f => ({
  missing: 'NOT RUN',
  stale: 'STALE — a different contract',
  discriminates: 'PASS',
  'does-not-discriminate': 'FAIL — the contract passes without the change',
  inconclusive: 'INCONCLUSIVE',
  'baseline-missing': 'BASELINE GONE',
}[f.result] ?? String(f.result))

function printHuman(o, file) {
  console.log('\nPROOF DONE')
  if (o.goal) console.log(`\nRequirement:\n${block(o.goal, '  ')}`)
  console.log('')
  console.log(ROW('Implementation', o.implementation.git_commit ? o.implementation.git_commit.slice(0, 12) : '(no commits)'))
  console.log(ROW('Contract', o.contract.modified ? `MODIFIED since ${shortHash(o.contract.sealed_hash)} was sealed`
    : o.contract.sealed ? 'SEALED' : 'UNSEALED'))
  console.log(ROW('Criteria', criteriaTally(o)))
  const ran = o.checks.run ? ` (run ${o.checks.run})` : ''
  console.log(ROW('Checks', o.checks.total === null ? 'NO RUN' : `${o.checks.passed}/${o.checks.total} PASS${ran}`))
  console.log(ROW('Falsification', falsificationTally(o.falsification)))
  console.log(ROW('Challenges', challengeTally(o)))
  console.log(ROW('Attack', attackTally(o)))
  console.log(ROW('Counterexamples', o.attack.counterexamples.length ? String(o.attack.counterexamples.length) : '0'))
  console.log(ROW('Verification gaps', o.attack.gaps.length ? `${o.attack.gaps.length} (${o.attack.gaps.join(', ')})` : '0'))
  console.log(ROW('Flakes', o.flakes.length ? `${o.flakes.length} check(s): ${o.flakes.join(', ')}` : 'NONE'))
  console.log(ROW('Evidence', o.invalid.length ? 'NOT ABOUT THIS CODE' : o.checks.run ? 'CURRENT' : 'NONE'))

  if (o.criteria.length) {
    console.log('\nREQUIREMENT COVERAGE')
    for (const c of o.criteria) {
      console.log(`  ${padTo(truncateToWidth(c.id, 12), 8)}`
        + `${padTo(truncateToWidth(c.requirement ?? '', 52), 54)}${c.status.toUpperCase()}`)
    }
  }

  if (o.reasons.length) {
    console.log(`\nWHY NOT DONE\n${o.reasons.map(r => block(r, '  ')).join('\n\n')}`)
  }

  // One step, not eight. The others are still above; this is the one to take now.
  const next = nextStep(o)
  if (next) {
    console.log(`\nNEXT\n${next.run ? `  ${next.run}\n` : ''}${block(next.why, '  ')}`)
  }

  console.log(`\nManifest:\n  ${file}`)
  console.log(`\nVERDICT\n  ${o.verdict}\n`)
}
