import { STEP_VERBS, slug } from './browser.js'
import { TYPE_TOKENS } from './json-match.js'

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

export const PLACEHOLDER_RUN = new Map([
  ['echo "replace me with a real command"', '`proof init` wrote it because no build or test command was discovered'],
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
  '': ['goal', 'requirement', 'serve', 'checks'],
  serve: ['run', 'ready_url', 'url', 'timeout', 'log_must_not_match', 'reuse_existing'],
  check: ['name', 'timeout', ...VERBS, 'expect_exit', 'expect_output'],
  'check.http': ['method', 'path', 'url', 'headers', 'body', 'expect', 'follow_redirects'],
  'check.http.expect': ['status', 'body_contains', 'body_not_contains', 'json'],
  'check.file': ['path', 'exists', 'contains', 'not_contains'],
  'check.env': ['name', 'matches'],
  'check.browser': ['visit', 'flow', 'base_url', 'expect_no_console_errors'],
  step: STEP_VERBS,
  'step.expect_request': ['method', 'path', 'path_matches', 'url', 'timeout_ms', 'status'],
}

// Opaque by design: user-defined names live here, so we must not police their keys.
const OPAQUE = new Set(['check.http.headers', 'check.http.body', 'check.http.expect.json', 'step.fill'])

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
const needsBase = (where, problems) => problems.push(
  `${where}: relative, but the spec has no \`serve.ready_url\` to resolve it against `
  + '— add a serve block, a browser.base_url, or use an absolute URL',
)

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
const DYNAMIC_SEGMENT = /(?:^|\/)[:[{][^/]*/

function mustBeRequestable(value, where, problems) {
  if (typeof value !== 'string') return

  // `<port>` and friends are what proof scaffolds when it will not guess. Uncommented but
  // not filled in, they reach the runner and fail there instead of here.
  const placeholder = value.match(/<[^>]+>/)
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

  if (spec.serve !== undefined) {
    if (!isPlain(spec.serve)) problems.push('spec › serve: must be a mapping')
    else {
      // The top-level walk already recurses into `serve`; walking it again double-reported.
      if (!spec.serve.run) problems.push('spec › serve: needs a `run` command')
      if (!spec.serve.ready_url && !spec.serve.url) problems.push('spec › serve: needs a `ready_url` to poll')

      // A scheme-less ready_url can never be fetched, so proof would poll for the whole
      // timeout and then report the app as never ready — blaming the app for a typo here.
      for (const key of ['ready_url', 'url']) {
        const value = spec.serve[key]
        if (value === undefined) continue
        mustBe(value, 'string', `spec › serve › ${key}`, problems)
        if (typeof value === 'string' && !ABSOLUTE.test(value)) {
          problems.push(`spec › serve › ${key}: must be absolute (http:// or https://) — "${value}" cannot be fetched`)
        }
        // Placeholder first, and only one problem for one mistake: `<port>` also fails to
        // parse, so reporting both would list the same error twice in different words.
        if (!mustBeRequestable(value, `spec › serve › ${key}`, problems)) {
          mustParse(value, `spec › serve › ${key}`, problems)
        }
      }
      if (isPlaceholderCommand(spec.serve.run)) {
        problems.push(
          'spec › serve › run: this is still the placeholder proof scaffolded — '
          + `${PLACEHOLDER_RUN.get(String(spec.serve.run).trim())}. Replace it with the command that`
          + ' starts this project, or delete the serve block.',
        )
      }
      badRegex(spec.serve.log_must_not_match, 'spec › serve › log_must_not_match', problems)
      mustBe(spec.serve.reuse_existing, 'boolean', 'spec › serve › reuse_existing', problems)
      mustBe(spec.serve.timeout, 'number', 'spec › serve › timeout', problems)
      mustBePositive(spec.serve.timeout, 'spec › serve › timeout', problems)
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

  const baseUrl = spec.serve?.ready_url ?? spec.serve?.url

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

    if (SERVE_CHECK_NAMES.some(n => slug(n) === key)) {
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

    if (verb === 'run' && typeof c.run !== 'string') problems.push(`${where} › run: must be a shell command string`)
    if (verb === 'run') {
      mustBe(c.expect_output, 'string', `${where} › expect_output`, problems)
      mustAssertSomething(c.expect_output, `${where} › expect_output`, problems)
      mustBe(c.expect_exit, 'number', `${where} › expect_exit`, problems)
    }
    if (verb === 'http' && isPlain(c.http?.expect)) {
      mustBe(c.http.expect.status, 'number', `${where} › http › expect › status`, problems)
      mustBe(c.http.expect.body_contains, 'string', `${where} › http › expect › body_contains`, problems)
      mustAssertSomething(c.http.expect.body_contains, `${where} › http › expect › body_contains`, problems)
      mustBe(c.http.expect.body_not_contains, 'string', `${where} › http › expect › body_not_contains`, problems)
      mustAssertSomething(c.http.expect.body_not_contains, `${where} › http › expect › body_not_contains`, problems)
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
      mustBe(c.http.follow_redirects, 'boolean', `${where} › http › follow_redirects`, problems)
      if (c.http.url !== undefined && !ABSOLUTE.test(c.http.url)) {
        problems.push(`${where} › http › url: must be absolute (http:// or https://) — use \`path\` for a relative one`)
      }
      if (!mustBeRequestable(c.http.url, `${where} › http › url`, problems)) {
        mustParse(c.http.url, `${where} › http › url`, problems)
      }
      mustBeRequestable(c.http.path, `${where} › http › path`, problems)
      if (c.http.path !== undefined && c.http.url === undefined && !baseUrl) needsBase(where + ' › http › path', problems)
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
    if (verb === 'browser') validateBrowser(c.browser, where, problems, baseUrl)
  })

  return problems
}

function validateBrowser(b, where, problems, baseUrl) {
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
    if (visits.some(v => !ABSOLUTE.test(v))) needsBase(`${where} › browser › visit`, problems)
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
