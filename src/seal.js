// Whether the contract that produced a verdict is the contract that was agreed to.
//
// The contract is the definition of "done", so an agent that cannot make it pass can edit it
// instead. `changed` and `check` already say when a diff touched it — but only relative to
// git, and only as a notice. A seal is the stronger statement: this exact contract was
// reviewed, and here is its fingerprint. Anything after that is a new contract, and the
// evidence gathered under the old one is evidence about something else.
//
// Sealing is opt-in and re-sealing is one command. Nothing here forbids changing a contract —
// requirements change, and a tool that made that expensive would be worked around. It makes
// the change visible, and it stops the previous verification chain from being read as if the
// change had not happened.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contractKey, loadSpec, PROOF_DIR, SPEC_PATH, writeError, writeFileAtomic } from './spec.js'
import { criteriaList, satisfied } from './criteria.js'
import { head } from './git.js'
import { block } from './terminal.js'

export const LOCK_PATH = join(PROOF_DIR, 'lock.json')

/**
 * The contract's content, in one canonical form.
 *
 * Over the parsed YAML rather than the file: reindenting a block, rewrapping a comment or
 * reordering two keys does not change what the contract asserts, and a fingerprint that broke
 * on those would be one people reseal past without reading. Key order is normalised for the
 * same reason; list order is not, because the order of checks is part of the contract.
 */
export const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
}

export const sha256 = text => createHash('sha256').update(text).digest('hex')

export const contractHash = spec => sha256(canonical(spec))

/** Short enough to read out, long enough not to collide in a repository's lifetime. */
export const shortHash = hash => (typeof hash === 'string' ? hash.slice(0, 12) : '—')

/**
 * Per-part fingerprints, so `proof diff` can say which criterion moved rather than that one did.
 *
 * `rest` covers everything not itemised — the serve block, the goal, a key added to the language
 * next year. Without it a contract could change in a way the whole-contract hash notices and the
 * diff cannot name, which reads as a tool that has lost track of its own file.
 */
const partHashes = spec => {
  const { criteria, checks, challenges, policy, ...rest } = spec ?? {}
  return {
    criteria: Object.fromEntries(criteriaList(spec).map(c => [String(c.id), sha256(canonical(c))])),
    checks: Object.fromEntries((Array.isArray(checks) ? checks : [])
      .map((c, i) => [String(c?.name ?? `check ${i + 1}`), sha256(canonical(c))])),
    challenges: Object.fromEntries((Array.isArray(challenges) ? challenges : [])
      .map((c, i) => [String(c?.name ?? `challenge ${i + 1}`), sha256(canonical(c))])),
    policy_hash: sha256(canonical(policy ?? null)),
    rest_hash: sha256(canonical(rest)),
  }
}

export function readLock() {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

/**
 * One lock file, one entry per contract.
 *
 * `--spec` lets a repository hold several — a release contract, one per environment — and they
 * all share `.proof`. A single flat record would have let the second seal overwrite the first
 * silently, which is the one failure mode a tool about integrity cannot have.
 */
export const sealOf = (specPath = SPEC_PATH) => readLock()?.sealed?.[contractKey(specPath)] ?? null

/**
 * What the seal says about the contract on disk right now.
 *
 * Three answers. `unsealed` is not a problem — most contracts are — it only means the chain
 * has no anchor. `modified` is the one that costs a completion verdict: evidence gathered
 * before the edit describes a contract nobody has reviewed since.
 */
export function integrity(spec, specPath = SPEC_PATH) {
  const hash = contractHash(spec)
  const sealed = sealOf(specPath)
  if (!sealed) return { status: 'unsealed', hash, sealed: null, sealed_at: null, commit: null }
  return {
    status: sealed.contract_hash === hash ? 'valid' : 'modified',
    hash,
    sealed: sealed.contract_hash ?? null,
    sealed_at: sealed.sealed_at ?? null,
    commit: sealed.commit ?? null,
  }
}

export const MODIFIED_NOTICE = 'the contract has changed since it was sealed (sealed {sealed}, now {now})'
  + ' — every verdict, falsification and challenge recorded under the old contract is evidence about'
  + ' a different definition of "done". `proof diff` shows what moved; `proof seal` accepts it.'

export const fillModifiedNotice = i => MODIFIED_NOTICE
  .replace('{sealed}', shortHash(i.sealed))
  .replace('{now}', shortHash(i.hash))

export function seal({ json = false, specPath } = {}) {
  const path = specPath ?? SPEC_PATH
  const spec = loadSpec(path)                       // a contract that does not validate is not sealable
  const hash = contractHash(spec)
  const previous = sealOf(path)

  const parts = partHashes(spec)
  // The ids as a list, because that is what a reader of the lock wants to see; the per-part
  // hashes beside them, because that is what `proof diff` compares.
  const entry = {
    contract_hash: hash,
    sealed_at: new Date().toISOString(),
    commit: head(),
    goal: spec.goal ?? null,
    criteria: criteriaList(spec).map(c => String(c.id)),
    criteria_hashes: parts.criteria,
    checks: parts.checks,
    challenge_hashes: parts.challenges,
    policy_hash: parts.policy_hash,
    rest_hash: parts.rest_hash,
  }
  const record = { ...(readLock() ?? {}), version: 1 }
  record.sealed = { ...(record.sealed ?? {}), [contractKey(path)]: entry }

  try {
    mkdirSync(PROOF_DIR, { recursive: true })
    writeFileAtomic(LOCK_PATH, `${JSON.stringify(record, null, 2)}\n`)
  } catch (e) {
    throw writeError(e, LOCK_PATH, 'the contract seal',
      'The seal is what later runs are checked against, so it has to live beside the contract.')
  }

  const out = {
    status: previous && previous.contract_hash !== hash ? 'resealed' : 'sealed',
    spec: path,
    contract_hash: hash,
    previous_hash: previous?.contract_hash ?? null,
    sealed_at: entry.sealed_at,
    commit: entry.commit,
    criteria: entry.criteria,
    lock: LOCK_PATH,
  }

  if (json) console.log(JSON.stringify(out, null, 2))
  else {
    console.log(`\nContract sealed.\nSHA256:\n  ${hash}`)
    if (out.status === 'resealed') {
      console.log(`\nThis replaces ${shortHash(previous.contract_hash)}, sealed ${previous.sealed_at}.`)
      console.log(block('Evidence recorded under that contract is evidence about a different definition'
        + ' of "done" — `proof check`, `proof falsify` and `proof challenge` have to run again.', '  '))
    }
    console.log(`\n${out.criteria.length} criterion/criteria: ${out.criteria.join(', ') || '(none declared)'}`)
    console.log(`\nRecorded in ${LOCK_PATH}. Commit it: the seal is what says this contract was reviewed.\n`)
  }
  return 0
}

/** `+` added, `~` changed, `-` removed — the same three marks a diff has always used. */
const marks = (before, after) => ({
  added: Object.keys(after).filter(k => !(k in before)),
  removed: Object.keys(before).filter(k => !(k in after)),
  changed: Object.keys(after).filter(k => k in before && before[k] !== after[k]),
})

/**
 * What changed since the seal, and which criteria that leaves without current evidence.
 *
 * A criterion whose own text moved, or whose checks moved, has to be verified again — the
 * evidence on disk is about the previous wording. A criterion added since is unverified: no
 * run has ever been about it.
 */
export function contractDiff(spec, specPath = SPEC_PATH) {
  const sealed = sealOf(specPath)
  if (!sealed) return null

  const now = partHashes(spec)
  const criteria = marks(sealed.criteria_hashes ?? {}, now.criteria)
  const checks = marks(sealed.checks ?? {}, now.checks)
  // A seal written before challenges existed has no record of them; reporting every challenge
  // as added would be a diff about this tool's own version rather than about the contract.
  const challenges = sealed.challenge_hashes
    ? marks(sealed.challenge_hashes, now.challenges)
    : { added: [], removed: [], changed: [] }
  const goalChanged = (sealed.goal ?? null) !== (spec.goal ?? null)
  const policyChanged = sealed.policy_hash !== undefined && sealed.policy_hash !== now.policy_hash
  const restChanged = sealed.rest_hash !== undefined && sealed.rest_hash !== now.rest_hash && !goalChanged

  // Which criteria the check-level changes land on, so the affected list is about requirements
  // rather than about files.
  const owners = id => (Array.isArray(spec?.checks) ? spec.checks : [])
    .filter(c => satisfied(c).includes(id))
    .map(c => String(c?.name ?? ''))

  const affected = []
  for (const id of Object.keys(now.criteria)) {
    if (criteria.added.includes(id)) { affected.push({ id, status: 'unverified' }); continue }
    const touched = owners(id).some(name => checks.added.includes(name) || checks.changed.includes(name))
    if (criteria.changed.includes(id) || touched || goalChanged) affected.push({ id, status: 'reverify' })
  }

  return {
    spec: specPath,
    sealed_hash: sealed.contract_hash ?? null,
    contract_hash: contractHash(spec),
    sealed_at: sealed.sealed_at ?? null,
    goal_changed: goalChanged,
    policy_changed: policyChanged,
    other_changed: restChanged,
    criteria,
    checks,
    challenges,
    affected,
    unchanged: sealed.contract_hash === contractHash(spec),
  }
}

export function diff({ json = false, specPath } = {}) {
  const path = specPath ?? SPEC_PATH
  const spec = loadSpec(path)
  const d = contractDiff(spec, path)

  if (!d) {
    throw Object.assign(
      new Error(`${path} has never been sealed, so there is nothing to compare it against`
        + ' — `proof seal` records the contract as reviewed, and `proof diff` then shows what moved since.'),
      { code: 'ENOSEAL' })
  }

  if (json) { console.log(JSON.stringify(d, null, 2)); return 0 }

  console.log(`\nCONTRACT CHANGES since ${shortHash(d.sealed_hash)} (sealed ${d.sealed_at})`)
  if (d.unchanged) {
    console.log('\n  none — the contract is exactly what was sealed.\n')
    return 0
  }
  const rows = [
    ...(d.goal_changed ? ['  ~ goal'] : []),
    ...d.criteria.added.map(id => `  + ${id}`),
    ...d.criteria.changed.map(id => `  ~ ${id}`),
    ...d.criteria.removed.map(id => `  - ${id}`),
    ...d.checks.added.map(name => `  + check "${name}"`),
    ...d.checks.changed.map(name => `  ~ check "${name}"`),
    ...d.checks.removed.map(name => `  - check "${name}"`),
    ...d.challenges.added.map(name => `  + challenge "${name}"`),
    ...d.challenges.changed.map(name => `  ~ challenge "${name}"`),
    ...d.challenges.removed.map(name => `  - challenge "${name}"`),
    ...(d.policy_changed ? ['  ~ policy'] : []),
    ...(d.other_changed ? ['  ~ the rest of the contract (the serve block, or a key not itemised here)'] : []),
  ]
  console.log('')
  // The hash says the contract moved; if nothing above can say where, the seal predates the
  // part that changed. Silence there would read as "nothing changed" under a heading saying
  // something did — the one thing a diff must never do.
  console.log(rows.length ? rows.join('\n')
    : block('the contract has changed, and this seal is too old to say where — it was written by a'
      + ' proof that did not fingerprint every part of the file. `proof seal` again to get an'
      + ' itemised diff from here on.', '  '))

  if (d.affected.length) {
    console.log('\nVERIFICATION AFFECTED')
    for (const a of d.affected) console.log(`  ${a.id}   ${a.status === 'unverified' ? 'UNVERIFIED' : 'REVERIFY'}`)
  }
  console.log(`\n${block('This is a new verification generation. Evidence recorded under the sealed contract'
    + ' is not evidence about this one — run the contract again, then `proof seal` to accept it.', '  ')}\n`)
  return 0
}
