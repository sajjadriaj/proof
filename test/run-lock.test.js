import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquire, readLock } from '../src/runlock.js'

/**
 * Two runs in one working tree destroy each other, and the port guard cannot see it.
 *
 * `boot()` refuses when something answers on the port. The collision happens in the window
 * between one contract's server stopping and the next one starting: nothing is listening, the
 * port looks free, the serve command runs — and a serve command that begins `rm -rf .next`
 * takes the build directory out from under the run that is already executing from it. The
 * symptoms land on whichever run is unlucky: `Cannot find module '[turbopack]_runtime.js'`,
 * a 500 from a route that works, a fixture that cannot connect.
 */
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-lock-'))
  mkdirSync(join(dir, '.proof'), { recursive: true })
  return dir
}

const inDir = (dir, fn) => {
  const cwd = process.cwd()
  process.chdir(dir)
  try { return fn() } finally { process.chdir(cwd) }
}

test('a second run is refused while the first holds the lock', () => {
  inDir(project(), () => {
    const release = acquire({ spec: '.proof/spec.yaml', command: 'check' })
    try {
      assert.throws(() => acquire({ spec: '.proof/spec.yaml', command: 'check' }), e => {
        assert.equal(e.code, 'ELOCKED')
        // Names who holds it and why it matters, because "locked" alone sends the reader
        // looking for a stuck process rather than at the run they started themselves.
        assert.match(e.message, new RegExp(`pid ${process.pid}`))
        assert.match(e.message, /wipe the first/)
        return true
      })
    } finally {
      release()
    }
  })
})

test('the lock is released, so the next run gets it', () => {
  inDir(project(), () => {
    acquire({ command: 'check' })()
    assert.equal(readLock(), null)
    const release = acquire({ command: 'check' })
    assert.equal(readLock()?.pid, process.pid)
    release()
  })
})

test('releasing twice is harmless', () => {
  inDir(project(), () => {
    const release = acquire({ command: 'check' })
    release()
    release()
    assert.equal(readLock(), null)
  })
})

test('a lock from a dead process is taken over, not obeyed', () => {
  inDir(project(), () => {
    // A run killed outright leaves its lock behind. Demanding a human clean up after a crash
    // would make the guard worse than the collision it prevents.
    writeFileSync('.proof/run.lock', JSON.stringify({ pid: 0x7ffffffe, command: 'check' }))
    assert.equal(readLock(), null, 'a pid that is not running does not hold the lock')
    const release = acquire({ command: 'check' })
    assert.equal(JSON.parse(readFileSync('.proof/run.lock', 'utf8')).pid, process.pid)
    release()
  })
})

test('a corrupt lock file does not wedge the project', () => {
  inDir(project(), () => {
    writeFileSync('.proof/run.lock', 'not json{')
    assert.equal(readLock(), null)
    acquire({ command: 'check' })()
  })
})

test('a lock it cannot write does not block the run, or mask a better error', () => {
  inDir(project(), () => {
    // A read-only `.proof` is a real condition proof reports well on its own — "cannot write
    // evidence", naming the directory. An EACCES from the lock file surfacing first would
    // replace that with a rawer error about a file the reader never asked for.
    chmodSync('.proof', 0o500)
    try {
      const release = acquire({ command: 'check' })
      assert.equal(typeof release, 'function', 'the run proceeds without the lock')
      release()
    } finally {
      chmodSync('.proof', 0o700)
    }
  })
})

test('a contract with no serve block is not locked, so concurrent runs still work', async () => {
  // Concurrency is a feature here, not an accident: test/concurrent-runs.test.js runs eight at
  // once and asserts each keeps its own evidence. A contract of pure `run:` checks starts
  // nothing, owns no port and no build directory, and has nothing to collide over. Locking it
  // would trade a real capability for a guard it does not need.
  const dir = mkdtempSync(join(tmpdir(), 'proof-nolock-'))
  mkdirSync(join(dir, '.proof'), { recursive: true })
  writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: quick\n    run: "true"\n')

  const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')
  const runs = await Promise.all(Array.from({ length: 4 }, () => new Promise(resolve => {
    execFile(process.execPath, [CLI, 'check'], { cwd: dir }, (err, stdout) => resolve(stdout))
  })))

  assert.equal(runs.length, 4)
  assert.equal(readdirSync(join(dir, '.proof/runs')).length, 4, 'every run kept its own evidence')
})
