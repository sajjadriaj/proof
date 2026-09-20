import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PROOF_DIR } from './spec.js'

/**
 * One run at a time, per project, for a contract that starts a server.
 *
 * NOT for every contract. Concurrent runs are a deliberate feature — each gets its own
 * evidence directory, and test/concurrent-runs.test.js holds the line. A contract of pure
 * `run:` checks owns no port and no build directory, and several at once are harmless. This
 * is only for the ones with a `serve:` block, which own both.
 *
 * Two `proof check` runs in the same working tree do not merely queue badly — they destroy
 * each other. A `serve:` command is usually a dev server, and a dev server owns a build
 * directory and a port. The second run wipes the build the first one is executing out of, and
 * both then report failures that belong to neither: `Cannot find module
 * '[turbopack]_runtime.js'`, a 500 from a route that works, a fixture that cannot connect.
 *
 * `boot()` already refuses when something is answering on the port, and that is not enough.
 * The runs collide in the window between one contract's server stopping and the next one
 * starting, where nothing is listening and the port looks free — so the guard passes, the
 * serve command runs, and the build directory goes with it. A background sweep plus an
 * editor's on-save hook is all it takes, and the failures land on whichever run is unlucky.
 *
 * The lock is advisory and keyed on a live pid: a crashed run leaves a stale file, and the
 * next run takes it over rather than demanding somebody clean up after a crash.
 */
const LOCK = join(PROOF_DIR, 'run.lock')

const alive = pid => {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means it exists and belongs to somebody else — still running.
    return e.code === 'EPERM'
  }
}

export function readLock() {
  try {
    const held = JSON.parse(readFileSync(LOCK, 'utf8'))
    if (typeof held?.pid !== 'number' || !alive(held.pid)) return null
    return held
  } catch {
    return null
  }
}

/**
 * Take the lock, or throw naming who has it.
 *
 * Returns a release function. Callers release in a `finally`, and a run killed outright
 * leaves a stale lock the next run reclaims.
 */
export function acquire({ spec = null, command = 'check' } = {}) {
  const held = readLock()
  if (held) {
    const e = new Error(
      `another proof run is already going in this project (pid ${held.pid}`
      + `${held.command ? `, \`proof ${held.command}\`` : ''}${held.spec ? ` on ${held.spec}` : ''})`
      + ' — two runs share one build directory and one port, so the second would wipe the first'
      + ' out from under itself and both would fail for reasons that belong to neither.'
      + ' Wait for it, or run this one in a separate checkout',
    )
    e.code = 'ELOCKED'
    throw e
  }
  // Advisory, so failing to take it must never be worse than not having it. A read-only
  // `.proof` is a real condition proof already reports well — "cannot write evidence", with
  // the directory named — and letting an EACCES from the lock file surface first would replace
  // that with a rawer error about a file the reader never asked for. Nor should a run that
  // would otherwise work be blocked by a lock it could not write.
  try {
    mkdirSync(PROOF_DIR, { recursive: true })
    writeFileSync(LOCK, JSON.stringify({ pid: process.pid, spec, command, at: new Date().toISOString() }))
  } catch {
    return () => {}
  }
  let released = false
  return () => {
    if (released) return
    released = true
    try { rmSync(LOCK, { force: true }) } catch { /* the lock is advisory; losing it is not fatal */ }
  }
}
