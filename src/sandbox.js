// Running the contract against code that is not the working tree.
//
// Two commands need this and neither may touch what you have open: `falsify` runs the contract
// against the commit your change started from, and `challenge` runs it against your code with a
// fault deliberately injected. Both do it in a throwaway git worktree — the fault never reaches
// your files, and a run that dies halfway leaves nothing behind to clean up by hand.
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))

/** The whole verdict arrives on one pipe; the default 1 MB buffer truncates a large contract's. */
export const VERDICT_BUFFER = 64 * 1024 * 1024

/**
 * Directories a project needs to run and does not commit.
 *
 * A fresh checkout has no `node_modules`, so the app would fail to boot and the contract would
 * "fail" — which is the answer these commands look for, arrived at for a reason that has
 * nothing to do with the code. Linked rather than installed: `npm ci` would be correct and
 * would also take minutes, and every caller says out loud that the dependencies are the
 * working tree's.
 *
 * ponytail: top level only. A monorepo's per-package `node_modules` falls back to the
 * inconclusive verdict, which is the honest answer rather than a wrong one.
 */
export const DEP_DIRS = ['node_modules', '.venv', 'venv', 'vendor']

export const linkDeps = (from, to) => {
  const linked = []
  for (const name of DEP_DIRS) {
    const source = join(from, name)
    try {
      if (!lstatSync(source).isDirectory()) continue
      symlinkSync(source, join(to, name), process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(name)
    } catch { /* absent, or already there: neither is worth failing the run over */ }
  }
  return linked
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * A detached worktree at `commit`, with the working tree's dependency directories linked in,
 * handed to `fn` and removed afterwards — including on Ctrl-C, which otherwise leaves a
 * registered worktree git keeps complaining about.
 */
export function withWorktree(commit, root, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'proof-sandbox-'))
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
    try { git('worktree', 'prune') } catch {}
  }
  const onSignal = () => { cleanup(); process.exit(130) }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    try {
      git('worktree', 'add', '--detach', '--quiet', dir, commit)
    } catch (e) {
      throw Object.assign(
        new Error(`could not check out ${String(commit).slice(0, 12)} to run against`
          + ` — ${String(e.stderr ?? e.message).trim().split('\n')[0]}`),
        { code: 'EWORKTREE' })
    }
    const linked = linkDeps(root, dir)
    return fn(dir, linked)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    cleanup()
  }
}

/**
 * `proof check --json` in `cwd`, parsed.
 *
 * The CLI rather than an in-process call: a contract run inside this process would share its
 * cwd, its environment and its signal handlers with the run that started it, and the whole
 * point is that this one is somewhere else.
 */
export function runContract(cwd, absoluteSpec, { label } = {}) {
  const r = spawnSync(process.execPath, [CLI, 'check', '--json', '--spec', absoluteSpec], {
    cwd,
    encoding: 'utf8',
    maxBuffer: VERDICT_BUFFER,
  })
  const where = label ?? cwd
  if (r.error) {
    throw Object.assign(new Error(`could not run the contract against ${where} — ${r.error.message}`), { code: 'EWORKTREE' })
  }
  let run
  try {
    run = JSON.parse(r.stdout)
  } catch {
    throw Object.assign(
      new Error(`the contract produced no verdict against ${where}:\n${(r.stdout + r.stderr).trim()}`),
      { code: 'EBADSPEC' })
  }
  if (run.status === 'error') {
    throw Object.assign(new Error(`the contract could not run against ${where} — ${run.error}`), { code: 'EBADSPEC' })
  }
  return run
}

/**
 * A failure that says nothing about the code.
 *
 * A crashed runner never reached it. A command that exits 127 was not found, which on a
 * checkout missing a build step is the environment rather than the requirement. Counting
 * either as evidence would let a contract that tests nothing look like one that works.
 */
export const isSuspicious = r => Boolean(r.crashed) || r.exit_code === 127
