import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kill } from '../src/check.js'

// The platform branch, tested off the platform it is for. Both directions matter: a negative
// pid throws on Windows, and `taskkill` does not exist anywhere else — picking the wrong one
// leaves the app running and the port held, which is a failure the *next* run reports.
//
// A stub process, never a real one: the assertion is about which mechanism was reached, and
// signalling an arbitrary pid to find out is not a thing a test suite should do.
const stub = () => {
  const calls = { own: 0 }
  return { pid: 424242, kill: () => { calls.own++ }, calls }
}

const withoutProcessKill = fn => {
  const real = process.kill
  const seen = []
  process.kill = (pid, signal) => { seen.push({ pid, signal }) }
  try { fn(seen) } finally { process.kill = real }
}

test('the regression: on Windows the tree is killed with taskkill, not a negative pid', () => {
  withoutProcessKill(seen => {
    const p = stub()
    kill(p, 'win32')

    assert.deepEqual(seen, [], 'process.kill(-pid) was attempted on win32, where it throws')
    assert.equal(p.calls.own, 1, 'the child itself was never signalled')
  })
})

test('on POSIX the whole process group is still signalled', () => {
  withoutProcessKill(seen => {
    const p = stub()
    kill(p, 'linux')

    assert.deepEqual(seen, [{ pid: -424242, signal: 'SIGKILL' }])
    assert.equal(p.calls.own, 0, 'the group kill succeeded, so the fallback must not run')
  })
})

test('a process that has already exited does not take the run down', () => {
  const real = process.kill
  process.kill = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }) }
  try {
    assert.doesNotThrow(() => kill({ pid: 424242, kill: () => { throw new Error('gone too') } }, 'linux'))
    assert.doesNotThrow(() => kill({ pid: 424242, kill: () => { throw new Error('gone too') } }, 'win32'))
  } finally { process.kill = real }
})
