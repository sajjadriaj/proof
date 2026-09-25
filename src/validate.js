import { STEP_VERBS, slug } from './browser.js'
import { TYPE_TOKENS } from './json-match.js'
import { NAME_RE, SELECTORS, hasRef, referencedVars, selectorProblem } from './vars.js'
import { invariantProblem } from './invariant.js'

export const VERBS = ['run', 'http', 'file', 'env', 'browser']

// Commands Proof writes into a contract for the user to replace. `proof init` on a project
// with no discoverable test command produced a contract whose only check was one of these —
// which passes, so `proof check` reported DONE for a requirement nothing had verified.
// A contract still holding one is unfinished, and unfinished is a config error, not a pass.
/**
 * Names proof gives its own checks when the contract has a serve block.
 *
 * A contract check sharing one produced two rows with the same name, and `result.checks` is
 * a {name: status} map: the two collapsed into one entry, keeping whichever was written
 * last. A contract check that FAILED read as `passed` there, because the synthetic check
 * of the same name ran after it. Names also key the evidence filenames and `--only`.
 */
export const SERVE_CHECK_NAMES = ['app boots', 'app still running', 'app logs clean']

/**
 * The processes a contract starts, in the order they must start in.
 *
 * A mapping is one process. A list is several, and its order is the dependency order — the
 * database before the API that needs it — because a real application is more than one process
 * and a contract that could only start one had to pretend otherwise. Normalised here so every
 * caller reads a single shape.
 */
export const serveList = spec =>
  spec?.serve === undefined ? [] : Array.isArray(spec.serve) ? spec.serve : [spec.serve]

/** How a serve block is referred to in check names and evidence filenames. */
export const serveLabel = (s, i) => (typeof s?.name === 'string' && s.name.trim()) || String(i + 1)

/**
 * Unsuffixed for a single process, so every existing contract, evidence bundle and regression
 * comparison is untouched. Suffixed once there is more than one, for the reason above: two
 * checks called `app boots` collapse into one entry in `result.checks`, where a failure reads
 * as a pass.
 */
export const serveCheckName = (list, i, phase) => list.length > 1
  ? `${SERVE_CHECK_NAMES[phase]} (${serveLabel(list[i], i)})`
  : SERVE_CHECK_NAMES[phase]

/** Every name proof will add for this contract, so a contract check cannot collide with one. */
export const serveCheckNames = spec => {
  const list = serveList(spec)
  return list.flatMap((_, i) => SERVE_CHECK_NAMES.map((__, phase) => serveCheckName(list, i, phase)))
}

/**
 * The URL relative `path` and `visit` values resolve against.
 *
 * The last serve block that declares one. The list is written in dependency order — what the
 * app needs first, the app itself last — so the last URL is the app under test. Where more
 * than one block declares a URL the run reports which was chosen: picking silently is how a
 * contract ends up verified against a service it was never about.
 */
export const serveBase = list => {
  const urls = list.map(s => s?.ready_url ?? s?.url).filter(u => typeof u === 'string')
  return urls.length ? urls[urls.length - 1] : undefined
}

export const PLACEHOLDER_RUN = new Map([
  ['echo "replace me with a real command"', '`proof init` wrote it because no build or test command was discovered'],
  ['echo "TODO: assert the behaviour this fault broke"', '`proof promote` wrote it from a counterexample the contract accepted'],
  ['echo "TODO: your migrate command"', '`proof infer` wrote it because no migration tool was detected'],
  ['<your dev command>', '`proof init` scaffolded it because it could not tell how this project starts'],
])

/**
 * Matched exactly rather than by pattern. A `<...>` rule over commands would fire on
 * `grep '<div>' index.html` and on shell redirection, and a validation rule that cries wolf
 * is one people learn to ignore — which costs more than the placeholder it would catch.
 */
export const isPlaceholderCommand = value => PLACEHOLDER_RUN.has(String(value).trim())

// Every object we are willing to descend into, and exactly what may appear in it.
// Anything not listed here is rejected — a key we silently ignore is an assertion
// that never runs, and a check that asserts nothing must never report PASS.
export const ALLOWED = {
  '': ['goal', 'requirement', 'criteria', 'policy', 'challenges', 'serve', 'checks'],
  criterion: ['id', 'requirement', 'source', 'attack'],
  'criterion.attack': ['surfaces', 'budget', 'permissions', 'setup', 'actions', 'invariants'],
  'criterion.attack.budget': ['duration', 'candidates', 'concurrency'],
  'criterion.attack.permissions': ['network', 'environment_mutation'],
  action: ['name', 'from', 'http', 'run', 'capture', 'timeout'],
  'criterion.source': ['type', 'reference'],
  policy: ['require_criteria_coverage', 'require_criteria_falsification', 'require_falsification',
    'require_sealed_contract', 'require_challenges', 'allow_flakes', 'allow_skipped'],
  challenge: ['name', 'apply', 'breaks'],
  serve: ['name', 'run', 'ready_url', 'ready_log', 'url', 'timeout', 'log_must_not_match', 'reuse_existing'],
  check: ['name', 'satisfies', 'timeout', ...VERBS, 'expect_exit', 'expect_output', 'expect_under_ms', 'retry_for_ms', 'results', 'capture', 'skip', 'parallel'],
  'check.http': ['method', 'path', 'url', 'headers', 'body', 'expect', 'follow_redirects', 'concurrent'],
  'check.http.expect': ['status', 'statuses', 'headers', 'body_contains', 'body_not_contains', 'json'],
  'check.file': ['path', 'exists', 'contains', 'not_contains'],
  'check.env': ['name', 'matches'],
  'check.browser': ['visit', 'flow', 'base_url', 'expect_no_console_errors'],
  step: STEP_VERBS,
  'step.expect_request': ['method', 'path', 'path_matches', 'url', 'timeout_ms', 'status'],
}

// Opaque by design: user-defined names live here, so we must not police their keys.
// `capture` is validated by hand — the keys are yours, the values are proof's grammar.
const OPAQUE = new Set(['check.http.headers', 'check.http.expect.headers', 'check.http.expect.statuses',
  'check.http.body', 'check.http.expect.json', 'step.fill', 'check.capture'])

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array(b.length + 1).fill(i === 0 ? 0 : i))
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

/**
 * Checks still holding a command Proof wrote for the user to replace.
 *
 * Deliberately not part of validateSpec: as a validation error it also blocked
 * `proof infer --write`, the one command that appends the real checks — `init` wrote the
 * placeholder, `infer` refused to touch the contract because of it, and the only way out
 * was hand-editing. The placeholder cannot produce a false pass in `infer`; it can only do
 * that in a verdict, so `check` is where it is fatal.
 */
export const placeholderChecks = spec =>
  (Array.isArray(spec?.checks) ? spec.checks : [])
    .map((c, i) => ({ i, name: c?.name, run: typeof c?.run === 'string' ? c.run.trim() : null }))
    .filter(c => PLACEHOLDER_RUN.has(c.run))
    .map(c => ({
      ...c,
      why: PLACEHOLDER_RUN.get(c.run),
      message: `check[${c.i}]${c.name ? ` "${c.name}"` : ''} › run: this is still Proof's own placeholder`
        + ` — ${PLACEHOLDER_RUN.get(c.run)}. Replace it with the command that proves the requirement,`
        + ' or delete the check. It would otherwise pass without verifying anything.',
    }))

export function suggest(key, allowed) {
  const k = key.toLowerCase()
  // `expect_status` for `expect: {status:}` — a nested key flattened onto its parent.
  // Edit distance scores that as far apart, but it is the most common way an
  // assertion gets silently disabled, so match on prefix first.
  const flattened = allowed.find(a => a.length >= 3 && (k.startsWith(a.toLowerCase()) || a.toLowerCase().startsWith(k)))
  if (flattened) return flattened

  const [best, cost] = allowed.map(a => [a, editDistance(k, a.toLowerCase())]).sort((x, y) => x[1] - y[1])[0] ?? []
  return best && cost <= Math.max(2, Math.floor(key.length / 3)) ? best : null
}

// Catch a bad pattern while loading, not halfway through a run that has already
// spent a minute booting an app.
function badRegex(pattern, where, problems) {
  if (pattern === undefined) return
  if (typeof pattern !== 'string') return problems.push(`${where}: must be a regex string`)
  try { new RegExp(pattern) } catch (e) { problems.push(`${where}: invalid regex — ${e.message}`) }
}

const ABSOLUTE = /^https?:\/\//i

// A relative path with nothing to resolve it against used to fall back to localhost:3000,
// which quietly verifies the contract against whatever unrelated app is already running.
/**
 * Named for the contract in front of the reader, not for the general case.
 *
 * A `ready_log` serve block for an HTTP app has a command and a readiness signal and no base,
 * and the old wording told its author to "add a serve block" — which they had — while never
 * naming `url:`, the one key that would have fixed it.
 */
const needsBaseMessage = (where, hasServe) =>
  `${where}: relative, and nothing in the contract says what to resolve it against — `
  + (hasServe
    ? 'the serve block declares readiness by log, which is not an address. Add `url:` beside'
      + ' `ready_log` to say where the app listens'
    : 'add a serve block with a `ready_url`, a `browser.base_url`, or use an absolute URL')

/**
 * One mistake, one problem — even when it lands on twenty checks.
 *
 * There is a single cause here: the contract has no base URL. Reporting it once per check
 * buried everything else under twenty copies of the same sentence, and a list that long is one
 * nobody reads to the end. The first is named so the reader can see the shape of it.
 */
const fillNeedsBase = (missing, hasServe, problems) => {
  if (!missing.length) return
  if (missing.length === 1) return problems.push(needsBaseMessage(missing[0], hasServe))
  problems.push(`${missing.length} checks use a relative path or visit, and nothing in the contract says`
    + ' what to resolve them against — '
    + (hasServe
      ? 'the serve block declares readiness by log, which is not an address. Add `url:` beside'
        + ' `ready_log` to say where the app listens'
      : 'add a serve block with a `ready_url`, a `browser.base_url`, or use absolute URLs')
    + `\n    first: ${missing[0]}`)
}

// `contains: 0` is a number in YAML, and a number is falsy — the assertion would be
// written but never run. Type-check the values that carry assertions.
// `ABSOLUTE.test` only checks the prefix, so `http://[bad` and `https://exa mple.com` both
// passed. The check then failed at run time with a fetch error — a contract mistake reported
// as a code failure — and `infer` skipped the check when working out what was already
// covered, so it re-suggested a route the contract already had.
/**
 * A path proof generated from a route pattern, with the pattern still in it.
 *
 * `infer` reports "dynamic segment — replace with a real value" and then writes
 * `path: /api/orders/[id]` into the contract anyway. The note is printed once, in a terminal;
 * the contract keeps no trace of it, so the next `proof check` fails on a request for the
 * literal path `/api/orders/[id]` with nothing to say it was a placeholder.
 *
 * Only whole segments count: `?t=12:30` and `host:3000` are ordinary URLs.
 */
const DYNAMIC_SEGMENT = /(?:^|\/)[:[{<][^/]*/

function mustBeRequestable(value, where, problems) {
  if (typeof value !== 'string') return

  // `<port>` and `<your dev command>` are what proof scaffolds when it will not guess.
  // Matched by name, not by shape: Flask's `<id>` / `<int:id>` are route patterns, and
  // telling their author "proof scaffolds these" blames proof for a value it never wrote —
  // the route-pattern message below owns everything else in angle brackets.
  const placeholder = value.match(/<(?:port|[^>]*\s[^>]*)>/)
  if (placeholder) {
    problems.push(
      `${where}: "${value}" still has the placeholder ${placeholder[0]} in it`
      + ' — proof scaffolds these where it will not guess. Replace it with a real value.',
    )
    return true
  }
  let pathname = value.split('?')[0]
  if (ABSOLUTE.test(value)) {
    try { pathname = new URL(value).pathname } catch { return } // mustParse reports this
  }
  const hit = pathname.match(DYNAMIC_SEGMENT)
  if (!hit) return

  problems.push(
    `${where}: "${value}" still has the route pattern in it (${hit[0].replace(/^\//, '')})`
    + ' — replace it with a real value, or the request goes to that path literally.'
    + ' `proof infer` writes these from route definitions and cannot know a real one.',
  )
}

function mustParse(value, where, problems) {
  if (typeof value !== 'string' || !ABSOLUTE.test(value)) return
  // A URL still holding `${id}` is not the URL that will be requested — `:${port}` alone makes
  // it unparseable — and the reference check has already proved the value will be there.
  if (hasRef(value)) return
  try {
    void new URL(value)
  } catch {
    problems.push(`${where}: "${value}" is not a URL that can be requested`)
  }
}

function mustBe(value, type, where, problems) {
  if (value === undefined) return
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  if (actual === type) return
  const hint = type === 'string' ? ' — quote it in YAML' : ''
  problems.push(`${where}: must be a ${type}, got ${actual}${hint}`)
}

// An empty substring is in every string and an empty pattern matches every string, so these
// assertions pass whatever the code does. Written out they read like verification; run, they
// are the same as having written nothing.
function mustAssertSomething(value, where, problems) {
  if (value === '') problems.push(`${where}: is empty, so it matches anything — write what must be there, or drop the key`)
}

// proof can serialise an object body as JSON or as a form. For anything else it would have
// to guess an encoding, and guessing means sending a request the contract did not describe.
function badBody(http, where, problems) {
  const body = http.body
  if (body === undefined || typeof body === 'string') return

  const declared = Object.entries(http.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1]
  if (declared === undefined || /json/i.test(declared)) return

  if (/x-www-form-urlencoded/i.test(declared)) {
    if (!isPlain(body)) return problems.push(`${where}: form bodies must be a mapping of fields`)
    for (const [k, v] of Object.entries(body)) {
      if (v !== null && typeof v === 'object') {
        problems.push(`${where} › ${k}: form fields must be scalars — nested values cannot be form-encoded`)
      }
    }
    return
  }

  problems.push(`${where}: content-type is "${declared}", which proof cannot encode an object into `
    + '— provide the body as a string')
}

// Most tools read `timeout: 0` as "no limit"; proof would read it as "kill immediately",
// which is a race between the command finishing and the timer firing. There is no
// unlimited value, so say so rather than do the opposite of what was meant.
function mustBePositive(value, where, problems) {
  if (typeof value !== 'number' || value > 0) return // wrong types are reported by mustBe
  problems.push(`${where}: must be greater than 0 — proof has no "unlimited" timeout value`)
}

// `<strig>` would silently degrade to a literal string comparison, so reject it here.
function badTypeTokens(node, where, problems, path = '$') {
  if (typeof node === 'string' && /^<.*>$/.test(node) && !TYPE_TOKENS.includes(node)) {
    const hint = suggest(node, TYPE_TOKENS)
    problems.push(`${where}: unknown type token "${node}" at ${path}${hint ? ` — did you mean "${hint}"?` : ''}`)
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => badTypeTokens(v, where, problems, `${path}[${i}]`))
  } else if (isPlain(node)) {
    for (const [k, v] of Object.entries(node)) badTypeTokens(v, where, problems, `${path}.${k}`)
  }
}

/**
 * Where else this key is a real key. Nesting is the likeliest mistake in this language —
 * `expect` written on the check instead of under `http` — and edit distance answers it
 * badly: it suggested `expect_exit`, which is a different assertion, so following the advice
 * produced a contract that was valid and wrong.
 */
const KEY_HOMES = Object.entries(ALLOWED).reduce((index, [path, keys]) => {
  for (const key of keys) (index[key] ??= []).push(path)
  return index
}, {})

/**
 * Schema paths named as the contract writes them. `step` is proof's word for an entry in a
 * browser flow; a reader looking for where to put `click` needs `browser › flow`, not a
 * label that appears nowhere in their file.
 */
const PLACE = {
  '': 'the top level',
  criterion: 'an acceptance criterion',
  'criterion.attack': '`attack` on a criterion',
  'criterion.attack.budget': '`budget` on an attack block',
  'criterion.attack.permissions': '`permissions` on an attack block',
  action: 'an attack action',
  'criterion.source': '`source` on a criterion',
  policy: '`policy`',
  challenge: 'a challenge',
  serve: '`serve`',
  check: 'a check',
  'check.http': '`http`',
  'check.http.expect': '`http › expect`',
  'check.file': '`file`',
  'check.env': '`env`',
  'check.browser': '`browser`',
  step: 'a step in `browser › flow`',
  'step.expect_request': '`expect_request` in a flow step',
}

const elsewhere = (key, schemaPath) => {
  const homes = (KEY_HOMES[key] ?? []).filter(p => p !== schemaPath)
  if (!homes.length) return null
  return homes.map(p => PLACE[p] ?? `\`${p}\``).join(' or ')
}

function walk(obj, schemaPath, where, problems) {
  const allowed = ALLOWED[schemaPath]
  if (!allowed || !isPlain(obj)) return
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      // A key that exists somewhere else is a placement mistake, and saying where beats
      // guessing at a misspelling of a different key.
      const home = elsewhere(key, schemaPath)
      const hint = home
        ? ` — that key belongs under ${home}`
        : (h => (h ? ` — did you mean "${h}"?` : ''))(suggest(key, allowed))

      problems.push(`${where}: unknown key "${key}"${hint}`)
      continue
    }
    const childPath = `${schemaPath ? schemaPath + '.' : ''}${key}`
    if (OPAQUE.has(childPath)) continue
    if (ALLOWED[childPath] && isPlain(obj[key])) walk(obj[key], childPath, `${where} › ${key}`, problems)
  }
}

export function validateSpec(spec) {
  const problems = []
  if (!isPlain(spec)) return ['spec must be a YAML mapping']

  walk(spec, '', 'spec', problems)
  validateCriteria(spec, problems)
  validatePolicy(spec, problems)

  if (spec.serve !== undefined) {
    const asList = Array.isArray(spec.serve)
    if (!asList && !isPlain(spec.serve)) {
      problems.push('spec › serve: must be a mapping, or a list of mappings to start in order')
    } else if (asList && spec.serve.length === 0) {
      problems.push('spec › serve: is an empty list — give it a process to start, or remove it')
    } else {
      const list = serveList(spec)
      const labels = new Map()

      list.forEach((s, i) => {
        const at = asList ? `spec › serve[${i}]` : 'spec › serve'
        if (!isPlain(s)) return problems.push(`${at}: must be a mapping`)

        // The top-level walk recurses into a `serve` mapping but not into a list, so list
        // entries are walked here — and only here, or the mapping form reports every unknown
        // key twice and a reader looks for a second problem that is not there.
        if (asList) walk(s, 'serve', at, problems)

        if (!s.run) problems.push(`${at}: needs a \`run\` command`)

        // With more than one process, the name is how the run says which one booted, which one
        // died, and whose log held the offending line. An ordinal would do that badly.
        mustBe(s.name, 'string', `${at} › name`, problems)
        if (list.length > 1) {
          if (!(typeof s.name === 'string' && s.name.trim())) {
            problems.push(`${at}: needs a \`name\` — with more than one process, names are how the run`
              + ' reports which one booted, which one died, and whose log matched')
          } else {
            // Two processes sharing a name produce two checks called `app boots (api)`, which
            // collapse into one entry in `result.checks` — a failure reads as a pass there.
            const key = slug(s.name)
            if (labels.has(key)) {
              problems.push(`${at} › name: duplicate serve name (also serve[${labels.get(key)}])`
                + ' — names identify these processes in results and evidence filenames')
            } else labels.set(key, i)
          }
        }

        // Either readiness signal will do. A URL is the one an HTTP app can show; a worker, a
        // queue consumer, a daemon or a database has no URL to answer, and requiring one meant
        // nothing without an HTTP surface could have a serve block at all.
        if (!s.ready_url && !s.url && !s.ready_log) {
          problems.push(`${at}: needs a \`ready_url\` to poll, or a \`ready_log\` pattern its output must match`
            + ' — proof will not call an app ready without observing it')
        }

        // A scheme-less ready_url can never be fetched, so proof would poll for the whole
        // timeout and then report the app as never ready — blaming the app for a typo here.
        for (const key of ['ready_url', 'url']) {
          const value = s[key]
          if (value === undefined) continue
          mustBe(value, 'string', `${at} › ${key}`, problems)
          if (typeof value === 'string' && !ABSOLUTE.test(value)) {
            problems.push(`${at} › ${key}: must be absolute (http:// or https://) — "${value}" cannot be fetched`)
          }
          // Placeholder first, and only one problem for one mistake: `<port>` also fails to
          // parse, so reporting both would list the same error twice in different words.
          if (!mustBeRequestable(value, `${at} › ${key}`, problems)) {
            mustParse(value, `${at} › ${key}`, problems)
          }
        }
        // Nothing has run yet, so nothing can have captured anything. A reference here could
        // only ever resolve to the literal text.
        for (const [key, value] of Object.entries(s)) {
          if (!hasRef(value)) continue
          problems.push(`${at} › ${key}: uses \${...}, and a serve block starts before any check runs`
            + ' — there is nothing captured yet for it to resolve to')
        }
        if (isPlaceholderCommand(s.run)) {
          problems.push(
            `${at} › run: this is still the placeholder proof scaffolded — `
            + `${PLACEHOLDER_RUN.get(String(s.run).trim())}. Replace it with the command that`
            + ' starts this project, or delete the serve block.',
          )
        }
        badRegex(s.log_must_not_match, `${at} › log_must_not_match`, problems)
        // An empty pattern matches the first thing the app prints — or the empty log before it
        // has printed anything — so every check would run against an app that is not up yet.
        badRegex(s.ready_log, `${at} › ready_log`, problems)
        mustAssertSomething(s.ready_log, `${at} › ready_log`, problems)
        mustBe(s.reuse_existing, 'boolean', `${at} › reuse_existing`, problems)
        mustBe(s.timeout, 'number', `${at} › timeout`, problems)
        mustBePositive(s.timeout, `${at} › timeout`, problems)
      })
    }
  }

  // Without it the report drops its "Requirement:" section and prints a bare VERDICT DONE —
  // an answer with no question attached, and `--json` carries `goal: null` beside
  // `status: passed`. The goal is what a verdict is a verdict about.
  if (typeof spec.goal !== 'string' || !spec.goal.trim()) {
    problems.push('spec: `goal` must be the requirement these checks are meant to prove — "DONE" means nothing without it')
  }

  if (!Array.isArray(spec.checks) || spec.checks.length === 0) {
    problems.push('spec: `checks` must be a non-empty list')
    return problems
  }

  const baseUrl = serveBase(serveList(spec))
  // Whether there is a serve block at all changes what the advice should be.
  const hasServe = serveList(spec).length > 0
  // Collected rather than pushed: they all have one cause, and it is said once below.
  const needsBase = []

  // Names key the results map, the evidence filenames, and `--only`. Two checks sharing
  // one means the later result silently replaces the earlier — a failed check can be
  // reported as passed — and two browser checks overwrite each other's evidence.
  const byslug = new Map()
  spec.checks.forEach((c, i) => {
    if (!isPlain(c) || typeof c.name !== 'string') return
    const key = slug(c.name)
    if (byslug.has(key)) {
      const first = byslug.get(key)
      problems.push(
        `check[${i}] "${c.name}": duplicate check name (also check[${first.i}] "${first.name}") `
        + '— names identify checks in results, evidence files and --only',
      )
    } else byslug.set(key, { i, name: c.name })

    // The names proof will add for *this* contract, not the three bare ones: with several
    // processes they carry a suffix, and `app boots (api)` collides just as destructively.
    if (serveCheckNames(spec).some(n => slug(n) === key)) {
      problems.push(
        `check[${i}] "${c.name}": proof adds a check of this name itself when the contract has a `
        + 'serve block. Two checks with one name collapse into a single entry in `result.checks`, '
        + 'so a failure can read as a pass — rename it.',
      )
    }
  })

  spec.checks.forEach((c, i) => {
    const where = `check[${i}]${c?.name ? ` "${c.name}"` : ''}`
    if (!isPlain(c)) return problems.push(`${where}: must be a mapping`)

    walk(c, 'check', where, problems)

    const used = VERBS.filter(v => v in c)
    if (used.length === 0) return problems.push(`${where}: no verb — expected one of ${VERBS.join(', ')}`)
    if (used.length > 1) return problems.push(`${where}: ${used.length} verbs (${used.join(', ')}) — a check asserts one thing`)

    const [verb] = used
    mustBe(c.timeout, 'number', `${where} › timeout`, problems)
    mustBePositive(c.timeout, `${where} › timeout`, problems)
    mustBe(c.expect_under_ms, 'number', `${where} › expect_under_ms`, problems)
    mustBePositive(c.expect_under_ms, `${where} › expect_under_ms`, problems)
    mustBe(c.retry_for_ms, 'number', `${where} › retry_for_ms`, problems)
    mustBePositive(c.retry_for_ms, `${where} › retry_for_ms`, problems)
    // One says take as long as you need, the other says be quick. A check cannot mean both,
    // and whichever proof honoured would make the other a written assertion that never ran.
    if (c.retry_for_ms !== undefined && c.expect_under_ms !== undefined) {
      problems.push(`${where}: \`retry_for_ms\` and \`expect_under_ms\` contradict each other — one waits`
        + ' for the app to catch up, the other fails it for being slow. Keep whichever this check means.')
    }
    mustBe(c.parallel, 'boolean', `${where} › parallel`, problems)
    // A skip with no reason is how quarantined checks become permanent: nothing in the file
    // says what would have to be true to switch it back on.
    if (c.skip !== undefined && !(typeof c.skip === 'string' && c.skip.trim())) {
      problems.push(`${where} › skip: must be the reason it is skipped — a skip with no reason is one`
        + ' nobody can ever decide to remove')
    }
    // Parallel checks run together, so nothing can read what one of them captured.
    if (c.parallel === true && isPlain(c.capture)) {
      problems.push(`${where}: \`parallel\` and \`capture\` cannot both hold — a check running`
        + ' alongside others has no defined place in the order for its value to become available')
    }
    validateCapture(c.capture, verb, where, problems)

    if (verb === 'run' && typeof c.run !== 'string') problems.push(`${where} › run: must be a shell command string`)
    if (verb === 'run') {
      mustBe(c.expect_output, 'string', `${where} › expect_output`, problems)
      mustAssertSomething(c.expect_output, `${where} › expect_output`, problems)
      mustBe(c.expect_exit, 'number', `${where} › expect_exit`, problems)
      mustBe(c.results, 'string', `${where} › results`, problems)
      mustAssertSomething(c.results, `${where} › results`, problems)
    } else {
      // Only `run` has an exit code and program output, and only `run` reads these. Written
      // on any other verb they are an assertion the runner never evaluates — the check
      // reports PASS having tested one clause fewer than its author wrote.
      const instead = {
        http: ' Assert on the response under `http › expect`.',
        file: ' Assert on the file with `file › contains`.',
        env: ' Assert on the value with `env › matches`.',
        browser: ' Assert on the page with an `expect_text` or `expect_request` step.',
      }[verb] ?? ''
      for (const key of ['expect_exit', 'expect_output', 'results']) {
        if (c[key] === undefined) continue
        problems.push(`${where} › ${key}: only a \`run:\` check runs a command, so this is never`
          + ` read on a \`${verb}\` check.${instead}`)
      }
    }
    if (verb === 'http' && isPlain(c.http?.expect)) {
      mustBe(c.http.expect.status, 'number', `${where} › http › expect › status`, problems)
      mustBe(c.http.expect.body_contains, 'string', `${where} › http › expect › body_contains`, problems)
      mustAssertSomething(c.http.expect.body_contains, `${where} › http › expect › body_contains`, problems)
      mustBe(c.http.expect.body_not_contains, 'string', `${where} › http › expect › body_not_contains`, problems)
      mustAssertSomething(c.http.expect.body_not_contains, `${where} › http › expect › body_not_contains`, problems)
    }
    // A number or a list where a path or a mapping belongs reaches the runner as neither, and
    // it fails there with `file.path missing` — a contract mistake diagnosed as a code failure.
    if (verb === 'file' && c.file !== undefined && typeof c.file !== 'string' && !isPlain(c.file)) {
      problems.push(`${where} › file: must be a path, or a mapping with a \`path\``)
    }
    if (verb === 'file' && isPlain(c.file)) {
      mustBe(c.file.path, 'string', `${where} › file › path`, problems)
      mustBe(c.file.contains, 'string', `${where} › file › contains`, problems)
      mustAssertSomething(c.file.contains, `${where} › file › contains`, problems)
      mustBe(c.file.not_contains, 'string', `${where} › file › not_contains`, problems)
      mustAssertSomething(c.file.not_contains, `${where} › file › not_contains`, problems)
      mustBe(c.file.exists, 'boolean', `${where} › file › exists`, problems)
      // The runner returns on `exists: false` before it reads anything, so `contains` was
      // dropped without trace — and on an absent file the check PASSED while an assertion
      // the author wrote had never run.
      for (const key of ['contains', 'not_contains']) {
        if (c.file.exists === false && c.file[key] !== undefined) {
          problems.push(
            `${where} › file: \`exists: false\` and \`${key}\` cannot both hold — an absent file has no`
            + ` contents to match, and the \`${key}\` would never be checked. Drop one.`,
          )
        }
      }
    }
    if (verb === 'http' && !isPlain(c.http)) problems.push(`${where} › http: must be a mapping`)
    if (verb === 'http' && isPlain(c.http) && !c.http.path && !c.http.url) {
      problems.push(`${where} › http: needs a \`path\` or \`url\``)
    }
    // The runner takes `url` and ignores `path`, so a check left holding both requests one
    // address while its contract shows two — usually the remains of editing one into the other.
    if (verb === 'http' && isPlain(c.http) && c.http.path && c.http.url) {
      problems.push(
        `${where} › http: \`path\` and \`url\` are alternatives — \`url\` would be requested and`
        + ' `path` ignored. Keep whichever one this check means.',
      )
    }
    if (verb === 'http' && isPlain(c.http)) {
      // `expect: 200` is the shorthand everyone tries. The runner reads `expect.status` off it,
      // finds nothing, and the check silently degrades to "any status below 400" — the whole
      // assertion gone, written out in the contract for a reader to trust.
      if (c.http.expect !== undefined && !isPlain(c.http.expect)) {
        problems.push(`${where} › http › expect: must be a mapping of assertions`
          + ' — `expect: {status: 200}`, not a bare value')
      }
      // Opaque by design (header names are yours), so nothing else type-checks it: a string
      // here spreads into `{0: "a", 1: "p", …}` and sends headers nobody wrote.
      if (c.http.headers !== undefined && !isPlain(c.http.headers)) {
        problems.push(`${where} › http › headers: must be a mapping of header names to values`)
      }
      const want = isPlain(c.http.expect) ? c.http.expect.headers : undefined
      if (want !== undefined && !isPlain(want)) {
        problems.push(`${where} › http › expect › headers: must be a mapping of header name to the text it must contain`)
      } else if (isPlain(want)) {
        for (const [name, value] of Object.entries(want)) {
          const at = `${where} › http › expect › headers › ${name}`
          if (typeof value !== 'string') problems.push(`${at}: must be a string — quote it in YAML`)
          else mustAssertSomething(value, at, problems)
        }
      }
      validateConcurrent(c, where, problems)
      mustBe(c.http.follow_redirects, 'boolean', `${where} › http › follow_redirects`, problems)
      if (c.http.url !== undefined && !ABSOLUTE.test(c.http.url)) {
        problems.push(`${where} › http › url: must be absolute (http:// or https://) — use \`path\` for a relative one`)
      }
      if (!mustBeRequestable(c.http.url, `${where} › http › url`, problems)) {
        mustParse(c.http.url, `${where} › http › url`, problems)
      }
      mustBeRequestable(c.http.path, `${where} › http › path`, problems)
      if (c.http.path !== undefined && c.http.url === undefined && !baseUrl) needsBase.push(`${where} › http › path`)
    }
    if (verb === 'http' && isPlain(c.http?.expect) && c.http.expect.json !== undefined) {
      badTypeTokens(c.http.expect.json, `${where} › http › expect › json`, problems)
    }
    if (verb === 'http' && isPlain(c.http)) badBody(c.http, `${where} › http › body`, problems)
    if (verb === 'file' && !c.file) problems.push(`${where} › file: needs a path`)
    if (verb === 'env') {
      const name = typeof c.env === 'string' ? c.env : c.env?.name
      if (!name) problems.push(`${where} › env: needs a variable name`)
      badRegex(c.env?.matches, `${where} › env › matches`, problems)
      mustAssertSomething(c.env?.matches, `${where} › env › matches`, problems)
    }
    if (verb === 'browser') validateBrowser(c.browser, where, problems, baseUrl, needsBase)
  })

  fillNeedsBase(needsBase, hasServe, problems)
  validateReferences(spec.checks, problems)
  validateSatisfies(spec, problems)
  validateChallenges(spec, problems)

  return problems
}

/** A criterion id has to be spellable in a `satisfies` list and readable in a verdict. */
const CRITERION_ID = /^[A-Za-z][A-Za-z0-9_.-]*$/

/**
 * The criteria a contract declares, and the ids the checks will point at.
 *
 * Validated before anything else reads them because every later answer is keyed by id: a
 * duplicate id makes two requirements share one row of coverage, and an id with a space in it
 * cannot be written in a `satisfies` list without quoting that nobody will guess at.
 */
export function validateCriteria(spec, problems) {
  if (spec.criteria === undefined) return
  if (!Array.isArray(spec.criteria)) {
    return problems.push('spec › criteria: must be a list of acceptance criteria — `- {id: AC1, requirement: "..."}`')
  }
  if (!spec.criteria.length) {
    return problems.push('spec › criteria: is an empty list — give it the criteria this change has to satisfy, or remove it')
  }

  const seen = new Map()
  spec.criteria.forEach((c, i) => {
    const at = `spec › criteria[${i}]`
    if (!isPlain(c)) return problems.push(`${at}: must be a mapping with an \`id\` and a \`requirement\``)
    walk(c, 'criterion', at, problems)

    if (typeof c.id !== 'string' || !c.id.trim()) {
      problems.push(`${at} › id: needs an id checks can point at — \`AC1\`, \`token-expiry\``)
    } else if (!CRITERION_ID.test(c.id)) {
      problems.push(`${at} › id: "${c.id}" — letters, digits, dot, dash and underscore, starting with a letter`)
    } else if (seen.has(c.id)) {
      problems.push(`${at} › id: duplicate criterion id (also criteria[${seen.get(c.id)}]) — an id identifies`
        + ' one requirement in coverage, in the manifest and in `satisfies`')
    } else seen.set(c.id, i)

    if (typeof c.requirement !== 'string' || !c.requirement.trim()) {
      problems.push(`${at} › requirement: needs the requirement in words — it is what the coverage report reads back`)
    }
    if (c.source !== undefined && typeof c.source !== 'string' && !isPlain(c.source)) {
      problems.push(`${at} › source: must be text, or \`{type, reference}\` — where this criterion came from`)
    }
    if (isPlain(c.source) && c.source.reference === undefined) {
      problems.push(`${at} › source: needs a \`reference\` — the issue, ticket or document it came from`)
    }
    validateAttack(c.attack, `${at} › attack`, problems, spec)
  })

}

/** How much evidence `proof done` requires. Every key is a yes or a no; nothing else fits. */
function validatePolicy(spec, problems) {
  if (spec.policy === undefined) return
  if (!isPlain(spec.policy)) {
    return problems.push('spec › policy: must be a mapping of requirement to true or false')
  }
  for (const [key, value] of Object.entries(spec.policy)) {
    mustBe(value, 'boolean', `spec › policy › ${key}`, problems)
  }
}

/** The surfaces the engine can drive. Named here so a refusal can list them. */
export const ATTACK_SURFACES = ['input', 'sequence', 'concurrency']

/** Surfaces the design has a place for and the engine does not drive yet. Refused, not ignored. */
const UNIMPLEMENTED_SURFACES = {
  state: 'manipulating stored state needs a way to describe that state, which this contract language does not have yet',
  identity: 'attacking as another identity needs the contract to say who the identities are',
  environment: 'environment mutation is opt-in by design and not implemented',
}

/**
 * What an attack may manipulate, and what must stay true while it does.
 *
 * Validated as strictly as a check, for the same reason: an attack action proof silently
 * ignores is a scenario nobody ran, reported beside scenarios that did run. The one rule worth
 * stating out loud is that actions carry no `expect` — an attack has no expectations, only
 * observations, and the assertion lives in the invariant where both oracles can read it.
 */
function validateAttack(attack, at, problems, spec = {}) {
  if (attack === undefined) return
  if (!isPlain(attack)) return problems.push(`${at}: must be a mapping — \`{actions, invariants}\` at least`)
  walk(attack, 'criterion.attack', at, problems)

  const actions = attack.actions
  if (!Array.isArray(actions) || !actions.length) {
    problems.push(`${at} › actions: needs the operations an attack may compose — a list of`
      + ' `{name, http}` or `{name, run}`')
  }

  const names = new Map()
  for (const [i, list] of [['setup', attack.setup], ['actions', actions]]) {
    if (list === undefined) continue
    if (!Array.isArray(list)) { problems.push(`${at} › ${i}: must be a list of steps`); continue }

    list.forEach((step, j) => {
      const where = `${at} › ${i}[${j}]${isPlain(step) && step.name ? ` "${step.name}"` : ''}`
      if (!isPlain(step)) return problems.push(`${where}: must be a mapping`)
      walk(step, 'action', where, problems)

      if (typeof step.name !== 'string' || !step.name.trim()) {
        problems.push(`${where} › name: needs a name — invariants count steps by it (\`successful_<name>\`)`)
      } else if (!NAME_RE.test(step.name)) {
        problems.push(`${where} › name: "${step.name}" — letters, digits and underscores, not starting`
          + ' with a digit: an invariant has to be able to name it')
      } else if (names.has(step.name)) {
        problems.push(`${where} › name: duplicate step name (also ${names.get(step.name)}) — a count`
          + ' of `successful_' + step.name + '` would be about two different operations')
      } else names.set(step.name, where)

      // `from` is the same operation the contract already describes, borrowed rather than
      // retyped. The check it names carries the method, the path, the body and the capture; an
      // attack takes all of that and drops the `expect`, because an attack observes.
      const verbs = ['http', 'run'].filter(v => v in step)
      if (step.from !== undefined) {
        if (verbs.length) {
          problems.push(`${where}: \`from\` and \`${verbs[0]}\` are alternatives — \`from\` borrows the`
            + ' operation from a check you already wrote. Keep whichever this step means.')
        }
        if (typeof step.from !== 'string' || !step.from.trim()) {
          problems.push(`${where} › from: must name a check in this contract`)
        } else {
          const source = (Array.isArray(spec.checks) ? spec.checks : []).find(c => c?.name === step.from)
          if (!source) {
            const names = (Array.isArray(spec.checks) ? spec.checks : []).map(c => c?.name).filter(Boolean)
            const hint = suggest(step.from, names)
            problems.push(`${where} › from: no check named "${step.from}"${hint ? ` — did you mean "${hint}"?` : ''}`)
          } else if (!['http', 'run'].some(v => v in source)) {
            problems.push(`${where} › from: "${step.from}" is a \`${VERBS.find(v => v in source) ?? 'verbless'}\` check,`
              + ' and an attack composes requests and commands — those are the two it can observe')
          }
        }
      } else if (verbs.length !== 1) {
        problems.push(`${where}: needs exactly one of \`http\`, \`run\` or \`from\` — an attack composes`
          + ' requests and commands, and those are the two it can observe')
      }
      if (isPlain(step.http)) {
        if (!step.http.path && !step.http.url) problems.push(`${where} › http: needs a \`path\` or \`url\``)
        if (step.http.expect !== undefined) {
          problems.push(`${where} › http › expect: an attack action has no expectations — what must be`
            + ' true goes in `invariants`, where the requirement oracle can read it')
        }
        mustBeRequestable(step.http.path, `${where} › http › path`, problems)
      }
      validateCapture(step.capture, verbs[0] ?? 'http', where, problems)
    })
  }

  const invariants = attack.invariants
  if (!Array.isArray(invariants) || !invariants.length) {
    problems.push(`${at} › invariants: needs what must remain true — \`successful_redeem <= 1\`.`
      + ' Without one there is nothing for an attack to violate, and no requirement oracle at all')
  } else {
    invariants.forEach((invariant, i) => {
      const problem = invariantProblem(invariant, `${at} › invariants[${i}]`, [...names.keys()])
      if (problem) problems.push(problem)
    })
  }

  if (attack.surfaces !== undefined) {
    if (!Array.isArray(attack.surfaces)) problems.push(`${at} › surfaces: must be a list`)
    else {
      for (const surface of attack.surfaces) {
        if (ATTACK_SURFACES.includes(surface)) continue
        const why = UNIMPLEMENTED_SURFACES[surface]
        problems.push(`${at} › surfaces: ${why ? `\`${surface}\` is not something proof can drive yet — ${why}`
          : `unknown surface "${surface}"`}. Available: ${ATTACK_SURFACES.join(', ')}`)
      }
    }
  }

  if (attack.budget !== undefined) {
    if (!isPlain(attack.budget)) problems.push(`${at} › budget: must be a mapping of duration, candidates and concurrency`)
    else {
      for (const key of ['duration', 'candidates', 'concurrency']) {
        mustBe(attack.budget[key], 'number', `${at} › budget › ${key}`, problems)
        mustBePositive(attack.budget[key], `${at} › budget › ${key}`, problems)
      }
    }
  }

  if (isPlain(attack.permissions)) {
    const network = attack.permissions.network
    if (network !== undefined && !['same-origin', 'any'].includes(network)) {
      problems.push(`${at} › permissions › network: \`same-origin\` (the default) or \`any\` — an attack`
        + ' reaches the app this contract starts unless you say otherwise')
    }
    mustBe(attack.permissions.environment_mutation, 'boolean', `${at} › permissions › environment_mutation`, problems)
    if (attack.permissions.environment_mutation === true) {
      problems.push(`${at} › permissions › environment_mutation: proof cannot mutate the environment yet,`
        + ' so granting it would permit something that does not happen')
    }
  }
}

/**
 * `satisfies` on a check: which criterion this check is evidence for.
 *
 * An id nothing declares is the expensive typo: the criterion it was meant to cover stays
 * uncovered, the run reports INCOMPLETE, and the contract looks like it says otherwise.
 */
function validateSatisfies(spec, problems) {
  const declared = new Set(Array.isArray(spec.criteria)
    ? spec.criteria.filter(isPlain).map(c => String(c.id))
    : [])

  spec.checks.forEach((c, i) => {
    if (!isPlain(c) || c.satisfies === undefined) return
    const where = `check[${i}]${c?.name ? ` "${c.name}"` : ''}`

    const ids = typeof c.satisfies === 'string' ? [c.satisfies] : c.satisfies
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
      return problems.push(`${where} › satisfies: must be a criterion id, or a list of them — \`satisfies: [AC1]\``)
    }
    if (!ids.length) {
      return problems.push(`${where} › satisfies: is empty, so this check is evidence for nothing — name the`
        + ' criterion it proves, or drop the key')
    }
    if (!declared.size) {
      return problems.push(`${where} › satisfies: the contract declares no \`criteria\`, so there is nothing`
        + ' for this check to satisfy — add a `criteria:` list, or drop the key')
    }
    for (const id of ids) {
      if (declared.has(id)) continue
      const hint = suggest(id, [...declared])
      problems.push(`${where} › satisfies: no criterion "${id}" is declared${hint ? ` — did you mean "${hint}"?` : ''}`)
    }
  })
}

/**
 * One fault `proof challenge` injects, in the shape the runner needs.
 *
 * Shared with the `--from` generator, which is held to exactly these rules: a challenge from a
 * program is not more trusted than one written in the file.
 */
export function challengeProblems(c, where) {
  const problems = []
  if (!isPlain(c)) return [`${where}: must be a mapping`]
  if (typeof c.name !== 'string' || !c.name.trim()) problems.push(`${where}: needs a \`name\` — the fault, in words`)
  if (typeof c.apply !== 'string' || !c.apply.trim()) {
    problems.push(`${where} › apply: needs the command that introduces the fault, run against a throwaway`
      + ' copy of your code')
  }
  const breaks = typeof c.breaks === 'string' ? [c.breaks] : c.breaks
  if (breaks !== undefined && (!Array.isArray(breaks) || breaks.some(b => typeof b !== 'string'))) {
    problems.push(`${where} › breaks: must be the criterion id(s) this fault violates`)
  }
  return problems
}

function validateChallenges(spec, problems) {
  if (spec.challenges === undefined) return
  if (!Array.isArray(spec.challenges)) {
    return problems.push('spec › challenges: must be a list of faults the contract has to catch'
      + ' — `- {name: "...", apply: "<command>", breaks: [AC1]}`')
  }
  if (!spec.challenges.length) {
    return problems.push('spec › challenges: is an empty list — give it a fault to inject, or remove it')
  }

  const declared = new Set(Array.isArray(spec.criteria)
    ? spec.criteria.filter(isPlain).map(c => String(c.id))
    : [])
  const seen = new Map()

  spec.challenges.forEach((c, i) => {
    const at = `spec › challenges[${i}]${isPlain(c) && c.name ? ` "${c.name}"` : ''}`
    problems.push(...challengeProblems(c, at))
    if (!isPlain(c)) return
    walk(c, 'challenge', at, problems)

    if (typeof c.name === 'string' && c.name.trim()) {
      const key = slug(c.name)
      if (seen.has(key)) {
        problems.push(`${at} › name: duplicate challenge name (also challenges[${seen.get(key)}]) — names`
          + ' identify a fault in the report and its counterexample file')
      } else seen.set(key, i)
    }
    const breaks = typeof c.breaks === 'string' ? [c.breaks] : Array.isArray(c.breaks) ? c.breaks : []
    for (const id of breaks) {
      if (typeof id !== 'string' || declared.has(id)) continue
      const hint = suggest(id, [...declared])
      problems.push(`${at} › breaks: no criterion "${id}" is declared${hint ? ` — did you mean "${hint}"?` : ''}`)
    }
  })
}

/**
 * The upper bound on how many requests one check fires at once.
 *
 * A race needs a handful, not a flood: a contract that opened a thousand connections would be
 * measuring your dev server's accept queue rather than your locking, and doing it from a file
 * someone wrote expecting a test.
 */
export const MAX_CONCURRENT = 50

/**
 * `concurrent` asks one question — when N of these arrive at once, what comes back? — and
 * `expect.statuses` is the only answer shape that question has.
 *
 * The other `expect` keys are refused alongside it rather than quietly applied to one of the
 * responses or to all of them: either reading would be a guess, and a guess here is an
 * assertion the author did not write.
 */
function validateConcurrent(c, where, problems) {
  const http = c.http
  const n = http.concurrent
  const want = isPlain(http.expect) ? http.expect : {}
  const at = `${where} › http › concurrent`

  if (n !== undefined) {
    mustBe(n, 'number', at, problems)
    if (typeof n === 'number' && (!Number.isInteger(n) || n < 2)) {
      problems.push(`${at}: must be a whole number of 2 or more — one request is not a race`)
    } else if (typeof n === 'number' && n > MAX_CONCURRENT) {
      problems.push(`${at}: at most ${MAX_CONCURRENT} — past that a check measures the accept queue rather than the app`)
    }
    // `capture` has no answer here: there is no "the" response to read a value from.
    if (isPlain(c.capture)) {
      problems.push(`${where}: \`concurrent\` and \`capture\` cannot both hold — with several responses`
        + ' at once there is no single one to capture from')
    }
  }

  if (want.statuses !== undefined && n === undefined) {
    problems.push(`${where} › http › expect › statuses: counts how many of several simultaneous requests`
      + ' got each status, so it needs `concurrent: <n>` — for one request use `status`')
  }
  if (n !== undefined && want.statuses === undefined) {
    problems.push(`${where} › http › expect › statuses: needed with \`concurrent\` — say how many of the`
      + ' requests should get each status, like `statuses: {201: 1, 409: 4}`')
  }
  if (n !== undefined) {
    for (const key of ['status', 'body_contains', 'body_not_contains', 'json', 'headers']) {
      if (want[key] === undefined) continue
      problems.push(`${where} › http › expect › ${key}: cannot be asserted alongside \`concurrent\` —`
        + ' there are several responses, and proof will not guess which one you meant. Assert the'
        + ' outcome with `statuses`, and what the winner produced in a check after it.')
    }
  }

  if (!isPlain(want.statuses)) {
    if (want.statuses !== undefined) {
      problems.push(`${where} › http › expect › statuses: must be a mapping of status to how many requests got it`)
    }
    return
  }

  let total = 0
  for (const [code, count] of Object.entries(want.statuses)) {
    const row = `${where} › http › expect › statuses › ${code}`
    if (!/^[1-5]\d\d$/.test(code)) problems.push(`${row}: not an HTTP status code`)
    if (!Number.isInteger(count) || count < 0) {
      problems.push(`${row}: must be how many requests got that status, as a whole number`)
      return
    }
    total += count
  }
  // The tally has to account for every request, or the check is silent about the rest — and
  // the ones it says nothing about are exactly where a broken lock shows up.
  if (typeof n === 'number' && Number.isInteger(n) && total !== n) {
    problems.push(`${where} › http › expect › statuses: accounts for ${total} request(s) but ${n} are sent`
      + ' — every one has to be counted, or the check says nothing about the rest')
  }
}

/** Selectors that need a response rather than a program's output. */
const RESPONSE_ONLY = ['header.', 'status']

function validateCapture(capture, verb, where, problems) {
  if (capture === undefined) return
  if (!isPlain(capture)) {
    return problems.push(`${where} › capture: must be a mapping of name to selector`
      + ` — \`capture: {order_id: json.id}\`. Selectors: ${SELECTORS.join(', ')}`)
  }
  if (verb === 'browser' || verb === 'env') {
    return problems.push(`${where} › capture: a \`${verb}\` check has no response to capture from`
      + ' — capture from an `http` or a `run` check')
  }

  for (const [name, selector] of Object.entries(capture)) {
    const at = `${where} › capture › ${name}`
    // The name becomes `${name}` in a later check, so it has to be spellable as one.
    if (!NAME_RE.test(name)) {
      problems.push(`${at}: not a usable variable name — letters, digits and underscores, not starting with a digit`)
    }
    const problem = selectorProblem(selector)
    if (problem) {
      problems.push(`${at}: ${problem}`)
      continue
    }
    if (verb !== 'http' && RESPONSE_ONLY.some(p => String(selector).startsWith(p))) {
      problems.push(`${at}: \`${selector}\` reads a response, and a \`${verb}\` check has none`
        + ' — use `output` or `match:<regex>`')
    }
  }
}

/**
 * A `${name}` no earlier check produces.
 *
 * Checked here rather than at run time because it is a typo, not a failure: a contract
 * requesting `/orders/${order_ids}` would otherwise boot the app, run everything before it,
 * and report a check failure for a misspelling proof could see in the file.
 */
function validateReferences(checks, problems) {
  const available = new Set()
  checks.forEach((c, i) => {
    if (!isPlain(c)) return
    const where = `check[${i}]${c?.name ? ` "${c.name}"` : ''}`
    // `run` is shell, and `${HOME}` is the shell's syntax, not proof's. Policing it here would
    // reject an ordinary command for using the language it is written in — the same reason
    // `guard` does not parse the agent's flags. A captured name is still substituted there;
    // every other one is left for the shell.
    const { run, ...rest } = c
    for (const name of referencedVars(rest)) {
      if (available.has(name)) continue
      const produced = checks.findIndex(other => isPlain(other?.capture) && name in other.capture)
      problems.push(produced > i
        ? `${where}: uses \${${name}}, which check[${produced}] captures — a value can only be used after`
          + ' the check that produces it. Move this check after that one.'
        : `${where}: uses \${${name}}, which no check captures — add \`capture: {${name}: <selector>}\``
          + ' to the check that produces it.')
    }
    // Available to everything after it, whether or not this check's own body used one.
    if (isPlain(c?.capture)) for (const name of Object.keys(c.capture)) available.add(name)
  })
}

function validateBrowser(b, where, problems, baseUrl, needsBase) {
  if (!isPlain(b)) return problems.push(`${where} › browser: must be a mapping`)
  // No walk() here: the check-level walk already recurses into `check.browser`, and calling
  // it again reported every unknown key twice — a reader counts two problems and looks for
  // a second one that is not there.

  if (b.base_url !== undefined) {
    mustBe(b.base_url, 'string', `${where} › browser › base_url`, problems)
    if (typeof b.base_url === 'string' && !ABSOLUTE.test(b.base_url)) {
      problems.push(`${where} › browser › base_url: must be absolute (http:// or https://)`)
    }
    mustParse(b.base_url, `${where} › browser › base_url`, problems)
  }

  if (!b.base_url && !baseUrl) {
    const visits = [b.visit, ...(Array.isArray(b.flow) ? b.flow.map(s => s?.visit) : [])].filter(v => typeof v === 'string')
    if (visits.some(v => !ABSOLUTE.test(v))) needsBase.push(`${where} › browser › visit`)
  }

  if (b.flow !== undefined && !Array.isArray(b.flow)) {
    return problems.push(`${where} › browser › flow: must be a list of steps`)
  }
  if (!b.visit && !b.flow?.length) problems.push(`${where} › browser: needs a \`visit\` or a \`flow\``)
  mustBe(b.expect_no_console_errors, 'boolean', `${where} › browser › expect_no_console_errors`, problems)

  b.flow?.forEach((s, j) => {
    const stepWhere = `${where} › browser › flow[${j}]`
    if (!isPlain(s)) return problems.push(`${stepWhere}: must be a mapping`)
    walk(s, 'step', stepWhere, problems)
    const stepVerbs = STEP_VERBS.filter(v => v in s)
    if (stepVerbs.length === 0) {
      problems.push(`${stepWhere}: no step verb — expected one of ${STEP_VERBS.join(', ')}`)
    }
    // The runner dispatches on the first verb it finds and ignores the rest, so
    // `{click: "Go", expect_text: "Welcome"}` clicked and never asserted the text. The
    // check level has rejected two verbs since the beginning; steps had not.
    if (stepVerbs.length > 1) {
      problems.push(
        `${stepWhere}: ${stepVerbs.length} step verbs (${stepVerbs.join(', ')}) — a step does one thing,`
        + ` and only \`${stepVerbs[0]}\` would run. Split them into separate steps.`,
      )
    }
    for (const v of ['visit', 'click', 'expect_text', 'expect_url']) mustBe(s[v], 'string', `${stepWhere} › ${v}`, problems)
    // Opaque by design (field names are yours), so this is the only place it can be caught.
    // `fill: "a@b.c"` enumerates the string's characters, and the step goes looking for a
    // field called "0" — a failure that names nothing in the contract.
    if (s.fill !== undefined && !isPlain(s.fill)) {
      problems.push(`${stepWhere} › fill: must be a mapping of field to value, like {email: "a@b.c"}`)
    }
    mustAssertSomething(s.expect_text, `${stepWhere} › expect_text`, problems)
    // expect_url is compared exactly, so a bare fragment has no meaning it could be given
    if (typeof s.expect_url === 'string' && !s.expect_url.startsWith('/') && !ABSOLUTE.test(s.expect_url)) {
      problems.push(`${stepWhere} › expect_url: must be a path ("/dashboard") or an absolute URL — it is matched exactly, not as a substring`)
    }
    mustBe(s.wait, 'number', `${stepWhere} › wait`, problems)
    if ('expect_request' in s && !isPlain(s.expect_request)) {
      problems.push(`${stepWhere} › expect_request: must be a mapping`)
    } else if (isPlain(s.expect_request)) {
      const r = s.expect_request
      if (!r.path && !r.url && !r.path_matches) {
        problems.push(`${stepWhere} › expect_request: needs a \`path\`, \`path_matches\` or \`url\` to match`)
      }
      mustBe(r.path, 'string', `${stepWhere} › expect_request › path`, problems)
      mustBe(r.timeout_ms, 'number', `${stepWhere} › expect_request › timeout_ms`, problems)
      mustBePositive(r.timeout_ms, `${stepWhere} › expect_request › timeout_ms`, problems)
      mustBe(r.status, 'number', `${stepWhere} › expect_request › status`, problems)
      badRegex(r.path_matches, `${stepWhere} › expect_request › path_matches`, problems)
      mustAssertSomething(r.path_matches, `${stepWhere} › expect_request › path_matches`, problems)
    }
  })
}
