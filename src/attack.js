// Searching for a way to be wrong that the contract would accept.
//
// Everything else in this tool asks whether the implementation satisfies the contract.
// `challenge` asks whether the contract catches faults someone wrote down. This asks the
// question underneath both: **can a scenario be found where the contract passes and the claim
// is violated?** That finding — a verification gap — is the one worth the most, because it is
// the verifier itself being wrong, and nothing else here can see it.
//
// It needs two judges that can disagree. The contract oracle is the checks that carry the
// criterion. The requirement oracle is an invariant written in terms of what was observed
// (`successful_redeem <= 1`). If only the first says yes, the contract has a hole in it.
//
// Nothing here proves anything correct, and the output never says so: a search that found
// nothing reports what it tried and how long it had. An attack that finds nothing is a budget
// that ran out, not a theorem.
import { mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { contractKey, loadSpec, PROOF_DIR, SPEC_PATH, writeError, writeFileAtomic } from './spec.js'
import { criteriaList, satisfied } from './criteria.js'
import { contractHash } from './seal.js'
import { boot, kill, RUNNERS } from './check.js'
import { serveList } from './validate.js'
import { firstViolation, serverError, expressionOf } from './invariant.js'
import { save as saveCounterexample, markReplay, read as readCounterexample, pathOf } from './counterexample.js'
import { substitute, captureValue } from './vars.js'
import { fingerprint, head } from './git.js'
import { slug } from './browser.js'
import { block, columnWidth, padTo, truncateToWidth } from './terminal.js'

export const RECORD_PATH = join(PROOF_DIR, 'attacks.json')

/**
 * What an attack can end as.
 *
 * Five, not two, for the same reason every other verdict here refuses to be binary: "found
 * nothing" and "proved correct" are different claims, and only one of them is true.
 */
export const RESULT = {
  none: 'NO_COUNTEREXAMPLE_FOUND',
  candidate: 'COUNTEREXAMPLE_CANDIDATE',
  violation: 'CLAIM_VIOLATION',
  gap: 'VERIFICATION_GAP',
  error: 'ATTACK_ERROR',
}

export const DEFAULT_BUDGET = { duration: 60, candidates: 50, concurrency: 4 }

/** Surfaces the engine can drive today. The others in the design note need a state model. */
export const SURFACES = ['input', 'sequence', 'concurrency']

/**
 * Claims whose wording has a known way of going wrong.
 *
 * Rule-based on purpose: "can only be used once" is a shape, not a sentiment, and a table of
 * shapes can suggest an attack surface without a model in the loop. It only ever suggests —
 * an attack proof was not told it may run is one it does not run.
 */
export const PATTERNS = [
  { test: /\b(only|just)\b[^.]{0,40}\bonce\b|\b(single[- ]use|exactly once|at most once|idempotent|reused|twice)\b/i,
    surfaces: ['concurrency', 'sequence'],
    why: 'a claim about something happening at most once is broken by two of it at the same time' },
  { test: /\b(expires?|expiry|expired|timeout|lifetime|ttl)\b/i,
    surfaces: ['sequence', 'state'],
    why: 'a claim about expiry is broken by using the thing on either side of the boundary' },
  { test: /\b(another|other) (user|tenant|account|customer)\b|\bnot (access|read|see|modify)\b/i,
    surfaces: ['identity'],
    why: 'a claim about who may not do something is broken by doing it as someone else' },
  { test: /\b(never|must not|cannot) (be )?(negative|exceed|below|above|zero)\b|\bat least\b|\bat most\b/i,
    surfaces: ['input'],
    why: 'a claim with a bound in it is broken at the bound' },
]

export const suggestionsFor = requirement =>
  PATTERNS.filter(p => p.test.test(String(requirement ?? '')))
    .flatMap(p => p.surfaces.map(s => ({ surface: s, why: p.why })))

/** Criteria that declare what may be manipulated, and what must remain true while it is. */
export const attackable = spec => criteriaList(spec).filter(c => c?.attack?.actions?.length && c?.attack?.invariants?.length)

const budgetOf = (criterion, override) => ({
  ...DEFAULT_BUDGET,
  ...(criterion.attack?.budget ?? {}),
  ...(override ?? {}),
})

/** Deterministic, small, and seeded — so a run that found something can be run again. */
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const shuffled = (items, random) => {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// --- what a candidate is made of ----------------------------------------------------------

/**
 * The values an input attack tries.
 *
 * The list every fuzzer starts from, and it is short on purpose: these are the values that
 * break parsing, validation and arithmetic in code nobody thought about them in. A generator
 * that produced thousands of random strings would spend the budget proving the same point.
 */
export const BOUNDARY_VALUES = [
  { label: 'empty string', value: '' },
  { label: 'null', value: null },
  { label: 'zero', value: 0 },
  { label: 'negative', value: -1 },
  { label: 'very large', value: 2147483648 },
  { label: 'very long', value: 'A'.repeat(4096) },
  { label: 'unicode', value: '🙂 ÜNI çödé' },
  { label: 'wrong type', value: [] },
]

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)

const candidateId = candidate => `ce-${createHash('sha256')
  .update(JSON.stringify([candidate.criterion, candidate.strategy, candidate.steps]))
  .digest('hex').slice(0, 8)}`

/**
 * One step, executed, reported as what happened rather than as a verdict.
 *
 * The check runners decide pass and fail against an `expect`; an attack has no expectations,
 * only observations. `ok` is the operation having actually happened — a status below 400, or a
 * command that exited 0 — because that is what a claim like "at most once" counts.
 */
async function runStep(action, ctx, vars, permissions = {}) {
  const kind = ['http', 'run'].find(k => k in action)

  // The network boundary, enforced where the request is made rather than described in a doc.
  // An attack composes the operations a contract already performs; reaching a host the contract
  // never names is not an attack on this app, it is an attack on someone else's.
  if (kind === 'http' && typeof action.http?.url === 'string' && permissions.network !== 'any') {
    const sameOrigin = (() => {
      try { return new URL(action.http.url).origin === new URL(ctx.baseUrl).origin } catch { return false }
    })()
    if (!sameOrigin) {
      return {
        action: action.name,
        ok: false,
        error: `"${action.http.url}" is not the app this contract starts — set`
          + ' `permissions: {network: any}` on the attack block to allow another host',
      }
    }
  }
  const { run: command, ...rest } = action
  const { filled, missing } = substitute(rest, vars)
  if (command !== undefined) filled.run = substitute(command, vars).filled
  if (missing.length) {
    return { action: action.name, ok: false, error: `no value for ${missing.map(n => `\${${n}}`).join(', ')}` }
  }

  let r
  try {
    r = await RUNNERS[kind](filled, ctx)
  } catch (e) {
    return { action: action.name, ok: false, error: `runner crashed: ${e.message}` }
  }

  const status = kind === 'http' ? r.source?.status ?? null : null
  const exit = kind === 'run' ? r.exit_code ?? null : null
  const ok = kind === 'http' ? typeof status === 'number' && status < 400 : exit === 0

  if (ok && isPlain(action.capture)) {
    for (const [name, selector] of Object.entries(action.capture)) {
      const got = captureValue(selector, r.source ?? {})
      if (!got.error) vars.set(name, got.value)
    }
  }
  return { action: action.name, ok, status, exit_code: exit, observed: r.observed ?? null }
}

/**
 * A candidate, executed against the running app.
 *
 * Setup runs first and must succeed: a scenario built on a token that was never issued observes
 * nothing about the claim, and reporting that as a finding would be the loudest possible false
 * positive. That case is an ATTACK_ERROR, named as one.
 */
async function execute(candidate, plan, ctx) {
  const vars = new Map()
  const steps = []

  for (const step of plan.setup) {
    const observed = await runStep(step, ctx, vars, plan.permissions)
    steps.push({ ...observed, phase: 'setup' })
    if (!observed.ok) return { steps, error: `setup step "${step.name}" did not succeed${observed.error ? ` — ${observed.error}` : ''}` }
  }

  for (const step of candidate.steps) {
    if (step.parallel) {
      // The whole point of the concurrency surface: two of the same operation, in flight at
      // once, sharing whatever the app uses to decide that only one of them may win.
      const together = await Promise.all(
        step.parallel.map(name => runStep(plan.byName.get(name), ctx, new Map(vars), plan.permissions)))
      steps.push(...together.map(s => ({ ...s, phase: 'attack', parallel: true })))
      continue
    }
    const action = step.mutate ? mutated(plan.byName.get(step.action), step.mutate) : plan.byName.get(step.action)
    steps.push({ ...(await runStep(action, ctx, vars, plan.permissions)), phase: 'attack' })
  }
  return { steps, error: null }
}

/** An action with one body field replaced — the input surface, applied to one place at a time. */
const mutated = (action, { field, value }) => ({
  ...action,
  http: { ...action.http, body: { ...(action.http?.body ?? {}), [field]: value } },
})

// --- strategies ----------------------------------------------------------------------------

/**
 * Sequences. The ordering questions a contract almost never asks: the same operation twice, an
 * operation after the one that should have ended it, two in the wrong order.
 */
function sequenceCandidates(plan) {
  const names = plan.actions.map(a => a.name)
  const out = []
  for (const name of names) {
    out.push({ strategy: 'sequence', hypothesis: `${name} twice in a row may both succeed`, steps: [{ action: name }, { action: name }] })
  }
  for (const first of names) {
    for (const second of names) {
      if (first === second) continue
      out.push({
        strategy: 'sequence',
        hypothesis: `${second} may still succeed after ${first}`,
        steps: [{ action: first }, { action: second }],
      })
      out.push({
        strategy: 'sequence',
        hypothesis: `${first} may still succeed after ${first} then ${second}`,
        steps: [{ action: first }, { action: second }, { action: first }],
      })
    }
  }
  return out
}

/** The same operation, at once. What a sequence of requests structurally cannot show. */
function concurrencyCandidates(plan, budget) {
  const out = []
  for (const action of plan.actions) {
    for (let n = 2; n <= Math.max(2, budget.concurrency); n++) {
      out.push({
        strategy: 'concurrency',
        hypothesis: `${n} concurrent ${action.name} requests may all succeed`,
        steps: [{ parallel: Array.from({ length: n }, () => action.name) }],
      })
    }
  }
  return out
}

/** One body field at a time, replaced with a value the code was not written for. */
function inputCandidates(plan) {
  const out = []
  for (const action of plan.actions) {
    const body = action.http?.body
    if (!isPlain(body)) continue
    for (const field of Object.keys(body)) {
      for (const boundary of BOUNDARY_VALUES) {
        out.push({
          strategy: 'input',
          hypothesis: `${action.name} with ${field} as ${boundary.label}`,
          steps: [{ action: action.name, mutate: { field, value: boundary.value } }],
        })
      }
    }
  }
  return out
}

/**
 * Candidates from a program rather than from the strategies here.
 *
 * The seam for an adversarial agent, a property-based generator, a model-based explorer. It
 * proposes; proof executes and judges. A hypothesis is not evidence, and nothing that arrives
 * through here is trusted any further than a candidate this file generated itself.
 */
export function generatedCandidates(command, criterion, plan) {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PROOF_ATTACK_CRITERION: criterion.id, PROOF_ATTACK_ACTIONS: plan.actions.map(a => a.name).join(',') } })
  if (r.error) throw Object.assign(new Error(`could not run \`${command}\` — ${r.error.message}`), { code: 'EUSAGE' })
  if (r.status !== 0) {
    throw Object.assign(
      new Error(`\`${command}\` exited ${r.status} and proposed nothing:\n${(r.stdout + r.stderr).trim()}`),
      { code: 'EUSAGE' })
  }

  let parsed
  try { parsed = JSON.parse(r.stdout) } catch {
    throw Object.assign(
      new Error(`\`${command}\` did not print JSON — an attack generator prints a list of`
        + ' `{hypothesis, strategy, steps}` objects on stdout'),
      { code: 'EUSAGE' })
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.candidates
  if (!Array.isArray(list)) throw Object.assign(new Error(`\`${command}\` printed JSON that is not a list of candidates`), { code: 'EUSAGE' })

  const known = new Set(plan.actions.map(a => a.name))
  return list.map((c, i) => {
    const steps = Array.isArray(c?.steps) ? c.steps : null
    if (!steps?.length) throw Object.assign(new Error(`candidate[${i}] from \`${command}\` has no steps`), { code: 'EUSAGE' })
    for (const step of steps) {
      const names = step?.parallel ?? [step?.action]
      for (const name of names) {
        if (known.has(name)) continue
        throw Object.assign(
          new Error(`candidate[${i}] from \`${command}\` uses action "${name}", which this criterion does not`
            + ` declare — a generator may compose the declared actions (${[...known].join(', ')}), not invent operations`),
          { code: 'EUSAGE' })
      }
    }
    return {
      strategy: 'generated',
      hypothesis: typeof c.hypothesis === 'string' ? c.hypothesis : `candidate ${i + 1} from ${command}`,
      steps,
    }
  })
}

// --- the contract oracle ---------------------------------------------------------------------

/**
 * What the contract says about the state the attack just produced.
 *
 * The checks that carry this criterion, run against the same app, right now. This is the half
 * that makes a gap visible: an attack that violates the claim while these still pass has found
 * the contract agreeing with something the requirement forbids.
 */
async function contractOracle(spec, criterion, ctx) {
  const carries = new Set((spec.checks ?? [])
    .filter(c => satisfied(c).includes(String(criterion.id)) && c.skip === undefined)
    .map(c => c.name))
  if (!carries.size) return { checks: [], passed: false }

  // The whole contract, in order, against the app as it stands — not just the checks that carry
  // the criterion. A check that reads `${token}` is only meaningful after the one that captured
  // it, and an oracle that ran it alone would be asking a question the contract never asks.
  const vars = new Map()
  const session = { baseUrl: ctx.baseUrl, runDir: ctx.runDir, cookies: new Map() }
  const results = []

  for (const c of spec.checks ?? []) {
    if (c.skip !== undefined) continue
    const kind = Object.keys(RUNNERS).find(k => k in c)
    if (!kind) continue

    const { run: command, ...rest } = c
    const { filled, missing } = substitute(rest, vars)
    if (command !== undefined) filled.run = substitute(command, vars).filled

    let r
    if (missing.length) r = { status: 'failed', observed: `no value for ${missing.join(', ')}` }
    else {
      try { r = await RUNNERS[kind](filled, session) } catch (e) { r = { status: 'failed', observed: e.message } }
    }

    if (r.status === 'passed' && isPlain(filled.capture)) {
      for (const [name, selector] of Object.entries(filled.capture)) {
        const got = captureValue(selector, r.source ?? {})
        if (!got.error) vars.set(name, got.value)
      }
    }
    if (carries.has(c.name)) results.push({ check: c.name, status: r.status, observed: r.observed ?? null })
  }

  return { checks: results, passed: results.length > 0 && results.every(r => r.status === 'passed') }
}

/** The classification table from the design note, in one place. */
export function classify({ violated, contractPassed, anyContract, errored, suspicious }) {
  if (errored) return RESULT.error
  if (violated && contractPassed && anyContract) return RESULT.gap
  if (violated) return RESULT.violation
  if (suspicious) return RESULT.candidate
  return RESULT.none
}

// --- the engine -------------------------------------------------------------------------------

const planFor = criterion => {
  const actions = criterion.attack.actions ?? []
  return {
    actions,
    setup: criterion.attack.setup ?? [],
    byName: new Map(actions.map(a => [a.name, a])),
    invariants: criterion.attack.invariants ?? [],
    surfaces: criterion.attack.surfaces ?? SURFACES,
    permissions: criterion.attack.permissions ?? {},
  }
}

function candidatesFor(plan, budget, random, only) {
  const wanted = s => (only ? only === s : plan.surfaces.includes(s))
  const generated = [
    ...(wanted('concurrency') ? concurrencyCandidates(plan, budget) : []),
    ...(wanted('sequence') ? sequenceCandidates(plan) : []),
    ...(wanted('input') ? inputCandidates(plan) : []),
  ]
  // Concurrency first, then a seeded shuffle of the rest: the cheapest strong attack should not
  // wait behind four hundred boundary values, and what comes after should not be alphabetical.
  const [head, tail] = [generated.filter(c => c.strategy === 'concurrency'), generated.filter(c => c.strategy !== 'concurrency')]
  return [...head, ...shuffled(tail, random)]
}

/**
 * The scenario, reduced to what still breaks the claim.
 *
 * A finding with seventeen steps is a finding nobody reads and nobody fixes. Remove one step,
 * run it again, keep the removal if the claim still breaks — the standard delta reduction, with
 * the replays bounded because each one costs a round trip against a live app.
 */
export async function minimize(candidate, plan, ctx, invariants, limit = 12) {
  let best = candidate
  let replays = 0

  for (let i = best.steps.length - 1; i >= 0 && replays < limit; i--) {
    const steps = best.steps.filter((_, at) => at !== i)
    if (!steps.length) continue
    replays += 1
    const observation = await execute({ ...best, steps }, plan, ctx)
    if (observation.error) continue
    if (firstViolation(invariants, observation)) best = { ...best, steps, observation }
  }

  // And the width of a parallel step: two at once is the claim, five is the same claim louder.
  for (const [at, step] of best.steps.entries()) {
    if (!step.parallel || step.parallel.length <= 2 || replays >= limit) continue
    const steps = best.steps.map((s, i) => (i === at ? { parallel: s.parallel.slice(0, 2) } : s))
    replays += 1
    const observation = await execute({ ...best, steps }, plan, ctx)
    if (!observation.error && firstViolation(invariants, observation)) best = { ...best, steps, observation }
  }
  return best
}

const responds = async url => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) })
    return true
  } catch { return false }
}

/**
 * The app this runs against, started and stopped exactly once.
 *
 * `attach` is for replay, and only for replay. A promoted counterexample is an ordinary check
 * inside `proof check`, which has already started the app — booting a second one would collide
 * on the port and report the enclosing run as the squatter. An attack keeps the stricter rule
 * `check` follows: it starts what it observes, so that what it observes is this code.
 */
async function withApp(spec, fn, { attach = false } = {}) {
  const serves = serveList(spec)
  const base = serves.map(s => s.ready_url ?? s.url).filter(Boolean).at(-1)

  if (attach && base && await responds(base)) {
    return { attached: true, value: await fn({ baseUrl: base, cookies: new Map(), runDir: PROOF_DIR }) }
  }

  const started = []
  try {
    for (const serve of serves) started.push(await boot(serve))
    return { attached: false, value: await fn({ baseUrl: base, cookies: new Map(), runDir: PROOF_DIR }) }
  } finally {
    for (const server of [...started].reverse()) kill(server.proc)
  }
}

function record(out, specPath) {
  let existing = {}
  try { existing = JSON.parse(readFileSync(RECORD_PATH, 'utf8')) ?? {} } catch {}
  const next = { ...existing, version: 1, records: { ...(existing.records ?? {}), [contractKey(specPath)]: out } }
  try {
    mkdirSync(PROOF_DIR, { recursive: true })
    writeFileAtomic(RECORD_PATH, `${JSON.stringify(next, null, 2)}\n`)
  } catch (e) {
    throw writeError(e, RECORD_PATH, 'the attack record',
      '`proof done` reads it to decide whether anything went looking for a counterexample.')
  }
}

export function readAttacks(specPath = SPEC_PATH) {
  try {
    return JSON.parse(readFileSync(RECORD_PATH, 'utf8'))?.records?.[contractKey(specPath)] ?? null
  } catch { return null }
}

/** Seconds from `5m`, `90s`, `120`. A budget nobody can write is a budget nobody sets. */
export function parseBudget(value) {
  if (value === undefined) return undefined
  const m = String(value).match(/^(\d+)(s|m|h)?$/)
  if (!m) throw Object.assign(new Error(`--budget takes a duration like 90s, 5m or 2h (got "${value}")`), { code: 'EUSAGE' })
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] ?? 's']
}

export async function attack({ json = false, criterion: only, budget: durationOverride, seed, strategy, from, specPath } = {}) {
  const path = specPath ?? SPEC_PATH
  const spec = loadSpec(path)

  if (strategy && !SURFACES.includes(strategy)) {
    throw Object.assign(
      new Error(`--strategy takes one of ${SURFACES.join(', ')} (got "${strategy}")`), { code: 'EUSAGE' })
  }
  if (!serveList(spec).length) {
    throw Object.assign(
      new Error('this contract starts nothing, so there is no running application to attack — an attack'
        + ' composes requests against the app a `serve` block brings up'),
      { code: 'ENOSERVE' })
  }

  const all = attackable(spec)
  const chosen = only ? all.filter(c => String(c.id) === only) : all
  if (only && !chosen.length) {
    const declared = criteriaList(spec).some(c => String(c.id) === only)
    throw Object.assign(
      new Error(declared
        ? `${only} declares no attack surface — add an \`attack:\` block with \`actions\` and`
          + ' `invariants` to say what may be manipulated and what must remain true'
        : `no criterion "${only}" is declared (have: ${criteriaList(spec).map(c => c.id).join(', ') || 'none'})`),
      { code: 'ENOCRITERION' })
  }
  if (!chosen.length) {
    const hints = criteriaList(spec).flatMap(c => suggestionsFor(c.requirement).map(s => ({ id: c.id, ...s })))
    throw Object.assign(
      Object.assign(new Error('no criterion in this contract declares an attack surface — an attack needs'
        + ' `actions` it may compose and `invariants` that must hold while it does'
        + (hints.length
          ? `\n  ${hints.map(h => `${h.id}: ${h.surface} — ${h.why}`).join('\n  ')}`
          : '')), { hints }),
      { code: 'ENOATTACK' })
  }

  const usedSeed = seed === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(seed)
  const findings = []
  const summaries = []

  const { value: _attacked } = await withApp(spec, async ctx => {
    for (const criterion of chosen) {
      const plan = planFor(criterion)
      const budget = budgetOf(criterion, durationOverride === undefined ? undefined : { duration: durationOverride })
      const random = rng(usedSeed)
      const candidates = from
        ? generatedCandidates(from, criterion, plan)
        : candidatesFor(plan, budget, random, strategy)

      const deadline = Date.now() + budget.duration * 1000
      let evaluated = 0
      let finding = null
      let suspicious = null

      for (const candidate of candidates) {
        if (evaluated >= budget.candidates || Date.now() > deadline) break
        evaluated += 1

        const observation = await execute(candidate, plan, ctx)
        if (observation.error) {
          finding = {
            criterion: String(criterion.id),
            result: RESULT.error,
            hypothesis: candidate.hypothesis,
            reason: observation.error,
          }
          break
        }

        const violation = firstViolation(plan.invariants, observation)
        const error5xx = serverError(observation)
        if (!violation && !error5xx) continue

        const contract = await contractOracle(spec, criterion, ctx)
        const result = classify({
          violated: Boolean(violation),
          contractPassed: contract.passed,
          anyContract: contract.checks.length > 0,
          errored: false,
          suspicious: Boolean(error5xx),
        })

        if (result === RESULT.candidate && !suspicious) {
          // Worth reporting, never worth stopping for: a 500 is a defect and says nothing about
          // whether the claim holds. Keep looking for something that does.
          suspicious = {
            criterion: String(criterion.id),
            result,
            strategy: candidate.strategy,
            hypothesis: candidate.hypothesis,
            observed: `status ${error5xx.status} from ${error5xx.action}`,
          }
          continue
        }
        if (result === RESULT.none) continue

        const reduced = await minimize({ ...candidate, criterion: String(criterion.id) }, plan, ctx, plan.invariants)
        const final = await execute(reduced, plan, ctx)
        const confirmed = firstViolation(plan.invariants, final) ?? violation

        finding = {
          criterion: String(criterion.id),
          result,
          strategy: candidate.strategy,
          hypothesis: candidate.hypothesis,
          invariant: confirmed.expected,
          observed: `${confirmed.term} was ${confirmed.observed}`,
          contract: contract.checks,
          counterexample: saveCounterexample({
            id: candidateId({ ...reduced, criterion: String(criterion.id) }),
            criterion: String(criterion.id),
            criteria: [String(criterion.id)],
            claim: criterion.requirement ?? null,
            strategy: candidate.strategy,
            hypothesis: candidate.hypothesis,
            spec: path,
            contract_hash: contractHash(spec),
            commit: head(),
            found_at: new Date().toISOString(),
            seed: usedSeed,
            setup: plan.setup.map(s => s.name),
            steps: reduced.steps,
            invariant: confirmed.expected,
            observed: (final.error ? observation : final).steps
              .filter(s => s.phase === 'attack')
              .map(s => ({ action: s.action, status: s.status ?? null, ok: s.ok })),
            result: `${confirmed.term} = ${confirmed.observed}`,
            contract_result: contract.passed ? 'PASS' : 'FAIL',
            requirement_result: 'VIOLATED',
            classification: result,
          }),
        }
        break
      }

      const outcome = finding ?? suspicious ?? { criterion: String(criterion.id), result: RESULT.none }
      summaries.push({
        ...outcome,
        claim: criterion.requirement ?? null,
        strategies: from ? ['generated'] : (strategy ? [strategy] : plan.surfaces.filter(s => SURFACES.includes(s))),
        candidates_evaluated: evaluated,
        budget,
      })
      if (outcome.result === RESULT.gap || outcome.result === RESULT.violation || outcome.result === RESULT.error) {
        findings.push(outcome)
      }
    }
  })

  const out = {
    status: summaries.some(s => s.result === RESULT.gap) ? 'verification_gap'
      : summaries.some(s => s.result === RESULT.violation) ? 'claim_violation'
        : summaries.some(s => s.result === RESULT.error) ? 'error'
          : 'no_counterexample_found',
    at: new Date().toISOString(),
    spec: path,
    contract_hash: contractHash(spec),
    commit: head(),
    // The tree, not just the commit: a scenario searched before an uncommitted edit says nothing
    // about the code that is here now, and `done` has to be able to tell.
    tree: fingerprint(),
    seed: usedSeed,
    criteria: summaries,
    gaps: summaries.filter(s => s.result === RESULT.gap).map(s => s.criterion),
    violations: summaries.filter(s => s.result === RESULT.violation).map(s => s.criterion),
    counterexamples: summaries.map(s => s.counterexample).filter(Boolean),
  }

  record(out, path)
  if (json) console.log(JSON.stringify(out, null, 2))
  else printHuman(out)

  return findings.length ? 1 : 0
}

const NAME_COLUMN_MAX = 48

function printHuman(o) {
  console.log('\nATTACK')
  console.log(`\n${block('Searching for a scenario where the contract passes and the claim does not hold.'
    + ' Nothing here proves anything correct — a search that finds nothing is a budget that ran out.', '  ')}`)

  const w = columnWidth(o.criteria.map(c => c.criterion), NAME_COLUMN_MAX)
  console.log('\nCRITERIA')
  for (const c of o.criteria) {
    console.log(`  ${padTo(truncateToWidth(c.criterion, NAME_COLUMN_MAX), w + 2)}${c.result}`)
    if (c.claim) console.log(block(c.claim, '      '))
  }

  for (const c of o.criteria.filter(x => x.result === RESULT.gap || x.result === RESULT.violation)) {
    console.log(`\n${c.result === RESULT.gap ? 'VERIFICATION GAP' : 'CLAIM VIOLATION'}  ${c.criterion}`)
    console.log(block(c.hypothesis, '  '))
    console.log(`  Invariant:\n    ${c.invariant}`)
    console.log(`  Observed:\n    ${c.observed}`)
    if (c.contract?.length) {
      console.log(`  Contract:\n${c.contract.map(r => `    ${r.check}: ${r.status.toUpperCase()}`).join('\n')}`)
    }
    if (c.result === RESULT.gap) {
      console.log(block('The checks that carry this criterion passed while it was violated — the contract'
        + ' cannot see this, which is why the run says so here rather than in a verdict.', '  '))
    }
    console.log(`  Counterexample:\n    ${c.counterexample}`)
  }

  for (const c of o.criteria.filter(x => x.result === RESULT.candidate)) {
    console.log(`\nCOUNTEREXAMPLE CANDIDATE  ${c.criterion}`)
    console.log(block(`${c.hypothesis} — ${c.observed}. A server error is a defect and says nothing`
      + ' about whether the claim holds, so it is reported rather than counted as a violation.', '  '))
  }

  for (const c of o.criteria.filter(x => x.result === RESULT.error)) {
    console.log(`\nATTACK ERROR  ${c.criterion}\n${block(c.reason ?? 'the scenario could not be executed', '  ')}`)
  }

  const evaluated = o.criteria.reduce((n, c) => n + (c.candidates_evaluated ?? 0), 0)
  const strategies = [...new Set(o.criteria.flatMap(c => c.strategies ?? []))]
  console.log(`\nSEARCH\n  strategies: ${strategies.join(', ') || 'none'}`)
  console.log(`  candidates evaluated: ${evaluated}`)
  console.log(`  seed: ${o.seed} (\`--seed ${o.seed}\` runs this search again)`)

  const verdict = {
    verification_gap: 'VERIFICATION GAP FOUND',
    claim_violation: 'CLAIM VIOLATION FOUND',
    error: 'ATTACK ERROR',
    no_counterexample_found: 'NO COUNTEREXAMPLE FOUND',
  }[o.status]
  console.log(`\nVERDICT\n  ${verdict}`)
  if (o.status === 'no_counterexample_found') {
    console.log(block('This does not establish correctness. It says this search, with this budget, did not'
      + ' find a scenario that breaks the invariants written down.', '  '))
  }
  console.log('')
}

// --- replay -----------------------------------------------------------------------------------

/**
 * The counterexample, run again.
 *
 * Exit 0 when it no longer reproduces, which reads backwards for a moment and is the right way
 * round for everything that uses it: green means the claim holds, and a promoted counterexample
 * is an ordinary check that passes once the bug is fixed.
 */
export async function replay({ id, json = false, specPath } = {}) {
  const path = specPath ?? SPEC_PATH
  const spec = loadSpec(path)
  const example = readCounterexample(id)

  if (!example) {
    throw Object.assign(new Error(`no counterexample "${id}" — \`proof report --list\` is runs;`
      + ' counterexamples live in .proof/counterexamples'), { code: 'ENOCOUNTEREXAMPLE' })
  }
  if (!Array.isArray(example.steps)) {
    throw Object.assign(
      new Error(`${pathOf(id)} records a fault, not a scenario — \`proof challenge\` re-runs those`),
      { code: 'ENOCOUNTEREXAMPLE' })
  }

  const criterion = criteriaList(spec).find(c => String(c.id) === String(example.criterion))
  if (!criterion?.attack) {
    throw Object.assign(
      new Error(`${example.criterion} no longer declares an attack surface, so its scenario cannot be`
        + ' replayed — the actions it names come from that block'),
      { code: 'ENOCRITERION' })
  }

  const plan = planFor(criterion)
  const invariants = example.invariant ? [example.invariant.replace(/\s+/g, ' ')] : plan.invariants
  const { attached, value: observation } = await withApp(spec, ctx => execute({ steps: example.steps }, plan, ctx), { attach: true })

  const violation = observation.error ? null : firstViolation(invariants, observation)
  const reproduced = Boolean(violation)
  markReplay(example.id, { reproduced, error: observation.error ?? null })

  const out = {
    counterexample: example.id,
    criterion: example.criterion,
    claim: example.claim ?? null,
    reproduced,
    invariant: expressionOf(invariants[0]) ?? null,
    observed: violation ? `${violation.term} = ${violation.observed}` : null,
    error: observation.error ?? null,
    attached,
    steps: observation.steps.filter(s => s.phase === 'attack').map(s => ({ action: s.action, status: s.status ?? null, ok: s.ok })),
  }

  if (json) console.log(JSON.stringify(out, null, 2))
  else {
    console.log(`\nREPLAY ${example.id}`)
    if (out.claim) console.log(`\nClaim:\n${block(out.claim, '  ')}`)
    if (attached) {
      console.log(block('Something was already answering at the contract\'s URL, so the scenario ran'
        + ' against that rather than starting a second app — which is what happens when a promoted'
        + ' counterexample runs inside `proof check`.', '  '))
    }
    console.log('\nSTEPS')
    for (const step of out.steps) {
      console.log(`  ${padTo(truncateToWidth(step.action ?? '(step)', NAME_COLUMN_MAX), 32)}${step.status ?? (step.ok ? 'ok' : 'failed')}`)
    }
    if (out.error) console.log(`\nATTACK ERROR\n${block(out.error, '  ')}`)
    else {
      console.log(`\nInvariant:\n  ${out.invariant}`)
      console.log(`Observed:\n  ${out.observed ?? 'the invariant held'}`)
    }
    console.log(`\nVERDICT\n  ${out.error ? 'NON_REPRODUCIBLE — the scenario could not be executed'
      : reproduced ? 'COUNTEREXAMPLE REPRODUCED' : 'NOT REPRODUCED — the invariant held this time'}`)
    if (!reproduced && !out.error) {
      console.log(block('The record is kept either way: a scenario that stops reproducing is either a bug'
        + ' that was fixed, or one that only shows up sometimes — and the second is worse news than the'
        + ' first, not better.', '  '))
    }
    console.log('')
  }

  return reproduced || out.error ? 1 : 0
}

export { slug }
