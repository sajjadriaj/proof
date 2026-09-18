// Values one check produces and a later one uses.
//
// Without this a contract could not say the most ordinary thing there is to say about an API:
// POST /orders returns an id, then GET that id. Every path had to be a literal, so contracts
// hardcoded a row someone had seen in their own database once — a check that passes on one
// machine and 404s on every other, which is worse than no check.
//
// ponytail: a dotted path and four selector prefixes, not JSONPath. A query language here
// would be a second thing to learn, and anything it could express that this cannot belongs in
// a `run:` check with the project's own tooling.

/** `${name}` — the whole string, or embedded in one. */
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const WHOLE_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whether a value still holds a reference. Non-global, so `.test` carries no lastIndex. */
export const hasRef = v => typeof v === 'string' && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v)

/** Every variable a check refers to, anywhere in it. */
export function referencedVars(node, out = new Set()) {
  if (typeof node === 'string') {
    for (const m of node.matchAll(REF)) out.add(m[1])
  } else if (Array.isArray(node)) {
    for (const v of node) referencedVars(v, out)
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) referencedVars(v, out)
  }
  return out
}

/**
 * The selector forms a `capture` value may take.
 *
 * `json.` walks a dotted path — `user.id`, `items[0].sku`. `match:` takes the first group of a
 * regex over the raw body. The rest are the three facts about a response that are not in it.
 */
export const SELECTORS = ['json.<path>', 'header.<name>', 'status', 'output', 'match:<regex>']

export const selectorProblem = selector => {
  if (typeof selector !== 'string' || !selector.trim()) return 'must be a selector string'
  if (selector === 'status' || selector === 'output') return null
  if (selector.startsWith('json.')) {
    return selector.length > 'json.'.length ? null : 'needs a path after `json.` — `json.user.id`'
  }
  if (selector.startsWith('header.')) {
    return selector.length > 'header.'.length ? null : 'needs a name after `header.` — `header.location`'
  }
  if (selector.startsWith('match:')) {
    const pattern = selector.slice('match:'.length)
    if (!pattern) return 'needs a regex after `match:` — `match:token=(\\w+)`'
    try {
      // `pattern|` matches the empty string, so the result's length is 1 + the group count —
      // exact, where counting brackets has to reason about escapes and non-capturing groups.
      if (new RegExp(`${pattern}|`).exec('').length < 2) {
        return 'needs a capturing group — `match:token=(\\w+)` captures what the group matched'
      }
    } catch (e) { return `invalid regex — ${e.message}` }
    return null
  }
  return `unknown selector — expected one of ${SELECTORS.join(', ')}`
}

/** `items[0].sku` over a parsed body. Returns undefined for anything the path does not reach. */
const walkPath = (value, path) => {
  for (const key of path.split('.').flatMap(p => p.split(/\[(\d+)\]/).filter(Boolean))) {
    if (value === null || value === undefined) return undefined
    value = value[key]
  }
  return value
}

/**
 * What a check yields for one selector, or a reason it yielded nothing.
 *
 * `source` is what the runner saw: `{ body, status, headers, output }`, whichever of those the
 * verb has. A selector that finds nothing is an error, never an empty string: a variable that
 * silently becomes "" builds a request to `/orders/` and reports whatever that returns.
 */
export function captureValue(selector, source) {
  if (selector === 'status') {
    return source.status === undefined ? { error: 'the check recorded no status' } : { value: source.status }
  }
  if (selector === 'output') {
    const text = source.output ?? source.body
    return text === undefined ? { error: 'the check recorded no output' } : { value: String(text).trim() }
  }
  if (selector.startsWith('header.')) {
    const name = selector.slice('header.'.length).toLowerCase()
    const value = source.headers?.get?.(name) ?? undefined
    return value === undefined || value === null
      ? { error: `the response has no \`${name}\` header` }
      : { value }
  }
  if (selector.startsWith('match:')) {
    const text = source.body ?? source.output ?? ''
    const m = new RegExp(selector.slice('match:'.length)).exec(String(text))
    return m?.[1] === undefined ? { error: 'the pattern matched nothing' } : { value: m[1] }
  }

  // json.
  const text = source.body ?? source.output
  if (text === undefined) return { error: 'the check recorded no body to parse' }
  let parsed
  try { parsed = JSON.parse(text) } catch { return { error: 'the body is not JSON' } }
  const value = walkPath(parsed, selector.slice('json.'.length))
  if (value === undefined) return { error: `${selector.slice('json.'.length)} is not in the response` }
  if (value !== null && typeof value === 'object') {
    return { error: `${selector.slice('json.'.length)} is ${Array.isArray(value) ? 'an array' : 'an object'}, not a value a URL or a header can carry` }
  }
  return { value }
}

/**
 * Every `${name}` replaced, throughout a check.
 *
 * A string that is *only* a reference keeps the captured value's type: `json: {id: "${id}"}`
 * asserting against a numeric id has to compare as a number, or every captured id would have
 * to be asserted as a string it is not. Embedded in a longer string it is stringified, which
 * is what a URL wants.
 */
export function substitute(node, vars) {
  const missing = new Set()

  const walk = value => {
    if (typeof value === 'string') {
      const whole = value.match(WHOLE_REF)
      if (whole) {
        if (!vars.has(whole[1])) { missing.add(whole[1]); return value }
        return vars.get(whole[1])
      }
      return value.replace(REF, (text, name) => {
        if (!vars.has(name)) { missing.add(name); return text }
        return String(vars.get(name))
      })
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [walk(k), walk(v)]))
    }
    return value
  }

  const filled = walk(node)
  return { filled, missing: [...missing] }
}
