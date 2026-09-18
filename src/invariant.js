// The requirement oracle: whether the claim itself was violated, decided without asking the
// contract.
//
// This is the piece that makes a verification gap findable. The contract oracle is the checks
// you already wrote; if it were also the judge of what "violated" means, an attack could only
// ever rediscover what the contract already asserts. An invariant is the claim stated in terms
// of what was observed — `successful_redeem <= 1` — so the two can disagree, and their
// disagreement is the finding.
//
// Deliberately one comparison, not an expression language. A contract is not a place to put
// logic: the moment an invariant needs `&&`, a helper or a lambda, it is a test and belongs in
// one. What is here covers the shape almost every single-use, at-most-once, exactly-once and
// no-error claim takes, and anything it cannot say is refused by name rather than half-parsed.

const OPS = {
  '<=': (a, b) => a <= b,
  '>=': (a, b) => a >= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
}

/** `successful_redeem <= 1` — a term, a comparison, a whole number. */
const GRAMMAR = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(<=|>=|==|!=|<|>)\s*(\d+)\s*$/

/** Written as text, or as `{expression: ...}`. Both say the same thing; one is easier to type. */
export const expressionOf = invariant =>
  (typeof invariant === 'string' ? invariant : invariant?.expression)

/**
 * What a term counts, given the steps an attack executed.
 *
 * `successful` is status below 400 for a request and exit 0 for a command: the operation the
 * step names actually happened. That is the thing a single-use claim is about — not whether the
 * app answered politely.
 */
export function terms(observation) {
  const steps = observation?.steps ?? []
  const ok = steps.filter(s => s.ok)
  const counts = {
    successes: ok.length,
    failures: steps.length - ok.length,
    steps: steps.length,
  }

  for (const step of steps) {
    if (typeof step.action === 'string') {
      counts[`successful_${step.action}`] = (counts[`successful_${step.action}`] ?? 0) + (step.ok ? 1 : 0)
      counts[`failed_${step.action}`] = (counts[`failed_${step.action}`] ?? 0) + (step.ok ? 0 : 1)
    }
    if (typeof step.status === 'number') {
      counts[`status_${step.status}`] = (counts[`status_${step.status}`] ?? 0) + 1
      const family = `status_${Math.floor(step.status / 100)}xx`
      counts[family] = (counts[family] ?? 0) + 1
    }
  }
  return counts
}

/**
 * Every term this observation could be asked about, for an error message that names the
 * alternatives rather than the grammar. A typo in an action name is the likeliest mistake, and
 * "unknown term" with no list is a message that sends someone to the source.
 */
export const knownTerms = (actions = []) => [
  'successes', 'failures', 'steps',
  ...actions.flatMap(name => [`successful_${name}`, `failed_${name}`]),
  'status_<code>', 'status_2xx', 'status_4xx', 'status_5xx',
]

/** Why this invariant cannot be evaluated, or null. Same shape as every other validator here. */
export function invariantProblem(invariant, where, actions = []) {
  const expression = expressionOf(invariant)
  if (typeof expression !== 'string' || !expression.trim()) {
    return `${where}: must be a comparison, as text — \`successful_redeem <= 1\``
  }
  const m = expression.match(GRAMMAR)
  if (!m) {
    return `${where}: "${expression}" is not one comparison of a counted term against a whole number`
      + ` — proof reads \`<term> <op> <n>\` and nothing else. Terms: ${knownTerms(actions).join(', ')}`
  }
  const [, term] = m
  const literal = /^status_\d{3}$/.test(term) || /^status_[1-5]xx$/.test(term)
  if (!literal && !knownTerms(actions).includes(term)) {
    return `${where}: unknown term "${term}" — the actions here are ${actions.length ? actions.map(a => `\`${a}\``).join(', ') : '(none)'}.`
      + ` Available: ${knownTerms(actions).join(', ')}`
  }
  return null
}

/**
 * The invariant against one observation.
 *
 * A term nothing produced counts zero rather than failing: "no redemption succeeded" is a real
 * observation, and treating an absent count as an error would make every invariant about a
 * request that never happened unevaluable.
 */
export function evaluate(invariant, observation) {
  const expression = expressionOf(invariant)
  const m = String(expression).match(GRAMMAR)
  if (!m) return { held: null, error: `cannot evaluate "${expression}"` }

  const [, term, op, bound] = m
  const observed = terms(observation)[term] ?? 0
  const limit = Number(bound)
  return {
    held: OPS[op](observed, limit),
    expression,
    term,
    observed,
    expected: `${term} ${op} ${limit}`,
  }
}

/** The first invariant this observation breaks, or null. */
export function firstViolation(invariants, observation) {
  for (const invariant of invariants ?? []) {
    const result = evaluate(invariant, observation)
    if (result.held === false) return result
  }
  return null
}

/**
 * A server error is not a claim violation — it is something worth looking at.
 *
 * Kept separate from the invariants for exactly that reason: `500` on a malformed body is a
 * defect and says nothing about whether tokens are single-use. It becomes a
 * COUNTEREXAMPLE_CANDIDATE, never a proven violation of the claim.
 */
export const serverError = observation =>
  (observation?.steps ?? []).find(s => typeof s.status === 'number' && s.status >= 500) ?? null
