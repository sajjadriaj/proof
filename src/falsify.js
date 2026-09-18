// Does this contract actually test this change?
//
// Everything else here asks whether the code satisfies the contract. This asks the question
// underneath it, which nothing was asking: would the contract have noticed if the change had
// never been made? A check that passes on the code from before the diff is not verifying the
// requirement — it is decoration, and it will report DONE for a branch that did nothing.
//
// The tool's own thesis, turned on itself. `proof check` says do not trust the agent; this
// says do not trust the contract either. It is the acceptance-level version of watching a
// test go red before you make it green, and it is mechanical rather than a judgement call:
// check the base commit out somewhere else, run the current contract against it, and see.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSpec, SPEC_PATH } from './spec.js'
import { forkPoint, head, inRepo, resolveCommit, showPrefix, toplevel } from './git.js'
import { serveList } from './validate.js'
import { block, columnWidth, padTo, truncateToWidth } from './terminal.js'

const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const NAME_COLUMN_MAX = 48

// Same bound `guard` uses, for the same reason: the verdict arrives on one pipe.
const VERDICT_BUFFER = 64 * 1024 * 1024

/**
 * Directories a project needs to run and does not commit.
 *
 * A checkout of the base commit has no `node_modules`, so the app would fail to boot and the
 * contract would "fail" — which is the answer this command is looking for, arrived at for a
 * reason that has nothing to do with the change. Linked rather than installed: `npm ci` for
 * the base commit would be correct and would also take minutes, and the run says out loud
 * that the dependencies are the working tree's.
 *
 * ponytail: top level only. A monorepo's per-package `node_modules` falls back to the
 * inconclusive verdict, which is the honest answer rather than a wrong one.
 */
const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor']

const linkDeps = (from, to) => {
  const linked = []
  for (const name of DEP_DIRS) {
    const source = join(from, name)
    try {
      if (!lstatSync(source).isDirectory()) continue
      symlinkSync(source, join(to, name), process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(name)
    } catch { /* absent, or already there in the checkout */ }
  }
  return linked
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * A failure that says nothing about the change.
 *
 * A crashed runner never reached the code. A command that exits 127 was not found, which on a
 * checkout missing a build step is the environment rather than the requirement. Counting
 * either as evidence would let a contract that tests nothing pass this command — the exact
 * false reassurance it exists to remove.
 */
const isSuspicious = r => Boolean(r.crashed) || r.exit_code === 127

export function falsify({ json = false, specPath, base = 'HEAD' } = {}) {
  if (!inRepo()) {
    throw Object.assign(
      new Error('not a git repository — `falsify` runs the contract against the commit your change'
        + ' started from, so it needs one (or `git init` here)'),
      { code: 'ENOREPO' })
  }
  if (!head()) {
    throw Object.assign(
      new Error('this repository has no commits yet, so there is no "before" to run the contract against'
        + ' — commit the code as it was, then falsify'),
      { code: 'ENOBASE' })
  }

  // Read and validated here, before a worktree exists: a broken contract is the ordinary
  // coded error, and finding it after checking out a commit would be a slower way to say it.
  const path = specPath ?? SPEC_PATH
  const spec = loadSpec(path)
  const absoluteSpec = resolve(path)

  const from = forkPoint(base)
  const commit = resolveCommit(from)
  if (!commit) {
    throw Object.assign(new Error(`cannot resolve ${from} to a commit`), { code: 'EBADREF' })
  }

  const root = toplevel()
  const prefix = showPrefix()
  const worktree = mkdtempSync(join(tmpdir(), 'proof-falsify-'))
  let linked = []

  // Registered before the checkout exists: Ctrl-C between here and the finally would otherwise
  // leave a registered worktree behind, and git refuses to reuse a path it still believes in.
  const cleanup = () => {
    try { git('worktree', 'remove', '--force', worktree) } catch { /* never added, or already gone */ }
    try { rmSync(worktree, { recursive: true, force: true }) } catch {}
    try { git('worktree', 'prune') } catch {}
  }
  const onSignal = () => { cleanup(); process.exit(130) }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  let run
  try {
    try {
      git('worktree', 'add', '--detach', '--quiet', worktree, commit)
    } catch (e) {
      throw Object.assign(
        new Error(`could not check out ${commit.slice(0, 12)} to compare against — ${String(e.stderr ?? e.message).trim().split('\n')[0]}`),
        { code: 'EWORKTREE' })
    }
    linked = linkDeps(root, worktree)

    // The current contract against the old code — the whole point. `--spec` is absolute, so
    // the checkout's own copy of the contract (or its absence) is not what runs, while `run:`
    // commands and `file:` paths still resolve inside the checkout.
    const cwd = prefix ? join(worktree, prefix) : worktree
    const r = spawnSync(process.execPath, [CLI, 'check', '--json', '--spec', absoluteSpec], {
      cwd,
      encoding: 'utf8',
      maxBuffer: VERDICT_BUFFER,
    })
    if (r.error) {
      throw Object.assign(new Error(`could not run the contract against ${commit.slice(0, 12)} — ${r.error.message}`), { code: 'EWORKTREE' })
    }
    try {
      run = JSON.parse(r.stdout)
    } catch {
      throw Object.assign(
        new Error(`the contract produced no verdict against ${commit.slice(0, 12)}:\n${(r.stdout + r.stderr).trim()}`),
        { code: 'EBADSPEC' })
    }
    if (run.status === 'error') {
      throw Object.assign(new Error(`the contract could not run against ${commit.slice(0, 12)} — ${run.error}`), { code: 'EBADSPEC' })
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    cleanup()
  }

  const out = classify(run, { spec, base, from, commit, linked })
  if (json) console.log(JSON.stringify(out, null, 2))
  else printHuman(out)

  return { discriminates: 0, inconclusive: 2 }[out.status] ?? 1
}

/**
 * What the base run means.
 *
 * Three answers, not two. A contract that failed because the app never started on the base
 * commit has proved nothing about itself, and reporting that as "it discriminates" would be
 * the same false confidence every other part of this tool refuses to give.
 */
export function classify(run, { spec, base, from, commit, linked = [] }) {
  const results = run.results ?? []
  const contractChecks = results.filter(r => r.kind !== 'serve' && r.status !== 'skipped')
  const serveFailed = results.filter(r => r.kind === 'serve' && r.status === 'failed')

  const failed = contractChecks.filter(r => r.status === 'failed')
  const suspicious = failed.filter(isSuspicious)
  const evidence = failed.filter(r => !isSuspicious(r))

  const checks = contractChecks.map(r => ({
    check: r.name,
    status: r.status,
    // The whole finding, per row: this one needed the change, that one did not.
    about_the_change: r.status === 'failed' && !isSuspicious(r),
    observed: r.observed ?? null,
  }))

  const base_ran = serveFailed.length === 0
  const common = {
    base,
    from,
    commit,
    goal: spec.goal ?? null,
    checks,
    discriminating: evidence.map(r => r.name),
    regression_guards: contractChecks.filter(r => r.status === 'passed').map(r => r.name),
    suspicious: suspicious.map(r => ({ check: r.name, observed: r.observed ?? null })),
    linked_dependencies: linked,
    // Checks reaching a process proof did not start would have been talking to the new code.
    reused_existing: serveList(spec).some(s => s?.reuse_existing === true),
  }

  if (!base_ran) {
    return {
      ...common,
      status: 'inconclusive',
      reason: `the app did not start on ${commit.slice(0, 12)} (${serveFailed.map(r => r.name).join(', ')}),`
        + ' so no check reached it and none of them said anything about your change',
    }
  }
  if (!contractChecks.length) {
    return { ...common, status: 'inconclusive', reason: 'no check ran against the base commit' }
  }
  if (evidence.length) {
    return { ...common, status: 'discriminates', reason: null }
  }
  if (suspicious.length) {
    return {
      ...common,
      status: 'inconclusive',
      reason: `every failure on the base commit is one that says nothing about the change`
        + ` (${suspicious.map(r => r.name).join(', ')}) — a crashed runner never reached the code, and a`
        + ' command that exits 127 was not found there',
    }
  }
  return { ...common, status: 'does-not-discriminate', reason: null }
}

/** A few names and a count of the rest: a list nobody can read is a list nobody reads. */
const SAMPLE = 3
const sample = names => (names.length <= SAMPLE
  ? names.join(', ')
  : `${names.slice(0, SAMPLE).join(', ')}, +${names.length - SAMPLE} more`)

const VERDICT = {
  discriminates: 'DISCRIMINATES',
  'does-not-discriminate': 'DOES NOT DISCRIMINATE',
  inconclusive: 'INCONCLUSIVE',
}

function printHuman(o) {
  console.log('\nFALSIFY')
  if (o.goal) console.log(`\nRequirement:\n${block(o.goal, '  ')}`)
  console.log(`\n${block(`The contract was run against ${o.commit.slice(0, 12)}`
    + `${o.base === 'HEAD' ? ', the last commit' : `, where this branch left ${o.base}`}`
    + ' — the code as it was before your change. Every check that carries the requirement has'
    + ' to fail there, or it is not testing it.', '  ')}`)

  if (o.checks.length) {
    const w = columnWidth(o.checks.map(c => c.check), NAME_COLUMN_MAX)
    console.log('\nCHECKS AGAINST THE BASE')
    for (const c of o.checks) {
      const tag = c.status === 'failed' ? 'FAIL' : 'PASS'
      const meaning = c.about_the_change ? 'needs your change'
        : c.status === 'failed' ? 'failed for a reason that is not your change'
          : 'would pass without your change'
      console.log(`  ${padTo(truncateToWidth(c.check, NAME_COLUMN_MAX), w + 2)}${tag}  ${meaning}`)
    }
  }

  const notes = []
  if (o.linked_dependencies.length) {
    notes.push(`${o.linked_dependencies.join(', ')} were linked from your working tree rather than installed`
      + ' for the base commit, so the base app ran with the dependencies you have now. A change that is'
      + ' itself a dependency change is not measured by this.')
  }
  if (o.reused_existing) {
    notes.push('the contract sets `reuse_existing: true`, so these checks may have reached an app proof'
      + ' did not start — which would be the current code, not the base. Stop it and run this again.')
  }
  if (o.status === 'discriminates' && o.suspicious.length) {
    notes.push(`${o.suspicious.length} other check(s) failed for a reason that says nothing about the change`
      + ` (${o.suspicious.map(s => s.check).join(', ')}) — they were not counted as evidence.`)
  }
  if (notes.length) console.log(`\nNOTE\n${notes.map(n => block(n, '  ')).join('\n\n')}`)

  const verdict = VERDICT[o.status] ?? o.status
  if (o.status === 'discriminates') {
    console.log(`\nVERDICT\n  ${verdict}`
      + `\n  ${o.discriminating.length} of ${o.checks.length} check(s) fail without your change, so the contract is about it`)
    if (o.regression_guards.length) {
      // A mature contract has dozens of these, and naming every one pushed the line that
      // matters off the screen. The count is the finding; the names are a sample of it.
      console.log(block(`${o.regression_guards.length} would pass either way`
        + ` (${sample(o.regression_guards)}) — regression guards, not the requirement`, '  '))
    }
    console.log('')
    return
  }
  if (o.status === 'does-not-discriminate') {
    console.log(`\nVERDICT\n  ${verdict}`)
    console.log(block('Every check passes on the code from before your change, so this contract would'
      + ' report DONE for a branch that did nothing. The checks that carry the requirement have to fail'
      + ' here. Assert what the change actually produces — a body, a field, a row, a page — rather than'
      + ' that the endpoint answers.', '  '))
    console.log('')
    return
  }
  console.log(`\nVERDICT\n  ${verdict}`)
  console.log(block(`${o.reason}. Nothing here says the contract is wrong, only that this run could not`
    + ' tell. Fix what stopped the base commit from running and try again.', '  '))
  console.log('')
}
