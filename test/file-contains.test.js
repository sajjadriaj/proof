import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileContains } from '../src/check.js'

const CHUNK = 1 << 20

const withFile = contents => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-contains-'))
  const path = join(dir, 'f.txt')
  writeFileSync(path, contents)
  return path
}

test('finds and misses a substring in a small file', () => {
  const path = withFile('hello world\n')
  assert.equal(fileContains(path, 'hello'), true)
  assert.equal(fileContains(path, 'world'), true)
  assert.equal(fileContains(path, 'goodbye'), false)
})

test('the regression: a file too large to hold as a string is still searched', () => {
  // readFileSync(path, 'utf8') died with V8's "Cannot create a string longer than
  // 0x1fffffe8 characters" — an engine limit shown to someone asking whether their
  // build log contains a line.
  const dir = mkdtempSync(join(tmpdir(), 'proof-contains-big-'))
  const path = join(dir, 'big.log')
  const fd = openSync(path, 'w')
  try {
    const filler = Buffer.alloc(CHUNK, 0x78) // 'x'
    for (let i = 0; i < 8; i++) writeSync(fd, filler)
    writeSync(fd, Buffer.from('the needle\n', 'utf8'))
    for (let i = 0; i < 8; i++) writeSync(fd, filler)
  } finally { closeSync(fd) }

  assert.equal(fileContains(path, 'the needle'), true)
  assert.equal(fileContains(path, 'not in there'), false)
})

test('a match straddling a chunk boundary is found', () => {
  // The case a naive chunked search gets wrong: half the needle in one read, half in the next.
  for (const offset of [-5, -1, 0, 1, 5]) {
    const at = CHUNK + offset
    const contents = Buffer.concat([
      Buffer.alloc(at, 0x2e), // '.'
      Buffer.from('BOUNDARY', 'utf8'),
      Buffer.alloc(1000, 0x2e),
    ])
    const path = withFile(contents)
    assert.equal(fileContains(path, 'BOUNDARY'), true, `missed a match starting at ${at}`)
  }
})

test('a match at the very end is found', () => {
  const path = withFile(Buffer.concat([Buffer.alloc(CHUNK * 2, 0x2e), Buffer.from('TAIL', 'utf8')]))
  assert.equal(fileContains(path, 'TAIL'), true)
})

test('a needle longer than one read is handled', () => {
  const needle = 'N'.repeat(CHUNK + 100)
  const path = withFile(Buffer.concat([Buffer.alloc(500, 0x2e), Buffer.from(needle), Buffer.alloc(500, 0x2e)]))

  assert.equal(fileContains(path, needle), true)
  assert.equal(fileContains(path, `${needle}X`), false)
})

test('multi-byte characters survive a chunk boundary', () => {
  // Bytes are compared, not characters, precisely so a boundary cannot split a code point
  // into a wrong answer.
  const path = withFile(Buffer.concat([
    Buffer.alloc(CHUNK - 2, 0x2e),
    Buffer.from('日本語のテキスト', 'utf8'),
    Buffer.alloc(100, 0x2e),
  ]))

  assert.equal(fileContains(path, '日本語のテキスト'), true)
  assert.equal(fileContains(path, '日本語のテキスタ'), false)
})

test('an empty needle is not this function to reject', () => {
  // Validation rejects `contains: ""` before a run starts; here it is simply vacuous.
  assert.equal(fileContains(withFile('anything'), ''), true)
})

test('an empty file contains nothing', () => {
  assert.equal(fileContains(withFile(''), 'x'), false)
})

test('memory stays bounded regardless of file size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-contains-mem-'))
  const path = join(dir, 'big.log')
  const fd = openSync(path, 'w')
  try {
    const filler = Buffer.alloc(CHUNK, 0x78)
    for (let i = 0; i < 64; i++) writeSync(fd, filler) // 64 MB
  } finally { closeSync(fd) }

  global.gc?.()
  const before = process.memoryUsage().heapUsed
  assert.equal(fileContains(path, 'absent'), false)
  const grew = process.memoryUsage().heapUsed - before

  // A whole-file read would show tens of megabytes here; the buffer is about one.
  assert.ok(grew < 16 * 1024 * 1024, `heap grew by ${Math.round(grew / 1024 / 1024)} MB`)
})

