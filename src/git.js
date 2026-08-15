import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

// ponytail: null on any git failure (no repo, no commits) — callers treat git as optional context.
const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export const inRepo = () => git('rev-parse', '--show-toplevel') !== null
export const head = () => git('rev-parse', 'HEAD')
export const branch = () => git('rev-parse', '--abbrev-ref', 'HEAD')

const lines = s => (s ? s.split('\n').filter(Boolean) : [])

/**
 * Files differing from `base` (default: HEAD incl. staged+unstaged), plus untracked files.
 * Paths are relative to cwd; when cwd is a subdirectory, files outside it are dropped —
 * running proof inside a package means that package is the subject.
 */
export const refExists = ref => git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`) !== null

/** A file's contents at a ref, or null if it is absent there (or this is not a repo). */
export const fileAtRef = (ref, path) => git('show', `${ref}:${path}`)

/**
 * Where this branch left `base`. `--base main` asks what the branch changed, not how it
 * differs from main: measuring against main's tip attributed main's own later commits to
 * the branch. `changed` named files the branch never touched, `dependencyChanges` reported
 * a package main had ADDED as one the branch had removed, and `infer --write` appended
 * checks for both. Callers diff two-dot from this point, so uncommitted work still counts.
 */
/**
 * True when git cannot find where `base` and HEAD diverged — almost always a shallow clone,
 * which is what `actions/checkout` produces by default. `forkPoint` then falls back to the
 * tip of `base`, silently reintroducing the exact misattribution it exists to prevent:
 * commits made on `base` after the fork are reported as this branch's work.
 */
/** Said by both `changed` and `infer` — each derives its whole answer from the fork point. */
export const SHALLOW = base =>
  `git cannot find where this branch left ${base}, which is what a shallow clone leaves behind`
  + ' (`actions/checkout` defaults to fetch-depth: 1). Everything below is measured against the'
  + ` tip of ${base} instead, so commits made on ${base} after this branch started are reported`
  + " as this branch's work. Fetch the full history (`fetch-depth: 0`, or `git fetch"
  + ' --unshallow`) for a blast radius that means anything.'

export const noCommonHistory = (base = 'HEAD') =>
  base !== 'HEAD' && git('merge-base', base, 'HEAD') === null

export const forkPoint = (base = 'HEAD') =>
  (base === 'HEAD' ? base : (git('merge-base', base, 'HEAD') ?? base))

/**
 * Paths this diff ADDS. A new test cannot weaken existing coverage, so warning about one
 * would fire on most good diffs — and a warning that fires on most diffs is one people
 * learn to scroll past.
 */
export function addedFiles(base = 'HEAD') {
  if (!inRepo()) return new Set()
  const from = forkPoint(base)
  const prefix = git('rev-parse', '--show-prefix') ?? ''

  return new Set([
    ...lines(git('diff', '--name-only', '--diff-filter=A', from)),
    ...lines(git('diff', '--name-only', '--cached', '--diff-filter=A', from)),
    // untracked: every one of them is new
    ...lines(git('ls-files', '--others', '--exclude-standard', '--full-name', ':/')),
  ]
    .filter(f => f.startsWith(prefix))
    .map(f => f.slice(prefix.length)))
}

export function changedFiles(base = 'HEAD') {
  // A ref that does not resolve makes every git call fail, which would otherwise look
  // exactly like "nothing changed" — a typo in a branch name should not read as reassurance.
  // HEAD is exempt: a repository with no commits yet is a legitimate state.
  if (base !== 'HEAD' && head() && !refExists(base)) {
    throw Object.assign(new Error(`unknown git ref "${base}" — pass a branch, tag or commit that exists`), { code: 'EBADREF' })
  }

  const from = forkPoint(base)

  const prefix = git('rev-parse', '--show-prefix') ?? ''
  return [...new Set([
    ...lines(git('diff', '--name-only', from)),
    ...lines(git('diff', '--name-only', '--cached', from)),
    // --full-name: ls-files prints cwd-relative paths by default, diff prints repo-relative
    ...lines(git('ls-files', '--others', '--exclude-standard', '--full-name', ':/')),
  ])]
    .filter(f => f.startsWith(prefix))
    .map(f => f.slice(prefix.length))
    .sort()
}

/**
 * HEAD plus the content of all tracked modifications. Enough to notice the code moving
 * while a run is in progress; ignores untracked files so build output is not mistaken
 * for an edit.
 */
export function fingerprint() {
  const sha = head()
  if (!sha) return null
  const diff = git('diff', 'HEAD') ?? ''
  return `${sha}:${createHash('sha1').update(diff).digest('hex')}`
}

export function context() {
  const sha = head()
  // the contract and its evidence are not code under test — same filter `changed` uses
  return sha ? { head: sha, branch: branch(), changed: changedFiles().filter(f => !f.startsWith('.proof/')) } : null
}
