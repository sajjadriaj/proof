import { test } from 'node:test'
import assert from 'node:assert/strict'
import { browserLaunchError, playwrightImportError } from '../src/browser.js'

/**
 * Playwright reports both walls in a drawn box several lines tall. As a crash reason that
 * box was wrapped and then cut off one line ABOVE the command it tells you to run — an
 * instruction that names a command and then does not show it.
 *
 * Verbatim shapes from Playwright, so a reworded box shows up here rather than in the wild.
 */
const NO_BINARIES = `browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell
╔═════════════════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.                    ║
║ Please run the following command to download new browsers:              ║
║                                                                         ║
║     npx playwright install                                              ║
╚═════════════════════════════════════════════════════════════════════════╝`

const NO_SYSTEM_DEPS = `browserType.launch: Host system is missing dependencies to run browsers. Please install them with the following command:

    sudo npx playwright install-deps

Alternatively, use apt:
    sudo apt-get install libnss3`

test('missing browser binaries names the download command, on one line', () => {
  const e = browserLaunchError(new Error(NO_BINARIES))

  assert.match(e.message, /npx playwright install chromium/)
  assert.equal(e.message.split('\n').length, 1, 'a drawn box does not survive being wrapped')
  assert.doesNotMatch(e.message, /╔|║/)
})

test('missing system libraries is a different wall and gets a different command', () => {
  // telling someone to download browsers they already have, when what is missing is libnss3,
  // sends them in a circle
  const e = browserLaunchError(new Error(NO_SYSTEM_DEPS))

  assert.match(e.message, /install-deps/)
  assert.doesNotMatch(e.message, /install chromium/)
})

test('the more specific match wins — the binaries box also says "playwright install"', () => {
  assert.match(browserLaunchError(new Error(NO_BINARIES)).message, /install chromium/)
  assert.match(browserLaunchError(new Error(NO_SYSTEM_DEPS)).message, /install-deps/)
})

test('any other launch failure is passed through untouched', () => {
  // a timeout or a sandbox refusal is not a setup problem, and rewriting it would hide it
  const original = new Error('browserType.launch: Timeout 30000ms exceeded.')
  assert.equal(browserLaunchError(original), original)
})

test('and a missing package is still its own message', () => {
  const e = playwrightImportError(Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }))
  assert.match(e.message, /npm i -D playwright/)
})

test('and the translation is actually wired into the launch', async () => {
  // The tests above exercise the helper. Deleting its call site left every one of them
  // passing while the raw drawn box came back — so run the real thing with no browsers.
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')

  const dir = mkdtempSync(join(tmpdir(), 'proof-nobrowser-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, 'server.mjs'),
    "import http from 'node:http'\n"
    + "http.createServer((q, s) => { s.writeHead(200, {'content-type':'text/html'}); s.end('<h1>hi</h1>') }).listen(8392)\n")
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: g\nserve:\n  run: node server.mjs\n  ready_url: http://127.0.0.1:8392/\n  timeout: 20\n'
    + 'checks:\n  - name: page\n    timeout: 30\n    browser:\n      flow:\n        - visit: /\n        - expect_text: hi\n')

  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/proof.js', import.meta.url)), 'check'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: mkdtempSync(join(tmpdir(), 'proof-emptybrowsers-')) },
  })

  assert.equal(r.status, 1)
  assert.match(r.stdout, /npx playwright install chromium/)
  assert.doesNotMatch(r.stdout, /╔|║/, 'the drawn box must not reach the user')
})

test('a missing playwright package is translated where it is imported', async () => {
  // The message helper was tested; its call site was not. Deleting `playwrightImportError`
  // from the catch left the whole suite green while a raw ERR_MODULE_NOT_FOUND came back.
  const { importPlaywright } = await import('../src/browser.js')

  await assert.rejects(
    () => importPlaywright(() => { throw Object.assign(new Error("Cannot find package 'playwright'"), { code: 'ERR_MODULE_NOT_FOUND' }) }),
    /browser checks need playwright — run `npm i -D playwright/,
  )
})

test('and a playwright that fails to load for another reason keeps its reason', async () => {
  // an ABI mismatch after a Node upgrade is not a missing package, and `npm i` is the
  // wrong advice with the actual cause discarded
  const { importPlaywright } = await import('../src/browser.js')

  await assert.rejects(
    () => importPlaywright(() => { throw new Error('NODE_MODULE_VERSION 108 vs 127') }),
    /installed but could not be loaded: NODE_MODULE_VERSION 108 vs 127/,
  )
})

test('an evidence directory removed mid-run is explained, not shown as a temp file', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')

  const dir = mkdtempSync(join(tmpdir(), 'proof-evgone-'))
  mkdirSync(join(dir, '.proof'))
  writeFileSync(join(dir, '.proof/spec.yaml'),
    'goal: g\nchecks:\n  - name: cleans the tree\n    run: rm -rf .proof/runs\n')

  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/proof.js', import.meta.url)), 'check'], {
    cwd: dir, encoding: 'utf8',
  })

  assert.equal(r.status, 2)
  assert.match(r.stderr, /is no longer there/)
  assert.doesNotMatch(r.stderr, /\.tmp/, 'the temp name is an implementation detail')
  assert.doesNotMatch(r.stderr, /make the directory writable/, 'wrong advice for a deleted directory')
})

test('an unmapped write failure still never names the temp file', async () => {
  // writeError explains five errnos and passes the rest through. EISDIR is one of the rest,
  // so this is the path where the raw message — carrying `.<pid>.tmp` — reaches the user.
  const { writeFileAtomic } = await import('../src/spec.js')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const dir = mkdtempSync(join(tmpdir(), 'proof-atomic-'))
  const target = join(dir, 'result.json')
  mkdirSync(target)                       // a directory sitting where the file should go
  writeFileSync(join(target, 'occupied'), 'x')   // non-empty, so the rename cannot succeed

  try {
    writeFileAtomic(target, 'data')
    assert.fail('the write should not have succeeded')
  } catch (e) {
    assert.doesNotMatch(e.message, /\.tmp/, `temp name leaked: ${e.message}`)
    assert.match(e.message, /result\.json/, 'and the real path is still named')
  }
})
