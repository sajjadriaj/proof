import { changedFiles, addedFiles } from './git.js'

/**
 * Test and fixture files, which declare routes and read environment variables that belong to
 * a scenario rather than to the application.
 *
 * Scanning proof's own repository produced 60 gaps, 58 of them from test fixtures — every
 * `app.get('/api/x', h)` written to exercise the detector was reported as a route of the
 * product. A gap list that long is one nobody reads, which costs more than the two real
 * entries buried in it are worth.
 */
const TEST_FILE = /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|e2e|cypress|fixtures)\/|\.(?:test|spec|stories|fixture)\.[jt]sx?$/

export const isTestFile = f => TEST_FILE.test(f)

/**
 * The thesis, in the form that costs the most: passing the existing suite is not the same as
 * satisfying the requirement, and here the suite is not the existing one. An agent that
 * relaxes an assertion and edits the code in one diff gets `OK — unit tests` on both files
 * and a DONE verdict. Editing tests is normal and often right; doing it unnoticed is not.
 */
export const TESTS_CHANGED_NOTICE =
  'this diff changes {n} existing test file(s) ({files}). A check that runs the suite is'
  + ' asserting against expectations the same diff edited or removed, so a passing suite here'
  + ' means the current tests agree with the current code — not that the requirement holds.'
  + ' Read those changes before trusting the verdict.'

/** Filled by both `changed` and `check`; a template so the README block stays checkable. */
export const fillTestsNotice = files =>
  TESTS_CHANGED_NOTICE.replace('{n}', String(files.length)).replace('{files}', files.join(', '))

/**
 * Existing test files this diff edits or removes. Added ones are excluded: a test that did
 * not exist before cannot weaken existing coverage, and a note that fires on most good diffs
 * is one people learn to scroll past.
 */
export function testsChanged(base = 'HEAD') {
  const added = addedFiles(base)
  return changedFiles(base).filter(f => isTestFile(f) && !added.has(f))
}
