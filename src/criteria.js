// The requirement, broken into the statements a verdict has to be about.
//
// A contract can be internally valid and still say nothing about half of what was asked for:
// "implement secure password reset" becomes four checks about the happy path, every one of
// them passes, and token expiry, single use and account enumeration were never verified at
// all. Passing checks are evidence for whatever the checks happen to assert — which is not
// the same as evidence for the requirement.
//
// A criterion names one thing the change has to do. `satisfies` on a check says that check is
// the evidence for it. A criterion nothing points at has no evidence, and a run carrying one
// cannot report completion, however green it is.

/** Criteria as written, or none. A contract without them is the old shape, and still valid. */
export const criteriaList = spec =>
  (Array.isArray(spec?.criteria) ? spec.criteria.filter(c => c !== null && typeof c === 'object' && !Array.isArray(c)) : [])

/** `satisfies: AC1` and `satisfies: [AC1, AC2]` mean the same thing; one is easier to write. */
export const satisfied = check => {
  const value = check?.satisfies
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter(v => typeof v === 'string') : []
}

/**
 * Where a criterion came from, in one line.
 *
 * Free text or `{type, reference}`. Deliberately not an integration: the value of provenance
 * here is that a reader can follow the trail from the verdict back to whoever asked for the
 * behaviour, and a string does that today for a ticket, a spec file or a chat message.
 */
export const describeSource = source => {
  if (source === null || source === undefined) return null
  if (typeof source === 'string') return source
  if (typeof source !== 'object' || Array.isArray(source)) return String(source)
  const { type, reference } = source
  if (type && reference) return `${type} ${reference}`
  return String(reference ?? type ?? '')
}

/** Checks that carry each criterion, by id, in contract order. */
export const evidenceFor = spec => {
  const byId = new Map(criteriaList(spec).map(c => [String(c.id), []]))
  for (const [i, check] of (Array.isArray(spec?.checks) ? spec.checks : []).entries()) {
    for (const id of satisfied(check)) {
      if (byId.has(id)) byId.get(id).push(check?.name ?? `check ${i + 1}`)
    }
  }
  return byId
}

/**
 * Each criterion with the checks that stand for it, and what this run says about them.
 *
 * `results` is optional: `lint` asks the same question of the file alone, before anything has
 * run, and gets `covered` or `uncovered`. With a run it narrows — a criterion whose checks
 * passed is `verified`, one whose check failed is `failed`, and one whose check was skipped or
 * never selected is `unverified`: covered on paper, with no evidence from this run.
 */
export function coverage(spec, results = null) {
  const evidence = evidenceFor(spec)
  const statuses = results
    ? new Map(results.filter(r => r && typeof r.name === 'string').map(r => [r.name, r.status]))
    : null

  return criteriaList(spec).map(c => {
    const checks = evidence.get(String(c.id)) ?? []
    const row = {
      id: String(c.id),
      requirement: typeof c.requirement === 'string' ? c.requirement : null,
      source: describeSource(c.source),
      checks,
    }
    if (!checks.length) return { ...row, status: 'uncovered' }
    if (!statuses) return { ...row, status: 'covered' }

    const got = checks.map(name => statuses.get(name))
    if (got.some(s => s === 'failed')) return { ...row, status: 'failed' }
    if (got.some(s => s !== 'passed')) return { ...row, status: 'unverified' }
    return { ...row, status: 'verified' }
  })
}

/** Criteria with no evidence at all. The reason a green run is still INCOMPLETE. */
export const uncovered = rows => rows.filter(r => r.status === 'uncovered').map(r => r.id)

export const UNCOVERED_NOTICE = 'nothing in this run is evidence for {ids} — no check declares'
  + ' `satisfies` for {them}, so the run cannot report completion however green it is. Add'
  + ' `satisfies: [{first}]` to the check that proves {them}, or write one.'

export const fillUncoveredNotice = ids => UNCOVERED_NOTICE
  .replaceAll('{ids}', ids.join(', '))
  .replaceAll('{them}', ids.length === 1 ? 'it' : 'them')
  .replaceAll('{first}', ids[0])
