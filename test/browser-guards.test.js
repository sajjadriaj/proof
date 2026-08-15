import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { playwrightImportError, runBrowser } from '../src/browser.js'

test('a missing playwright earns the install advice', () => {
  for (const code of ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']) {
    const e = playwrightImportError(Object.assign(new Error("Cannot find package 'playwright'"), { code }))
    assert.match(e.message, /browser checks need playwright/)
    assert.match(e.message, /npx playwright install chromium/)
  }
})

test('the regression: any other import failure keeps its own reason', () => {
  // A corrupt install or a native module built for another Node version also throws here.
  // Telling someone to `npm i` a package they already have sends them the wrong way, and
  // the reason that would have explained it was thrown away.
  const e = playwrightImportError(Object.assign(
    new Error('/x/node_modules/playwright/driver.node: invalid ELF header'),
    { code: 'ERR_DLOPEN_FAILED' },
  ))

  assert.match(e.message, /playwright is installed but could not be loaded/)
  assert.match(e.message, /invalid ELF header/, 'the actual reason survives')
  assert.doesNotMatch(e.message, /npm i -D playwright/, 'and it does not advise installing it again')
})

test('a thrown non-Error is still described', () => {
  assert.match(playwrightImportError('something odd').message, /something odd/)
  assert.match(playwrightImportError(undefined).message, /could not be loaded/)
})

test('a relative visit with no base is refused rather than guessed at', async () => {
  // Validation rejects such a contract, so this guard is the runner's last word before a
  // visit would resolve against whatever happens to be running locally.
  const dir = mkdtempSync(join(tmpdir(), 'proof-guards-'))
  process.chdir(dir)

  const result = await runBrowser(
    { name: 'c', browser: { visit: '/dashboard' } },
    { runDir: dir, baseUrl: undefined },
  )

  assert.equal(result.status, 'failed')
  assert.match(result.expected, /base URL/)
  assert.match(result.observed, /no serve block/)
})

test('an absolute visit needs no base', async () => {
  // The guard must key on the visit being relative, not on the base being absent.
  const dir = mkdtempSync(join(tmpdir(), 'proof-guards-abs-'))
  process.chdir(dir)

  const result = await runBrowser(
    { name: 'c', browser: { visit: 'http://127.0.0.1:47131/nothing' } },
    { runDir: dir, baseUrl: undefined },
  )

  // It gets as far as trying, which is the point — it did not refuse for want of a base.
  assert.equal(result.status, 'failed', 'it tried and could not connect — it did not refuse early')
  assert.doesNotMatch(String(result.observed ?? ''), /no serve block/)
})
