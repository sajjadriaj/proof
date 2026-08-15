import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateSpec, SERVE_CHECK_NAMES } from '../src/validate.js'

const SERVE = { run: 'sleep 30', ready_url: 'http://localhost:9', reuse_existing: true }

const problems = checks => validateSpec({ goal: 'g', serve: SERVE, checks }).join('\n')

test('the regression: a contract check cannot take a name proof gives its own', () => {
  // `result.checks` is a {name: status} map. Two rows with one name collapsed into one
  // entry keeping whichever ran last — so a contract check that FAILED read as `passed`,
  // because the synthetic check of the same name ran after it.
  for (const name of SERVE_CHECK_NAMES) {
    const out = problems([{ name, run: 'exit 3' }])
    assert.match(out, /proof adds a check of this name itself/, `"${name}" was accepted`)
  }
})

test('the reserved list is the list the runner actually uses', () => {
  // Renaming a synthetic check without updating the rule would silently reopen the hole.
  const source = readFileSync(new URL('../src/check.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /name: 'app (boots|still running|logs clean)'/,
    'check.js should take these names from SERVE_CHECK_NAMES, not repeat them as literals')
  assert.equal(SERVE_CHECK_NAMES.length, 3)
})

test('the comparison is by slug, so a differently-cased collision is caught too', () => {
  // Names key the evidence filenames through slug(), where case does not survive.
  assert.match(problems([{ name: 'App Boots', run: 'true' }]), /proof adds a check of this name/)
})

test('an ordinary name is untouched', () => {
  assert.equal(problems([{ name: 'app responds to /health', run: 'true' }]), '')
  assert.equal(problems([{ name: 'boots', run: 'true' }]), '')
})

test('the existing duplicate-name rule still fires on its own', () => {
  assert.match(problems([{ name: 'same', run: 'true' }, { name: 'same', run: 'true' }]), /duplicate check name/)
})
