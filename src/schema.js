// A JSON Schema for the contract, built from the same table the validator enforces.
//
// Generated rather than written out: a hand-kept schema is a second description of the
// language that drifts from the first, and a stale one is worse than none — it red-underlines
// a key that is valid and completes one that is not. `ALLOWED` is the single source, so a verb
// added there appears here without anyone remembering to.
//
// This is for the editor. It cannot express the rules that matter most — exactly one verb per
// check, `exists: false` with `contains`, an empty `body_contains` — so `proof check` remains
// the thing that decides whether a contract is valid.
import { ALLOWED, ATTACK_SURFACES, VERBS } from './validate.js'
import { STEP_VERBS } from './browser.js'
import { TYPE_TOKENS } from './json-match.js'
import { SELECTORS } from './vars.js'

// Only where the type is not obvious from the key. Everything unlisted is left untyped, which
// is honest: the editor should not reject something the validator would accept.
const TYPES = {
  goal: { type: 'string' },
  requirement: { type: 'string' },
  id: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]*$' },
  apply: { type: 'string', minLength: 1 },
  reference: { type: 'string' },
  duration: { type: 'number', exclusiveMinimum: 0 },
  candidates: { type: 'number', exclusiveMinimum: 0 },
  concurrency: { type: 'number', exclusiveMinimum: 0 },
  environment_mutation: { type: 'boolean' },
  name: { type: 'string' },
  run: { type: 'string' },
  timeout: { type: 'number', exclusiveMinimum: 0 },
  expect_exit: { type: 'integer' },
  expect_output: { type: 'string', minLength: 1 },
  expect_under_ms: { type: 'number', exclusiveMinimum: 0 },
  parallel: { type: 'boolean' },
  skip: { type: 'string', minLength: 1 },
  ready_url: { type: 'string', format: 'uri', pattern: '^https?://' },
  ready_log: { type: 'string', minLength: 1 },
  url: { type: 'string' },
  log_must_not_match: { type: 'string' },
  reuse_existing: { type: 'boolean' },
  method: { type: 'string' },
  path: { type: 'string' },
  headers: { type: 'object' },
  follow_redirects: { type: 'boolean' },
  status: { type: 'integer' },
  body_contains: { type: 'string', minLength: 1 },
  body_not_contains: { type: 'string', minLength: 1 },
  exists: { type: 'boolean' },
  contains: { type: 'string', minLength: 1 },
  not_contains: { type: 'string', minLength: 1 },
  matches: { type: 'string', minLength: 1 },
  base_url: { type: 'string', pattern: '^https?://' },
  expect_no_console_errors: { type: 'boolean' },
  visit: { type: 'string' },
  click: { type: 'string' },
  expect_text: { type: 'string', minLength: 1 },
  expect_url: { type: 'string' },
  wait: { type: 'number' },
  fill: { type: 'object' },
  path_matches: { type: 'string', minLength: 1 },
  timeout_ms: { type: 'number', exclusiveMinimum: 0 },
}

const DESCRIPTIONS = {
  goal: 'The requirement these checks are meant to prove. A verdict means nothing without it.',
  id: 'How checks refer to this criterion in `satisfies`, and how coverage reports it.',
  satisfies: 'The criteria this check is evidence for. A criterion nothing satisfies is uncovered.',
  criteria: 'The statements this change has to satisfy. One with no check pointing at it makes a run INCOMPLETE.',
  challenges: 'Faults `proof challenge` injects into a copy of your code. The contract has to fail on each.',
  apply: 'The command that introduces the fault, run against a throwaway copy of your code.',
  breaks: 'The criteria this fault violates, so a detection can be attributed to a requirement.',
  policy: 'How much evidence `proof done` requires before it will say DONE.',
  source: 'Where this criterion came from — text, or {type, reference}.',
  attack: 'What `proof attack` may manipulate, and what must remain true while it does.',
  actions: 'The operations an attack composes. Named, because invariants count them by name.',
  invariants: 'What must remain true — one comparison each, like `successful_redeem <= 1`.',
  surfaces: 'Which strategies may run: input, sequence, concurrency.',
  duration: 'Seconds one criterion\'s search may take.',
  candidates: 'How many scenarios one criterion\'s search may evaluate.',
  concurrency: 'The widest parallel step a concurrency attack builds.',
  skip: 'Why this check is switched off. A run with one cannot report completion.',
  parallel: 'Run alongside the adjacent checks also marked parallel. They must not depend on each other.',
  capture: `Values later checks use as \${name}. Selectors: ${SELECTORS.join(', ')}`,
  expect_under_ms: "The check's own wall clock, spawn included. One measurement, not a benchmark.",
  ready_log: 'A regex the process output must match. For an app with no URL to poll.',
  json: `Subset match. Type tokens: ${TYPE_TOKENS.join(', ')}`,
}

/** An object node: exactly the keys `ALLOWED` lists, nothing else. */
const node = (scope, extra = {}) => ({
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries((ALLOWED[scope] ?? []).map(key => [
    key,
    {
      ...(extra[key] ?? TYPES[key] ?? {}),
      ...(DESCRIPTIONS[key] ? { description: DESCRIPTIONS[key] } : {}),
    },
  ])),
  ...(extra.$required ? { required: extra.$required } : {}),
})

export function specSchema() {
  const capture = {
    type: 'object',
    description: DESCRIPTIONS.capture,
    additionalProperties: { type: 'string', minLength: 1 },
    propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
  }

  const serve = node('serve', { $required: ['run'] })

  // An attack step is a request or a command with a name and no expectations — the assertion
  // lives in the invariants, where both oracles can read it.
  const step = node('action', { http: node('check.http'), capture })

  const attack = node('criterion.attack', {
    surfaces: { type: 'array', items: { enum: ATTACK_SURFACES }, description: DESCRIPTIONS.surfaces },
    setup: { type: 'array', items: step },
    actions: { type: 'array', minItems: 1, items: step, description: DESCRIPTIONS.actions },
    invariants: {
      type: 'array',
      minItems: 1,
      description: DESCRIPTIONS.invariants,
      items: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] }] },
    },
    budget: node('criterion.attack.budget'),
    permissions: node('criterion.attack.permissions', { network: { enum: ['same-origin', 'any'] } }),
    $required: ['actions', 'invariants'],
  })

  const criterion = node('criterion', {
    source: { anyOf: [{ type: 'string' }, node('criterion.source')] },
    attack,
    $required: ['id', 'requirement'],
  })

  const challenge = node('challenge', {
    breaks: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] },
    $required: ['name', 'apply'],
  })

  // Every key is a yes/no about how much evidence is required, so the table is generated
  // rather than listed twice.
  const policy = {
    type: 'object',
    additionalProperties: false,
    description: DESCRIPTIONS.policy,
    properties: Object.fromEntries((ALLOWED.policy ?? []).map(key => [key, { type: 'boolean' }])),
  }

  const check = node('check', {
    satisfies: {
      description: DESCRIPTIONS.satisfies,
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
    },
    http: node('check.http', {
      expect: node('check.http.expect', { json: { description: DESCRIPTIONS.json } }),
      body: {},
    }),
    file: { anyOf: [{ type: 'string' }, node('check.file')] },
    env: { anyOf: [{ type: 'string' }, node('check.env')] },
    browser: node('check.browser', {
      flow: {
        type: 'array',
        items: node('step', { expect_request: node('step.expect_request') }),
      },
    }),
    capture,
  })

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://raw.githubusercontent.com/sajjadriaj/proof/main/schema/spec.schema.json',
    title: 'proof acceptance contract',
    description: 'The definition of "done" for one requirement. `proof check` is what decides'
      + ' whether a contract is valid — this schema is for editor completion, and cannot express'
      + ' every rule the validator enforces.',
    type: 'object',
    additionalProperties: false,
    required: ['goal', 'checks'],
    properties: {
      ...node('').properties,
      serve: {
        description: 'The process, or processes in dependency order, to start before the checks.',
        anyOf: [serve, { type: 'array', items: serve, minItems: 1 }],
      },
      criteria: { type: 'array', minItems: 1, items: criterion, description: DESCRIPTIONS.criteria },
      policy,
      challenges: { type: 'array', minItems: 1, items: challenge, description: DESCRIPTIONS.challenges },
      checks: { type: 'array', minItems: 1, items: check },
    },
    // Listed for the reader, since the schema cannot enforce "exactly one of these".
    $comment: `verbs: ${VERBS.join(', ')}; browser step verbs: ${STEP_VERBS.join(', ')}`,
  }
}
