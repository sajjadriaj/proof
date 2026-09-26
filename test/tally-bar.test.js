import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tallyBar } from '../src/check.js'

const plain = x => x
const cells = counts => tallyBar(counts.map(n => ({ n, paint: plain })), 30).length

test('the bar always fills its width, and a lone failure still gets a cell', () => {
  assert.equal(cells([4, 1, 0]), 30)
  assert.equal(cells([499, 1, 0]), 30)
  // the one failure is visible: split by status, the second segment is not empty
  const bar = tallyBar([{ n: 499, paint: plain }, { n: 1, paint: () => 'X' }], 30)
  assert.match(bar, /X$/)
  assert.equal(tallyBar([{ n: 0, paint: plain }]), '')
})
