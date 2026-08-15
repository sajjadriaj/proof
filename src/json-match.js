// Subset matching: everything the contract names must be present and match. Keys the
// response has and the contract does not mention are ignored — an API is allowed to
// return more than you assert on.
//
// Type tokens cover the common case where the value is generated (ids, timestamps) but
// the shape is what matters. A short token list beats inventing a schema language;
// anything richer belongs in a `run:` check with the project's own tooling.
const TYPES = {
  '<string>': v => typeof v === 'string',
  '<number>': v => typeof v === 'number',
  '<boolean>': v => typeof v === 'boolean',
  '<array>': Array.isArray,
  '<object>': v => v !== null && typeof v === 'object' && !Array.isArray(v),
  '<null>': v => v === null,
  '<any>': v => v !== undefined,
}

export const TYPE_TOKENS = Object.keys(TYPES)

const show = v => (v === undefined ? 'missing' : JSON.stringify(v))
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/** @returns {{path, expected, observed}|null} the first mismatch, or null if `actual` satisfies `expected`. */
export function jsonMismatch(expected, actual, path = '$') {
  if (typeof expected === 'string' && expected in TYPES) {
    return TYPES[expected](actual) ? null : { path, expected, observed: show(actual) }
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return { path, expected: 'an array', observed: show(actual) }
    if (actual.length < expected.length) {
      return { path: `${path}.length`, expected: `at least ${expected.length}`, observed: String(actual.length) }
    }
    for (let i = 0; i < expected.length; i++) {
      const problem = jsonMismatch(expected[i], actual[i], `${path}[${i}]`)
      if (problem) return problem
    }
    return null
  }

  if (isPlain(expected)) {
    if (!isPlain(actual)) return { path, expected: 'an object', observed: show(actual) }
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) return { path: `${path}.${key}`, expected: show(expected[key]), observed: 'missing' }
      const problem = jsonMismatch(expected[key], actual[key], `${path}.${key}`)
      if (problem) return problem
    }
    return null
  }

  return expected === actual ? null : { path, expected: show(expected), observed: show(actual) }
}
