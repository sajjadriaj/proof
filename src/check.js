import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:os'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { loadSpec, PROOF_DIR, SPEC_PATH, writeFileAtomic, writeError, contractChange, CONTRACT_CHANGED_NOTICE } from './spec.js'
import { coverage, criteriaList, fillUncoveredNotice, satisfied, uncovered } from './criteria.js'
import { fillModifiedNotice, integrity } from './seal.js'
import { placeholderChecks, serveList, serveLabel, serveCheckName, serveBase } from './validate.js'
import { evidenceGrowth, RUNS, recentResults, FLAKE_WINDOW, flakiness, fillFlakyNotice } from './runs.js'
import { context as gitContext, fingerprint, head, inRepo, isAncestor } from './git.js'
import { testsChanged, fillTestsNotice } from './diff.js'
import { runBrowser, slug } from './browser.js'
import { jsonMismatch } from './json-match.js'
import { substitute, captureValue } from './vars.js'
import { parseJUnit, describeFailures } from './junit.js'
import { TERMINAL_WIDTH, padTo, truncateToWidth, wrap, block, columnWidth, ellipsize } from './terminal.js'
import { acquire } from './runlock.js'

export { TERMINAL_WIDTH } from './terminal.js'

// One descriptive name is enough to pad every row past the terminal width.
const NAME_COLUMN_MAX = 48

const pass = (observed, output) => ({ status: 'passed', observed, output })
const fail = (expected, observed, output) => ({ status: 'failed', expected, observed, output })

// Kill the whole process group: `sh -c "npm test"` forks, so signalling the shell
// alone orphans every grandchild — a timed-out dev server keeps holding its port.
//
// Windows has neither process groups nor SIGKILL, so `process.kill(-pid)` throws there and
// the fallback reached only the shell. The dev server it spawned survived, kept the port, and
// the *next* run's port check reported a squatter that was proof's own leftover — a failure
// pointing at an unrelated process, on the machine least able to explain it.
//
// The platform is a parameter so the branch is testable off the platform it is for.
export const kill = (p, platform = process.platform) => {
  if (platform === 'win32') {
    // /T is the tree, which is what a negative pid means on POSIX; /F is unconditional, the
    // closest thing to SIGKILL. Best effort on purpose: a process that exited between the
    // decision and the call must not take the run down with it.
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { stdio: 'ignore' }) } catch {}
    try { p.kill() } catch {}
    return
  }
  try { process.kill(-p.pid, 'SIGKILL') } catch { try { p.kill('SIGKILL') } catch {} }
}

// Ctrl-C terminates node without unwinding, so `finally` never runs and every spawned
// process group survives. The orphan then holds the port and the next run blames a
// squatter that is really proof's own leftover.
const running = new Set()
let handlersInstalled = false

const installSignalHandlers = () => {
  if (handlersInstalled) return
  handlersInstalled = true
  const reap = () => { for (const p of running) kill(p); running.clear() }
  for (const [signal, number] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.on(signal, () => { reap(); process.exit(128 + number) })
  }
  process.on('exit', reap) // process.kill is synchronous, so this is safe here
}

const track = p => { installSignalHandlers(); running.add(p); return p }
const untrack = p => running.delete(p)

// Half the buffer from each end, per stream. A command that floods stdout used to be
// accumulated in full: three seconds of `yes` reached 737 MB resident and the run died
// before writing any evidence at all.
const OUTPUT_CAP = 500_000

export function boundedSink(cap = OUTPUT_CAP) {
  let head = ''
  let tail = ''
  let total = 0

  return {
    push(chunk) {
      const s = String(chunk)
      total += s.length
      if (head.length < cap) {
        const room = cap - head.length
        head += s.slice(0, room)
        tail += s.slice(room)
      } else {
        tail += s
      }
      if (tail.length > cap) tail = tail.slice(tail.length - cap)
    },
    get dropped() { return Math.max(0, total - head.length - tail.length) },
    text() {
      const gap = this.dropped
      return gap
        ? `${head}\n… ${gap} character(s) dropped — output exceeded proof's ${cap * 2} character buffer …\n${tail}`
        : head + tail
    },
  }
}

const sh = (cmd, timeoutSec) => new Promise(resolve => {
  const p = track(spawn(cmd, { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }))
  const out = boundedSink()
  const err = boundedSink()
  let timedOut = false
  p.stdout.on('data', d => out.push(d))
  p.stderr.on('data', d => err.push(d))

  const done = (code, extra = '', signal = null) => {
    clearTimeout(timer)
    untrack(p)
    resolve({ code, signal, out: out.text(), err: err.text() + extra, dropped: out.dropped + err.dropped, timedOut })
  }
  const timer = setTimeout(() => { timedOut = true; kill(p) }, timeoutSec * 1000)
  p.on('error', e => done(127, e.message))
  // A signalled process has no exit code. Reporting `exit null` said nothing about the two
  // cases that matter most — the OOM killer and a crash — and read like a bug in proof.
  p.on('close', (code, signal) => done(code, '', signal))
})

const tail = (s, lines = 40) => s.trim().split('\n').slice(-lines).join('\n')

// Compilers put the error first and the stack after. Keeping only the tail threw away the
// one line that explains the failure, so keep both ends and say what was dropped.
export function clip(text, head = 20, foot = 20) {
  const lines = String(text).trim().split('\n')
  if (lines.length <= head + foot + 1) return lines.join('\n')
  const omitted = lines.length - head - foot
  return [...lines.slice(0, head), `… ${omitted} line(s) omitted — full output in commands.log …`, ...lines.slice(-foot)]
    .join('\n')
}

// How long the app is left running after the last check, so late output it triggered
// still lands in the log. Bounded on purpose: this is a grace period, not a wait-for-idle.
const SETTLE_MS = 300

// How much of a response body is stored inline; the rest is kept beside a failure.
const BODY_INLINE_LIMIT = 4000

// How much of one proof will hold at all. `res.text()` buffers whatever the endpoint sends,
// so a contract pointed at an export or a media route took the run down with it — and a run
// that dies writes no evidence, which is the worst way for this tool to fail.
const BODY_LIMIT = 8 * 1024 * 1024

/**
 * The whole body, or null when it is larger than that.
 *
 * Null rather than the part that fitted: every assertion here is about the body, and half of
 * one is the wrong answer in both directions — `body_contains` misses a match past the cut,
 * and `body_not_contains` passes over a string sitting in the half never read.
 */
async function readBody(res) {
  if (!res.body) return res.text()
  const chunks = []
  let bytes = 0
  for await (const chunk of res.body) {
    bytes += chunk.byteLength ?? chunk.length
    if (bytes > BODY_LIMIT) {
      await res.body.cancel().catch(() => {})
      return null
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Named, and with the cause where there is a usual one. "exit null" is not a fact anyone
// can act on; "killed by SIGKILL" points somewhere, and for SIGKILL the somewhere is almost
// always the OOM killer or an outer timeout.
const SIGNAL_CAUSE = {
  SIGKILL: ' — usually the OOM killer or an outer timeout, not the command itself',
  SIGSEGV: ' — the process crashed',
  SIGABRT: ' — the process aborted',
  SIGTERM: ' — something asked it to stop',
}

// A shell reports a child killed by signal N as exit 128+N. `code 139` is legible only if
// you know that; naming SIGSEGV alongside it costs nothing and is what the reader needs.
// Phrased as "reports", not asserted: a script may exit 139 deliberately.
const SIGNAL_NAMES = Object.fromEntries(
  Object.entries(constants.signals).map(([name, number]) => [number, name]),
)

export const describeExit = (code, verb = 'exit') => {
  const signal = code > 128 && code < 128 + 64 ? SIGNAL_NAMES[code - 128] : null
  return signal ? `${verb} ${code} — a shell reports ${signal} this way` : `${verb} ${code}`
}

export const describeSignal = signal => `killed by ${signal}${SIGNAL_CAUSE[signal] ?? ''}`

/**
 * What a runner's own report says, when the check named one.
 *
 * Read before the exit code, because the exit code is the less informative half of the same
 * fact: three failing tests and a `1` say the same thing, and only one of them tells the next
 * iteration what to fix.
 */
function fromReport(c, log) {
  const path = c.results
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch (e) {
    return fail(`${path} reports the suite`,
      e.code === 'ENOENT'
        ? `the command finished but wrote no report at ${path} — check the reporter flag`
          + ' (`--reporter=junit`, `--junitxml=`) and that it writes where the contract looks'
        : `${path} could not be read — ${e.message}`,
      log)
  }

  const report = parseJUnit(source)
  if (!report) {
    return fail(`${path} reports the suite`, `${path} is not a JUnit report — proof reads the`
      + ' JUnit XML every runner can write, not a runner\'s own format', log)
  }
  // A runner given a filter that matches nothing runs nothing and exits 0. That is the whole
  // class of bug this tool exists for, arriving through the check meant to catch the others.
  if (report.tests === 0) {
    return fail(`${path} reports the suite`, 'the report records 0 tests — the command ran nothing,'
      + ' which is not the same as everything passing', log)
  }
  if (report.failed) {
    return fail(`${report.tests} test(s) pass`,
      `${report.failed} of ${report.tests} failed:\n${describeFailures(report)}`, log)
  }
  return { ...pass(`${report.tests} test(s) passed`, log), report }
}

async function runShell(c) {
  const timeout = c.timeout ?? 600
  const r = await sh(c.run, timeout)
  const full = r.out + r.err
  const log = clip(full)
  const wantExit = c.expect_exit ?? 0

  // The report first where there is one: a suite's own account of itself names the tests, and
  // the exit code only says that something went wrong. A clean report with a bad exit code is
  // still a failure — something other than the tests broke — and it is reported as that.
  const reported = c.results !== undefined && !r.timedOut && !r.signal ? fromReport(c, log) : null

  const result = r.timedOut ? fail(`exit ${wantExit}`, `timed out after ${timeout}s`, log)
    : r.signal ? fail(`exit ${wantExit}`, describeSignal(r.signal), log)
      : reported?.status === 'failed' ? reported
      : r.code !== wantExit
        ? fail(`exit ${wantExit}`, `${describeExit(r.code)}${reported ? ', though every test in the report passed' : ''}`, log)
      // `!== undefined`, never truthiness: `expect_output: 0` is a written assertion.
      : c.expect_output !== undefined && !full.includes(c.expect_output)
        ? fail(`output contains "${c.expect_output}"`, 'substring not found', log)
        : reported ?? pass(`exit ${r.code}`, log)

  if (c.results !== undefined) result.evidence = [...(result.evidence ?? []), c.results]

  // The number, beside the sentence about it. `observed` is prose proof is free to reword, and
  // a caller deciding whether a failure is the code or the environment — a missing binary
  // exits 127 — should not have to parse an English clause to find out.
  if (r.code !== null && r.code !== undefined) result.exit_code = r.code

  // `full` never reaches result.json — it goes to commands.log, so the bundle holds
  // everything the command said, not just the part that fitted.
  result.full = full
  result.source = { output: full }
  result.output_clipped = log !== full.trim()
  if (r.dropped) result.output_dropped = r.dropped
  return result
}

// The first line only was not enough: Playwright reports a missing browser binary across
// several lines, and the line naming the command to fix it is not the first. Keep the prose
// and stop at the stack, which belongs in the evidence rather than the verdict.
const CRASH_LINES = 12

export const crashReason = e => {
  const lines = String(e?.message ?? e).split('\n')
  const prose = []
  for (const line of lines) {
    if (/^\s*at\s/.test(line)) break
    if (prose.length >= CRASH_LINES) { prose.push('…'); break }
    prose.push(line)
  }
  return prose.join('\n').trim() || String(e)
}

export const describeFetchError = e => {
  const causes = []
  for (let c = e.cause; c && causes.length < 3; c = c.cause) {
    const text = c.code ? `${c.code}${c.message && c.message !== c.code ? ` (${c.message})` : ''}` : c.message
    if (text && !causes.includes(text)) causes.push(text)
  }
  return causes.length ? `${e.message}: ${causes.join(' <- ')}` : e.message
}

/**
 * The cookie jar for one origin. Stricter than a browser — no subdomain sharing — because
 * the direction that costs something is sending a credential too widely, not too narrowly.
 */
const jarFor = (ctx, url) => {
  if (!ctx?.cookies) return null
  let origin
  try { origin = new URL(url).origin } catch { return null }

  if (!ctx.cookies.has(origin)) ctx.cookies.set(origin, new Map())
  return ctx.cookies.get(origin)
}

export async function runHttp(c, ctx) {
  const h = c.http
  // No guessed host. A default of localhost:3000 would silently verify the contract
  // against whatever unrelated app happens to be running on the developer's machine.
  if (!h.url && !ctx.baseUrl) {
    return fail('a base URL to resolve the path against', 'no serve block and no absolute `url`')
  }
  const url = h.url ?? new URL(h.path ?? '/', ctx.baseUrl).toString()
  const method = (h.method ?? 'GET').toUpperCase()
  const init = { method, headers: { ...(h.headers ?? {}) } }
  if (h.body !== undefined) {
    // Encode to match the declared content-type. Serialising an object as JSON while
    // labelling it as a form sends a request no client would ever produce — and one the
    // contract does not describe.
    const declared = Object.entries(init.headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1]

    if (typeof h.body === 'string') {
      init.body = h.body // verbatim; inventing a content-type for it would be a guess
    } else if (declared && /x-www-form-urlencoded/i.test(declared)) {
      init.body = new URLSearchParams(Object.entries(h.body).map(([k, v]) => [k, String(v)])).toString()
    } else {
      init.body = JSON.stringify(h.body)
      if (!declared) init.headers['content-type'] = 'application/json'
    }
  }
  // Checks run in order against one app, so a session established by one belongs to the
  // next. Without this, logging in and then reading a profile fails with a bare 401 —
  // proof discarding the cookie, reported as the app rejecting the request.
  // Per origin, as a browser would. A single jar sent the session cookie set by your app to
  // every other host the contract touched — a payment sandbox, a webhook endpoint, a status
  // page — handing a credential to somewhere the author never meant it to go.
  const jar = jarFor(ctx, url)
  const setsOwnCookie = Object.keys(init.headers).some(k => k.toLowerCase() === 'cookie')
  if (jar?.size && !setsOwnCookie) {
    init.headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  // fetch follows redirects by default, so `res.status` is whatever answered LAST. Without
  // tracking that, `/admin` 302-ing to a 200 login page passes a check asserting /admin works.
  const follow = h.follow_redirects !== false

  // A race is the one thing a sequence of requests cannot show. Two clients claiming the same
  // order, two payments with one idempotency key, two writers on one row: the bug is that both
  // succeed, and a contract that asks twice in a row never sees it.
  if (h.concurrent !== undefined) return runConcurrent(c, h, url, method, init, follow)

  let res, text
  try {
    res = await fetch(url, {
      ...init,
      redirect: follow ? 'follow' : 'manual',
      signal: AbortSignal.timeout((c.timeout ?? 30) * 1000),
    })
    text = await readBody(res)
  } catch (e) {
    // Node's fetch reports every connection problem as the same "fetch failed" and puts the
    // real reason in `cause`. Refused, DNS failure and TLS error all read identically without
    // it, and that reason is the whole diagnosis.
    return fail(`${method} ${url} responds`, `request failed: ${describeFetchError(e)}`)
  }

  if (text === null) {
    return fail(
      'a response proof can assert on',
      `status ${res.status}, but the body passed ${BODY_LIMIT / 1024 / 1024} MB and proof stopped reading it`
      + ' — asserting on the part that fitted would be an answer about half a response. Stream a payload'
      + ' this size with a `run:` check and assert on what it wrote with a `file:` check.',
    )
  }

  // Names only — cookie values are credentials, and evidence bundles get shared.
  const cookiesSet = []
  for (const header of res.headers.getSetCookie?.() ?? []) {
    const pair = header.split(';')[0]
    const eq = pair.indexOf('=')
    if (eq < 1) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (value === '') jar?.delete(name)
    else jar?.set(name, value)
    cookiesSet.push(name)
  }

  const landedOn = res.redirected && res.url && res.url !== url ? res.url : null
  const via = landedOn ? ` (redirected to ${landedOn})` : ''

  const want = h.expect ?? {}

  // Assertions always run against the whole body; only what is stored inline is bounded,
  // and it says so. A body cut at 4000 characters with no marker looks complete, and can
  // appear to contradict the very failure it accompanies.
  const clipped = text.length > BODY_INLINE_LIMIT
  const body = clipped
    ? `${text.slice(0, BODY_INLINE_LIMIT)}\n… ${text.length - BODY_INLINE_LIMIT} more character(s) …`
    : text

  const decide = () => {
    if (want.status !== undefined && res.status !== want.status) {
      return fail(`status ${want.status}`, `status ${res.status}${via}`, body)
    }
    // Matched as a substring, and the header name case-insensitively. `content-type` carries a
    // charset, `set-cookie` carries flags, `cache-control` carries a list — asserting any of
    // those exactly means rewriting the check the first time an unrelated directive is added.
    for (const [name, mustContain] of Object.entries(want.headers ?? {})) {
      const key = name.toLowerCase()
      // Several Set-Cookie headers are several headers, not one comma-joined value: joining
      // them is how a flag on one cookie reads as a flag on another.
      const actual = key === 'set-cookie'
        ? (res.headers.getSetCookie?.() ?? []).join('\n')
        : res.headers.get(key)
      if (actual === null || actual === undefined) {
        return fail(`header ${name} contains "${mustContain}"`, `no ${name} header${via}`, body)
      }
      if (!actual.includes(mustContain)) {
        return fail(`header ${name} contains "${mustContain}"`, `${name} is "${actual}"${via}`, body)
      }
    }

    if (want.body_contains !== undefined && !text.includes(want.body_contains))
      return fail(`body contains "${want.body_contains}"`, 'substring not found', body)

    // The response-side removal: a stack trace that should no longer leak, a debug banner,
    // an admin link a normal user must not see. Deliberately does NOT count as asserting
    // content below — proving something is absent is no evidence the rest is right.
    if (want.body_not_contains !== undefined && text.includes(want.body_not_contains))
      return fail(`body does not contain "${want.body_not_contains}"`, 'still present', body)

    if (want.json !== undefined) {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return fail('a JSON body', `not JSON (content-type: ${res.headers.get('content-type') ?? 'none'})`, body)
      }
      const problem = jsonMismatch(want.json, parsed)
      if (problem) return fail(`${problem.path} = ${problem.expected}`, `${problem.path} was ${problem.observed}`, body)
    }

    // With no `expect.status`, the check still means "this endpoint works" — a 500
    // answering the phone is not a pass. Reachability alone would prove almost nothing.
    // The message names the missing key, not the whole block: `expect: {body_not_contains}`
    // was told "no expect given" about an expect it wrote.
    if (want.status === undefined && res.status >= 400)
      return fail('a non-error status (no `expect.status` given)', `status ${res.status}${via}`, body)

    return pass(`${res.status} ${method} ${url}${via}`, body)
  }

  const result = decide()
  result.body_clipped = clipped
  if (cookiesSet.length) result.cookies_set = cookiesSet
  // What `capture` reads. Never written to the bundle — the whole body is already there when
  // it matters, and headers carry credentials.
  result.source = { body: text, status: res.status, headers: res.headers }

  // Keep the whole body when the check failed — that is when someone reads it. Writing
  // megabytes beside every passing check would be storage for nobody.
  if (clipped && result.status === 'failed') {
    const file = join(ctx.runDir, `response-${slug(c.name ?? 'http')}.txt`)
    writeFileSync(file, text)
    result.output = `${result.output}\n… full body in ${file} …`
    result.evidence = [...(result.evidence ?? []), file]
  }

  if (landedOn) {
    result.warnings = [
      `${method} ${new URL(url).pathname} did not answer directly — it redirected to ${landedOn}`
      + ' (set `follow_redirects: false` to assert the redirect itself)',
    ]
  }
  return result
}

/** `1×201, 4×409` — the shape of the answer and of the question, so they compare by eye. */
const tally = counts => Object.entries(counts)
  .sort(([a], [b]) => Number(a) - Number(b))
  .map(([code, n]) => `${n}×${code}`)
  .join(', ')

/**
 * The same request, N times, at once.
 *
 * Only the statuses are asserted, and all of them: what a race produces is a distribution, and
 * a check that named one response would be describing whichever happened to be looked at.
 *
 * Nothing is written to the cookie jar from here. Several responses may each carry a
 * `Set-Cookie` and there is no order among them, so keeping one would be picking arbitrarily —
 * and a session established by a coin flip is worse than no session.
 */
async function runConcurrent(c, h, url, method, init, follow) {
  const n = h.concurrent
  const want = h.expect?.statuses ?? {}
  const timeout = (c.timeout ?? 30) * 1000

  const settled = await Promise.all(Array.from({ length: n }, async () => {
    try {
      const res = await fetch(url, { ...init, redirect: follow ? 'follow' : 'manual', signal: AbortSignal.timeout(timeout) })
      // The body is read and dropped: leaving it unread keeps the connection open, and with
      // every request in flight at once that is how a run wedges rather than finishes.
      await res.arrayBuffer().catch(() => {})
      return { status: res.status }
    } catch (e) {
      return { error: describeFetchError(e) }
    }
  }))

  const got = {}
  const failures = []
  for (const r of settled) {
    if (r.error) failures.push(r.error)
    else got[r.status] = (got[r.status] ?? 0) + 1
  }

  const expected = `${n} at once: ${tally(want)}`
  if (failures.length) {
    const distinct = [...new Set(failures)]
    return fail(expected, `${failures.length} of ${n} request(s) never completed: ${distinct.slice(0, 3).join('; ')}`)
  }

  const same = Object.keys({ ...want, ...got })
    .every(code => (got[code] ?? 0) === (want[code] ?? 0))
  return same
    ? pass(`${n} at once: ${tally(got)}`)
    : fail(expected, `${n} at once: ${tally(got)}`)
}

const READ_CHUNK = 1 << 20

/**
 * Substring search over a file without holding it in memory.
 *
 * readFileSync(path, 'utf8') died on a 573 MB build log with V8's raw "Cannot create a string
 * longer than 0x1fffffe8 characters", at 1.1 GB resident — an engine limit shown to someone
 * who asked whether their artifact contains a line.
 *
 * Compares bytes, not characters: utf8 is self-synchronising, so a byte-sequence match is a
 * character-sequence match, and no chunk boundary can split a code point into a false result.
 */
export function fileContains(path, needle) {
  const target = Buffer.from(String(needle), 'utf8')
  if (target.length === 0) return true

  const overlap = target.length - 1
  const size = Math.max(READ_CHUNK, target.length * 2)
  const buf = Buffer.allocUnsafe(size + overlap)
  const fd = openSync(path, 'r')

  try {
    let carried = 0
    for (;;) {
      const read = readSync(fd, buf, carried, size, null)
      if (read === 0) return false

      const filled = carried + read
      if (buf.subarray(0, filled).indexOf(target) !== -1) return true

      // Keep the last `overlap` bytes so a match straddling two reads is still found.
      carried = Math.min(overlap, filled)
      buf.copy(buf, 0, filled - carried, filled)
    }
  } finally { closeSync(fd) }
}

function runFile(c) {
  const want = typeof c.file === 'string' ? { path: c.file } : c.file
  const { path } = want
  if (!path) return fail('file.path', 'missing')
  const there = existsSync(path)
  if (want.exists === false) return there ? fail(`${path} absent`, 'present') : pass(`${path} absent`)
  if (!there) return fail(`${path} exists`, 'not found')

  // The verb is `file`. A directory sitting where a build artifact should be is not a
  // produced artifact, and reading one for `contains` would surface a raw EISDIR.
  if (!statSync(path).isFile()) {
    return fail(`${path} is a file`, `${path} is a directory — use \`run: test -d ${path}\` to assert a directory`)
  }

  if (want.contains !== undefined) {
    if (!fileContains(path, want.contains)) return fail(`${path} contains "${want.contains}"`, 'substring not found')
  }

  // Removals are most of what you check an agent on: the debug log, the hardcoded key, the
  // TODO it promised to delete. The needle only — never the line it matched. `not_contains`
  // is aimed at secrets, and evidence bundles get shared.
  if (want.not_contains !== undefined) {
    if (fileContains(path, want.not_contains)) {
      return fail(`${path} does not contain "${want.not_contains}"`, 'still present')
    }
  }
  return pass(`${path} ok`)
}

// Never echo the value — env checks routinely cover secrets.
//
// This reads proof's OWN environment, which is what `serve` inherits, so it is meaningful
// exactly when proof starts the app. Say so in the message rather than let "env FOO is set"
// be read as a claim about an app running in a container or on another host.
const ENV_SCOPE = "proof's environment"

function runEnv(c) {
  const want = typeof c.env === 'string' ? { name: c.env } : c.env
  if (!want?.name) return fail('env.name', 'missing')
  const value = process.env[want.name]
  if (value === undefined) return fail(`env ${want.name} is set in ${ENV_SCOPE}`, 'unset')
  if (value === '') return fail(`env ${want.name} is set in ${ENV_SCOPE}`, 'empty')
  if (want.matches && !new RegExp(want.matches).test(value))
    return fail(`env ${want.name} matches /${want.matches}/`, 'value does not match')
  return pass(`env ${want.name} is set in ${ENV_SCOPE}`)
}

/**
 * What the check required, in one line. The bundle recorded only what was observed
 * ("f.txt ok", "exit 0"), so a run could not be read back: nothing said which command ran
 * or what it had to produce, and once the contract changed the run's meaning was gone.
 * Evidence has to carry the assertion, not just the verdict.
 */
export function describe(c, kind) {
  const q = v => JSON.stringify(String(v))
  if (kind === 'run') {
    const parts = [`\`${c.run}\``, `exit ${c.expect_exit ?? 0}`]
    if (c.results !== undefined) parts.push(`every test in ${c.results} passes`)
    if (c.expect_output !== undefined) parts.push(`output contains ${q(c.expect_output)}`)
    return parts.join(', ')
  }
  if (kind === 'file') {
    const f = typeof c.file === 'string' ? { path: c.file } : c.file ?? {}
    if (f.exists === false) return `${f.path} is absent`
    const says = [
      ...(f.contains !== undefined ? [`contains ${q(f.contains)}`] : []),
      ...(f.not_contains !== undefined ? [`does not contain ${q(f.not_contains)}`] : []),
    ]
    return says.length ? `${f.path} exists and ${says.join(', ')}` : `${f.path} exists`
  }
  if (kind === 'env') {
    const e = typeof c.env === 'string' ? { name: c.env } : c.env ?? {}
    return e.matches ? `env ${e.name} matches ${q(e.matches)}` : `env ${e.name} is set`
  }
  if (kind === 'http') {
    const h = c.http ?? {}
    const parts = [`${(h.method ?? 'GET').toUpperCase()} ${h.url ?? h.path ?? '/'}`]
    const w = h.expect ?? {}
    // Mirrors runHttp: with no `expect`, the assertion is still "not an error status".
    if (h.concurrent !== undefined) {
      const counts = Object.entries(w.statuses ?? {}).sort(([a], [b]) => Number(a) - Number(b))
      return `${h.concurrent} at once: ${parts[0]}, ${counts.map(([code, n]) => `${n}×${code}`).join(', ')}`
    }
    parts.push(w.status !== undefined ? `status ${w.status}` : 'a non-error status')
    for (const [name, value] of Object.entries(w.headers ?? {})) parts.push(`header ${name} contains ${q(value)}`)
    if (w.body_contains !== undefined) parts.push(`body contains ${q(w.body_contains)}`)
    if (w.body_not_contains !== undefined) parts.push(`body does not contain ${q(w.body_not_contains)}`)
    if (w.json !== undefined) parts.push(`json matches ${JSON.stringify(w.json)}`)
    return parts.join(', ')
  }
  if (kind === 'browser') {
    const b = c.browser ?? {}
    const steps = [b.visit ? `visit ${b.visit}` : null, ...(b.flow ?? []).map(describeStep)].filter(Boolean)
    if (b.expect_no_console_errors) steps.push('no console errors')
    return steps.join('; ')
  }
  return kind
}

const describeStep = s => {
  const q = v => JSON.stringify(String(v))
  const parts = []
  if (s.visit) parts.push(`visit ${s.visit}`)
  if (s.click) parts.push(`click ${q(s.click)}`)
  if (s.fill) parts.push(`fill ${q(typeof s.fill === 'object' ? Object.keys(s.fill).join(', ') : s.fill)}`)
  if (s.expect_text) parts.push(`see ${q(s.expect_text)}`)
  if (s.expect_url) parts.push(`url is ${s.expect_url}`)
  if (s.expect_request) {
    const r = s.expect_request
    parts.push(`request ${(r.method ?? 'GET').toUpperCase()} ${r.path ?? r.url ?? `/${r.path_matches}/`}`
      + (r.status !== undefined ? ` -> ${r.status}` : ''))
  }
  if (s.wait) parts.push(`wait ${s.wait}ms`)
  return parts.join(' ')
}

// Quoted verbatim in the README, and a test asserts they still match — the README carried a
// version of the first one that the code had stopped producing.
/**
 * The contract-provenance note, shared with `changed`. Not an advisory: those form one
 * narrowing chain about what the contract asserts, and this is about where it came from.
 */
function contractWarning(specPath) {
  if (!inRepo()) return []
  let change
  try { change = contractChange('HEAD', specPath ?? SPEC_PATH) } catch { return [] }
  if (!change) return []

  const parts = change.unparseable
    ? ['it could not be parsed at both ends, so what moved is unknown']
    : [
      ...(change.goal ? ['the goal itself was rewritten'] : []),
      ...(change.removed.length ? [`${change.removed.length} check(s) removed (${change.removed.join(', ')})`] : []),
      ...(change.modified.length ? [`${change.modified.length} changed (${change.modified.join(', ')})`] : []),
      ...(change.added.length ? [`${change.added.length} added (${change.added.join(', ')})`] : []),
    ]
  const weakened = change.unparseable || change.goal || change.removed.length || change.modified.length
  return weakened && parts.length ? [CONTRACT_CHANGED_NOTICE.replace('{what}', parts.join('; '))] : []
}

/** Shared with `changed`; git failures here must not take the run down with them. */
function testsWarning() {
  if (!inRepo()) return []
  try {
    const moved = testsChanged('HEAD')
    return moved.length ? [fillTestsNotice(moved)] : []
  } catch { return [] }
}

/**
 * What the previous run says about this check, when it says anything comparable.
 *
 * `changed` rather than a status: a check whose assertion was edited between runs is not the
 * same check, and calling its failure a regression points at code that never moved.
 */
export const comparableStatus = (previous, asserted) => {
  if (!previous) return null
  if (previous.asserted !== null && asserted !== undefined && previous.asserted !== asserted) return 'changed'
  return previous.status
}

/**
 * What a contract would prove if every check passed — decided from the file alone, so `lint`
 * can say it before a run and `check` can say it after one. `appStarted` is the only fact
 * that needs a run: whether a serve block was actually brought up.
 */
export function contractAdvisory(spec, { appStarted }) {
  // The product's whole premise: a green test suite is not the same as a satisfied
  // requirement. A contract made only of `run:` commands proves exactly the thing
  // the tool exists to distrust, so say so — on a pass, where the false confidence is.
  const acceptance = spec.checks.some(c => 'http' in c || 'browser' in c || 'env' in c)

  // A status code says the app answered, not what it answered with. `infer` can only
  // generate `expect: {status: 200}` — it cannot know the requirement — so a contract built
  // from generated checks passes on a 200 carrying exactly the wrong body.
  const responseChecks = spec.checks.filter(c => 'http' in c || 'browser' in c)

  // Three different gaps, narrowing. Saying "nothing exercises the running application"
  // when `app boots` just passed is false: the app was started and answered. What is
  // missing there is narrower, and naming it precisely is the difference between advice
  // someone acts on and a caveat they learn to skip.
  return !acceptance && appStarted ? ADVISORY.liveness_only
    : !acceptance ? ADVISORY.no_runtime
      : responseChecks.length && !responseChecks.some(assertsContent) ? ADVISORY.status_only
        : null
}

/** Whether a check says anything about what the app returned, rather than that it answered. */
export const assertsContent = c =>
  Boolean((c.http && (c.http.expect?.body_contains !== undefined || c.http.expect?.json !== undefined))
    || (c.browser && (c.browser.flow ?? []).some(s => s?.expect_text !== undefined || s?.expect_request !== undefined)))

export const ADVISORY = {
  no_runtime:
    'Nothing in this contract exercises the running application — `run:` and `file:` checks cannot '
    + 'show that the requirement works. `proof infer` suggests acceptance checks for the current diff. '
    + '(If the requirement is about a command, a `run:` check that invokes it is exactly right.)',
  liveness_only:
    'The app was started and answered, but nothing asserts what it does — `app boots` shows it is up, '
    + 'not that the requirement works. Add an `http` or `browser` check for the behaviour the goal describes.',
  status_only:
    'No http or browser check here asserts what the app actually returned, only that it '
    + 'answered — a 200 carrying the wrong body passes. Add `expect: {body_contains: ...}` or '
    + '`expect: {json: ...}` to the checks that carry the requirement.',
}

// Exported for `attack`, which composes the same verbs into scenarios rather than into a
// contract. One implementation of "what a check does", whoever is asking.
export const RUNNERS = { run: runShell, http: runHttp, file: runFile, env: runEnv, browser: runBrowser }

const responds = async url => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) })
    return true
  } catch {
    return false
  }
}

/**
 * What "ready" means for this serve block, in the terms the contract set. Recorded as the
 * assertion, so a run can be read back — and so switching between the two signals reports
 * `Not comparable` rather than a regression in code that never moved.
 */
const readyAssertion = serve => serve.ready_log
  ? `the app logs a line matching /${serve.ready_log}/`
  : `the app becomes ready at ${serve.ready_url ?? serve.url}`

/** What was observed about how the app was started, and could not be gated on. */
const serveWarnings = (server, serve) => {
  const out = []
  if (server.reused) {
    out.push(`reuse_existing: something was already responding at ${server.url}`
      + ' — checks may be hitting a process proof did not start')
  }
  // proof kills the process group it spawned; a launcher that exited left the app outside
  // it. Saying nothing would leave a server running after a command that looks like it
  // cleaned up after itself.
  if (server.detached) {
    out.push(`\`${serve.run}\` exited after starting the app, so the app is outside the process group`
      + ' proof stops — it is still running now, and stopping it is yours to do')
  }
  // The absence of `app still running` from the checks is a decision, so it is said out loud.
  // With no `ready_url` there is nothing to ask, and with the launcher gone there is no process
  // proof holds either — a pass there would be a claim about something it lost track of.
  if (server.detached && !(serve.ready_url ?? serve.url)) {
    out.push('readiness came from the log and the launcher then exited, so nothing checks whether the app'
      + ' is still running at the end — there is no `ready_url` to ask and no process proof still holds.'
      + ' Add a `ready_url`, or run the app in the foreground.')
  }
  return out.length ? out : undefined
}

export async function boot(serve) {
  const url = serve.ready_url ?? serve.url
  const pattern = serve.ready_log ? new RegExp(serve.ready_log, 'i') : null
  if (!url && !pattern) throw new Error('serve needs a ready_url or a ready_log')
  const timeout = serve.timeout ?? 60

  // If the port already answers, nothing proof observes afterwards can be attributed to
  // the process it starts. A server that fails to bind then looks exactly like one that
  // booted, and every check runs against whatever was already there.
  //
  // Only where there is a port to look at. A `ready_log` app may have no listener at all.
  const wasUp = url ? await responds(url) : false
  if (url && serve.reuse_existing !== true && wasUp) {
    throw new Error(
      `something is already responding at ${url} before \`${serve.run}\` was started`
      + ' — proof cannot tell whether checks would reach your app'
      + ' (stop it, use a different port, or set `reuse_existing: true` to accept it)',
    )
  }
  const p = track(spawn(serve.run, { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }))
  // Same bound as run checks: a chatty dev server over a long run would otherwise grow
  // without limit in proof's memory.
  const sink = boundedSink()
  const log = () => sink.text()
  p.stdout.on('data', d => sink.push(d))
  p.stderr.on('data', d => sink.push(d))

  // Registered now, not at return time. A launcher that exits immediately had already
  // fired `close` by the time the old code subscribed, so the promise never resolved and
  // teardown waited on it forever — the command hung with the run complete.
  const closed = new Promise(res => p.once('close', res))
  const deadline = Date.now() + timeout * 1000
  let detached = false

  /**
   * What proof observed that made it call the app ready, or null.
   *
   * The matched line itself, not the word "matched": that line is usually where the app
   * states its port, its mode or its worker count, and it is the one thing worth reading
   * back off a run months later.
   *
   * When both signals are given the log gates readiness and the URL stays the base for http
   * checks — an app can bind its port before it has finished the work that makes it usable.
   */
  const observeReady = pattern
    ? async () => {
        const line = sink.text().split('\n').find(l => pattern.test(l))
        return line === undefined ? null : (line.trim() || `matched /${serve.ready_log}/`)
      }
    : async () => (await responds(url) ? `ready at ${url}` : null)

  while (Date.now() < deadline) {
    // A non-zero exit is the starter reporting failure, and nothing it started is worth
    // waiting for. A zero exit is different: `docker compose up -d` and every other
    // detaching launcher does exactly that, and treating it as a boot failure meant proof
    // declared the app dead without ever asking the URL — for a shape the README documents.
    // A signalled process has no exit code, so the old check saw nothing and polled until
    // the timeout — reporting an app that crashed on startup as one that was too slow, and
    // spending the whole budget to say it.
    if (p.signalCode !== null) {
      throw Object.assign(new Error(`serve ${describeSignal(p.signalCode)}`), { proc: p, log: log() })
    }
    if (p.exitCode !== null) {
      if (p.exitCode !== 0) {
        throw Object.assign(new Error(`serve exited early (code ${p.exitCode})`), { proc: p, log: log() })
      }
      detached = true
    }

    const readyBy = await observeReady()
    // resolves once stdio has closed, so callers can wait for the last log lines
    if (readyBy !== null) return { proc: p, url, reused: wasUp, detached, log, closed, readyBy }
    await new Promise(r => setTimeout(r, 500))
  }

  // A launcher that detached took the app's output with it, so a `ready_log` that never
  // matched is most likely a log proof was never given rather than an app that never started.
  // Saying "no line matched" there sends someone to read a log that is somewhere else.
  if (detached) {
    throw Object.assign(
      new Error(pattern
        ? `\`${serve.run}\` exited 0 and nothing in the output proof captured matched`
          + ` /${serve.ready_log}/ within ${timeout}s — a command that exits after starting the app`
          + " sends the app's output wherever it chose, so proof has no log to read. Run the app in"
          + ' the foreground, or use a `ready_url`.'
        : `\`${serve.run}\` exited 0 without anything answering at ${url} within ${timeout}s`
          + ' — if it starts the app in the background, check the port; if it is meant to stay in the'
          + ' foreground, it stopped before proof could reach it'),
      { proc: p, log: log() },
    )
  }
  throw Object.assign(
    new Error(pattern
      ? `no log line matched /${serve.ready_log}/ within ${timeout}s`
      : `not ready at ${url} within ${timeout}s`),
    { proc: p, log: log() },
  )
}

/** The app's own log gate, evaluated only once its output has finished arriving. */
function logCheck(serve, log, evidence, detached, name) {
  if (!serve.log_must_not_match) return null

  // A launcher that detached took the app's output with it: what proof captured is the
  // launcher's, which is usually empty. Scanning that and reporting "no matching log lines"
  // passed a gate the user wrote precisely to catch what was in the log it never saw.
  if (detached) {
    return {
      name,
      kind: 'serve',
      asserted: `no runtime log line matches ${JSON.stringify(serve.log_must_not_match)}`,
      ...fail(
        `no runtime log line matching /${serve.log_must_not_match}/`,
        `proof has no log to check — \`${serve.run}\` exited after starting the app, so the app's`
        + ' output goes wherever that command sent it. Run the app in the foreground for proof to'
        + ' read its log, or drop `log_must_not_match` and assert on the app instead.',
      ),
      evidence,
      ms: 0,
    }
  }

  const re = new RegExp(serve.log_must_not_match, 'i')
  const hit = log.split('\n').find(l => re.test(l))
  return {
    name,
    kind: 'serve',
    asserted: `no runtime log line matches ${JSON.stringify(serve.log_must_not_match)}`,
    ...(hit
      ? fail(`no runtime log line matching /${serve.log_must_not_match}/`, hit.trim(), tail(log))
      : pass('no matching log lines')),
    evidence,
    ms: 0,
  }
}

async function livenessCheck(serve, server, evidence, name) {
  const log = server.log()
  const out = []

  // `run` is usually a shell wrapper that outlives the app it spawned, so its exit
  // code alone is not liveness. Healthy means the app still answers.
  const url = serve.ready_url ?? serve.url

  // Nothing to ask. Liveness is then whether the process proof started is still there —
  // honest for an app in the foreground, and the strongest thing observable without a URL.
  // A launcher that exited by design leaves nothing to observe at all, so no check is
  // emitted; `serveWarnings` says so rather than let the omission be silent.
  if (!url) {
    if (server.detached) return out
    const exitCode = server.proc.exitCode
    const ended = exitCode !== null ? describeExit(exitCode, 'exited')
      : server.proc.signalCode !== null ? `was ${describeSignal(server.proc.signalCode)}`
        : null
    out.push({
      name,
      kind: 'serve',
      asserted: 'the process proof started is still running when the checks finish',
      ...(ended === null
        ? pass('still running at end of run')
        : fail('app still running at end of run', `the app ${ended}`, tail(log))),
      evidence,
      ms: 0,
    })
    return out
  }

  let reachable = false
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) })
    reachable = true
  } catch {}

  // Health is "still answering". The launcher's exit code is a diagnostic detail, not
  // the verdict — `npm run dev` style wrappers exit with 0 even when the app crashed.
  const exitCode = server.proc.exitCode
  // A signalled process has no exit code, ever — and `sh -c "python3 server.py"` execs, so
  // the app IS the process proof spawned and a crash arrives as a signal rather than as the
  // shell's 128+N. Reading only `exitCode` reported that case, the one with the most to say,
  // as the one with nothing to say: "no longer responding", cause dropped.
  const ended = exitCode !== null ? describeExit(exitCode, 'exited')
    : server.proc.signalCode !== null ? `was ${describeSignal(server.proc.signalCode)}`
      : null
  out.push({
    name,
    kind: 'serve',
    asserted: 'the app is still responding when the checks finish',
    ...(reachable
      ? pass('still responding at end of run')
      : fail(
          'app still responding at end of run',
          `no longer responding at ${url}${ended ? `; the launcher ${ended}` : ''}`,
          tail(log),
        )),
    evidence,
    ms: 0,
  })

  return out
}

/**
 * Highest numeric directory name. Folded rather than spread into `Math.max`: an argument
 * list of that size throws RangeError somewhere past a hundred thousand runs, and the
 * crash would block every further run with a stack-overflow message.
 */
export const highestRunId = names =>
  names.reduce((max, name) => {
    const value = Number(name)
    return Number.isInteger(value) && value > max ? value : max
  }, 0)

// A run that cannot write its evidence has not verified anything it can show, so it stops.
export const evidenceError = (e, path) =>
  writeError(e, path, 'evidence',
    'Every run records what it checked there; make the directory writable, or point `--spec`'
    + ' at a contract in a writable tree.')

function nextRunDir() {
  const runs = join(PROOF_DIR, 'runs')
  try {
    mkdirSync(runs, { recursive: true })
  } catch (e) { throw evidenceError(e, runs) }
  let n = highestRunId(readdirSync(runs))

  // Claim the directory exclusively. `recursive: true` succeeds on an existing directory,
  // so two runs racing between the readdir and the mkdir would share one — and the second
  // to finish would overwrite the first's evidence with no error at all.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const dir = join(runs, String(++n).padStart(4, '0'))
    try {
      mkdirSync(dir)
      return dir
    } catch (e) {
      if (e.code !== 'EEXIST') throw evidenceError(e, dir)
    }
  }
  throw new Error(`could not allocate a run directory under ${runs}`)
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

// How often a retried check asks again. Fixed rather than backing off: the budget is the
// contract's, and a backoff would spend most of it asleep near the end.
const RETRY_INTERVAL_MS = 250

/**
 * Checks grouped into the units that run together.
 *
 * A run of consecutive `parallel: true` checks becomes one batch; everything else is a batch
 * of one. The batch is a barrier, so a contract's order still means what it meant — a login
 * before the profile read, a seed before the assertion — and only the checks whose author
 * said they are independent overlap.
 */
export function batchChecks(selected) {
  const batches = []
  selected.forEach((check, index) => {
    const entry = { check, index }
    const last = batches[batches.length - 1]
    if (check?.parallel === true && last?.[0]?.check?.parallel === true) last.push(entry)
    else batches.push([entry])
  })
  return batches
}

/**
 * One check: its variables filled in, run, and whatever it captures recorded.
 *
 * Capture happens only on a pass. A value read off a failed response is a value read off the
 * wrong thing, and every later check built on it would fail for a reason that is not its own.
 */
async function runOne({ check: c, index }, ctx, vars, producedBy) {
  const kind = Object.keys(RUNNERS).find(k => k in c)
  if (!kind) throw new Error(`check "${c.name ?? JSON.stringify(c)}" has no known verb (${Object.keys(RUNNERS).join('|')})`)
  // index-suffixed so unnamed checks cannot collide in the results map either
  const name = c.name ?? `${kind} check ${index + 1}`

  // Quarantined on purpose. Recorded as a check with a reason rather than removed, and the
  // run reports INCOMPLETE for it — a contract with a check switched off has not been proved.
  if (c.skip !== undefined) {
    return {
      name,
      kind,
      asserted: describe(c, kind),
      ...(satisfied(c).length ? { criteria: satisfied(c) } : {}),
      status: 'skipped',
      observed: c.skip,
      ms: 0,
    }
  }

  // Same split as the validator: a shell command keeps whatever proof did not capture, so
  // `run: ./verify.sh ${order_id} "$HOME/${OTHER}"` substitutes the first and leaves the rest.
  const { run: command, ...rest } = c
  const { filled, missing } = substitute(rest, vars)
  if (command !== undefined) filled.run = substitute(command, vars).filled
  if (missing.length) {
    const why = missing.map(n => (producedBy.has(n)
      ? `\`${n}\` is captured by "${producedBy.get(n)}", which did not run or did not pass`
      : `nothing captures \`${n}\``))
    return {
      name,
      kind,
      asserted: describe(c, kind),
      ...fail(`the values this check uses are available`, `no value for ${missing.map(n => `\${${n}}`).join(', ')} — ${why.join('; ')}`),
      // This check never ran. It failed because something it depends on did, and a summary
      // that counts it alongside the real failure reports eighteen problems where there is
      // one — the same reason a boot failure short-circuits the rest of the run.
      unmet: true,
      ms: 0,
    }
  }

  const t0 = Date.now()
  // Work an app does after it answers — a queued job, a webhook, a read replica catching up —
  // is not something a single request can see. Without this the only way to verify it was a
  // `run:` check shelling out to a sleep loop, which is a worse test written worse.
  const deadline = c.retry_for_ms !== undefined ? t0 + c.retry_for_ms : null
  let r
  let attempts = 0
  for (;;) {
    attempts += 1
    // A crashing runner fails its own check; it must not discard the evidence
    // every earlier check already produced. Only pre-run errors (bad spec,
    // missing spec) abort the whole run.
    try {
      r = await RUNNERS[kind](filled, ctx)
    } catch (e) {
      // Flagged, not just described: a crashed runner says nothing about the code it was
      // pointed at, and a reader deciding what a failure means needs to tell the two apart.
      r = { ...fail(`${kind} check runs`, `check crashed: ${crashReason(e)}`), crashed: true }
    }
    if (r.status === 'passed' || !deadline || Date.now() >= deadline) break
    await new Promise(res => setTimeout(res, RETRY_INTERVAL_MS))
  }
  const ms = Date.now() - t0

  // The number of attempts is the difference between "it never worked" and "it took a while
  // and then stopped working", and only one of those is a timing problem.
  if (deadline && r.status === 'failed') {
    r = { ...r, observed: `${r.observed} — still failing after ${c.retry_for_ms}ms (${attempts} attempt(s))` }
  }
  if (deadline && attempts > 1) r = { ...r, attempts }

  // The contract asked for a value this response does not carry. That is an assertion about
  // the response, so it fails the check rather than quietly leaving the variable unset.
  const captured = []
  if (r.status === 'passed' && isPlainObject(filled.capture)) {
    for (const [varName, selector] of Object.entries(filled.capture)) {
      const got = captureValue(selector, r.source ?? {})
      if (got.error) {
        r = fail(`\`${selector}\` yields ${varName}`, `nothing to capture for \${${varName}} — ${got.error}`, r.output)
        break
      }
      vars.set(varName, got.value)
      captured.push(varName)
    }
  }

  // After the check's own verdict, and only over a pass: a wrong answer delivered quickly is
  // still the wrong answer, and naming the slowness first would hide it.
  if (r.status === 'passed' && c.expect_under_ms !== undefined && ms > c.expect_under_ms) {
    r = fail(`a response in under ${c.expect_under_ms}ms`, `took ${ms}ms`, r.output)
  }

  // Names only. A captured value is as likely to be a token as an id, and evidence bundles
  // get shared — the same rule cookie values are held to.
  return {
    name,
    kind,
    asserted: describe(filled, kind) + (c.retry_for_ms ? `, retried for up to ${c.retry_for_ms}ms` : ''),
    // Which criteria this check is evidence for, carried on the result rather than looked up
    // from the contract later: the contract moves, and a run has to be readable without it.
    ...(satisfied(c).length ? { criteria: satisfied(c) } : {}),
    ...r,
    ...(captured.length ? { captured } : {}),
    ms,
  }
}

export async function check({ json = false, specPath, only, criterion, baseUrl: baseUrlOverride } = {}) {
  // One run per project at a time — but only for a contract that starts something.
  //
  // Concurrent runs are a deliberate feature and each gets its own evidence directory (see
  // test/concurrent-runs.test.js). A contract of pure `run:` checks owns no port and no build
  // directory, so several at once are harmless. A contract with a `serve:` block owns both,
  // and two of those destroy each other — see src/runlock.js.
  //
  // A contract that will not load is not locked: runCheck below produces the real error, and a
  // lock failure here would replace it with a worse one.
  let serves = []
  try { serves = serveList(loadSpec(specPath)) } catch { /* runCheck reports it properly */ }
  const release = serves.length
    ? acquire({ spec: specPath ?? SPEC_PATH, command: 'check' })
    : () => {}
  try {
    return await runCheck({ json, specPath, only, criterion, baseUrl: baseUrlOverride })
  } finally {
    release()
  }
}

async function runCheck({ json = false, specPath, only, criterion, baseUrl: baseUrlOverride } = {}) {
  const spec = loadSpec(specPath)

  // A contract still holding one of proof's own placeholders is unfinished, and an
  // unfinished contract passes: `proof init` on a project with no test command produced a
  // contract whose only check was `echo "replace me..."`, and the first `proof check`
  // printed VERDICT DONE for a requirement nothing had verified.
  const unfinished = placeholderChecks(spec)
  if (unfinished.length) {
    const e = new Error(`${specPath ?? SPEC_PATH} is unfinished:\n${unfinished.map(u => `  - ${u.message}`).join('\n')}`)
    e.code = 'EUNFINISHED'
    throw e
  }

  // A subset run is for iterating on one failure fast. It can never say "done" —
  // completion is a claim about the whole contract, including regressions.
  //
  // `--criterion` selects the same way `--only` does, by what the checks say about themselves
  // rather than by their names: the evidence for one requirement, which is what an agent
  // iterating on one acceptance criterion wants, and what `challenge` needs to ask whether a
  // fault is caught by the checks that carry the criterion it breaks.
  if (only && criterion) {
    throw Object.assign(
      new Error('--only and --criterion are alternatives — one selects by name, the other by the'
        + ' criterion a check declares it satisfies. Keep whichever this run means.'),
      { code: 'EUSAGE' })
  }

  const wanted = criterion ? String(criterion).split(',').map(id => id.trim()).filter(Boolean) : []
  if (wanted.length) {
    const declared = new Set(criteriaList(spec).map(c => String(c.id)))
    const unknown = wanted.filter(id => !declared.has(id))
    if (unknown.length) {
      throw Object.assign(
        new Error(`no criterion ${unknown.map(id => `"${id}"`).join(', ')} in ${specPath ?? SPEC_PATH}`
          + ` — have: ${[...declared].join(', ') || 'none declared'}`),
        { code: 'ENOCRITERION' })
    }
  }

  const selected = only
    ? spec.checks.filter(c => String(c.name ?? '').toLowerCase().includes(only.toLowerCase()))
    : wanted.length
      ? spec.checks.filter(c => satisfied(c).some(id => wanted.includes(id)))
      : spec.checks
  if (only && !selected.length) {
    throw Object.assign(new Error(`no check matches "${only}" — have: ${spec.checks.map(c => c.name ?? '(unnamed)').join(', ')}`), { code: 'ENOMATCH' })
  }
  if (wanted.length && !selected.length) {
    throw Object.assign(
      new Error(`no check declares \`satisfies: [${wanted.join(', ')}]\`, so there is no evidence to run`
        + ' for it — that is the gap `proof check` reports as an uncovered criterion'),
      { code: 'ENOMATCH' })
  }
  const partial = selected.length !== spec.checks.length

  // Read before this run is recorded, so the baseline is the run before it — and the window
  // behind that is what says whether a check has been disagreeing with itself all along.
  const history = recentResults(specPath ?? SPEC_PATH, FLAKE_WINDOW)
  // The most recent run on THIS commit's lineage, which is not always the most recent run.
  //
  // `.proof/runs` is one directory for the whole repository, and branches share it. A run
  // recorded on another branch describes a state this commit never had, so "passed in run 12,
  // fails now" from there is a sentence about somebody else's work — and it is the sentence an
  // agent acts on hardest, because it means "you broke this". Switch branches, run the
  // contract, and the feature that only ever existed on the other branch was reported as a
  // regression on this one.
  //
  // Outside a repository there are no branches to confuse, so the most recent run is the
  // baseline as before. A run that predates git context is skipped rather than guessed at.
  //
  // Two tiers, because "most recent run that is an ancestor" is not the same as "the run this
  // one follows". A branch shares its base commit with every other branch, so a run recorded
  // there is an ancestor of all of them and would outrank this branch's own run purely by
  // having happened later. The run at THIS commit — the ordinary edit-and-rerun loop — comes
  // first; only when there is none does the search widen to the lineage.
  const now = head()
  const onLineage = inRepo() && now
    ? (history.find(h => h.result?.git?.head === now) ?? history.find(h => isAncestor(h.result?.git?.head)))
    : history[0]
  const before = onLineage ?? null
  const previousRun = before?.id ?? null
  // Keyed with what each check asserted, not just its status. A check edited between runs
  // keeps its name, and "passed in run 0001, fails now" then reads as a regression in the
  // code when nothing about the code moved — the assertion did.
  const previously = new Map((before?.result.results ?? [])
    .filter(r => r && typeof r.name === 'string')
    .map(r => [r.name, { status: r.status, asserted: r.asserted ?? null }]))

  const runDir = nextRunDir()
  const results = []

  // The processes this contract starts, in the order they must start. Booted sequentially and
  // each one ready before the next begins: the order in the contract is the dependency order,
  // and an API that comes up before its database is not a faster run, it is a failing one.
  const serves = serveList(spec)
  const started = []

  // Pointed at something already running — a preview deployment, staging, a stack someone
  // else brought up. proof starts nothing, so the checks it adds for a serve block are not
  // claims it can make, and it says so rather than quietly dropping three rows.
  const against = baseUrlOverride ?? null
  if (against !== null) {
    // Same rule as `serve.ready_url`, for the same reason: a scheme-less value can never be
    // fetched, and every check would fail blaming the deployment for a typo on the command line.
    let parsed
    try { parsed = new URL(against) } catch { parsed = null }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      throw Object.assign(
        new Error(`--base-url must be an absolute http(s) URL — "${against}" cannot be fetched`),
        { code: 'EUSAGE' })
    }
  }
  const baseUrl = against ?? serveBase(serves)

  // Captured BEFORE the checks, so the bundle describes the tree that was actually
  // verified rather than whatever it looks like once they finish.
  const git = gitContext()
  const treeBefore = fingerprint()

  // `serve.log` for a single process, so every evidence bundle the docs quote and every path a
  // recorded run already holds is unchanged. One file per process once there are several.
  const logPathFor = (s, i) =>
    join(runDir, serves.length > 1 ? `serve-${slug(serveLabel(s, i))}.log` : 'serve.log')
  let tornDown = false

  // A full run honours the contract as written: `app boots`, `app still running` and the log
  // gate are checks in their own right, whatever verbs the rest uses. A *subset* skips the
  // server when nothing selected needs it — `--only "unit tests"` booted the dev server
  // anyway, and a server that would not start failed the run before the selected check ever
  // ran, blocking someone iterating on one unit test for an unrelated reason.
  const narrowed = Boolean(only) || wanted.length > 0
  const needsApp = !against && (!narrowed || selected.some(c => 'http' in c || 'browser' in c))

  try {
    if (serves.length && needsApp) {
      for (const [i, s] of serves.entries()) {
        const t0 = Date.now()
        const logPath = logPathFor(s, i)
        try {
          const server = await boot(s)
          started.push({ serve: s, index: i, server, logPath })
          results.push({
            name: serveCheckName(serves, i, 0),
            kind: 'serve',
            asserted: readyAssertion(s),
            ...pass(server.readyBy),
            warnings: serveWarnings(server, s),
            ms: Date.now() - t0,
          })
        } catch (e) {
          if (e.proc) { kill(e.proc); untrack(e.proc) }
          writeFileSync(logPath, e.log ?? '')
          results.push({
            name: serveCheckName(serves, i, 0),
            kind: 'serve',
            asserted: readyAssertion(s),
            ...fail('app becomes ready', e.message, tail(e.log ?? '')),
            evidence: [logPath],
            ms: Date.now() - t0,
          })
          // Nothing later is worth starting. The API cannot come up without its database, so
          // every process after this one would fail for a reason that is not its own — and a
          // list of failures whose causes are all the first one is a list nobody can read.
          break
        }
      }
    }

    // ponytail: boot failure short-circuits — every downstream check would fail for the same reason.
    if (!results.some(r => r.status === 'failed')) {
      // one session for the run, shared by the http checks in the order they are written
      const ctx = { baseUrl, runDir, cookies: new Map() }
      // What earlier checks captured. `${order_id}` in a later check resolves from here.
      const vars = new Map()
      // Which check produces each name, so a reference that resolves to nothing can say why.
      const producedBy = new Map()
      for (const c of selected) {
        for (const name of Object.keys(isPlainObject(c?.capture) ? c.capture : {})) {
          if (!producedBy.has(name)) producedBy.set(name, c.name ?? '(unnamed)')
        }
      }

      for (const batch of batchChecks(selected)) {
        // A batch of one is the ordinary case and stays exactly as sequential as before.
        const outcomes = batch.length === 1
          ? [await runOne(batch[0], ctx, vars, producedBy)]
          : await Promise.all(batch.map(entry => runOne(entry, ctx, vars, producedBy)))
        // Back in contract order whatever order they finished in: evidence that reorders
        // itself between runs cannot be diffed, and `--only` selects by what it shows.
        results.push(...outcomes)
      }
    }

    // Runtime verification: a dev server that died halfway through explains every
    // connection error after it, and nothing else in the run would say so.
    if (started.length) {
      // Settle before judging anything. The window exists so late output lands, but it is
      // also the window in which a crash caused by the last check happens: probing liveness
      // first reported "still running" for an app the run had just killed.
      await new Promise(res => setTimeout(res, SETTLE_MS))

      // Now ask whether they survived — while they are all still ours to ask.
      for (const { serve, index, server, logPath } of started) {
        results.push(...await livenessCheck(serve, server, [logPath], serveCheckName(serves, index, 1)))
      }

      // Then stop them and wait for their output to finish arriving. Reading a log while the
      // child is still writing loses the last lines, which are exactly the ones that explain
      // a failure.
      //
      // In reverse: the app before the database it talks to. Killing a dependency first makes
      // every dependent log a connection error on the way down, and those lines land in the
      // window `log_must_not_match` reads — failing a gate over a teardown proof caused.
      for (const { server } of [...started].reverse()) {
        kill(server.proc)
        untrack(server.proc)
      }
      tornDown = true
      await Promise.race([
        Promise.all(started.map(s => s.server.closed)),
        new Promise(res => setTimeout(res, 2000).unref?.()),
      ])

      for (const { serve, index, server, logPath } of started) {
        const log = server.log()
        writeFileSync(logPath, log)
        const gate = logCheck(serve, log, [logPath], server.detached, serveCheckName(serves, index, 2))
        if (gate) results.push(gate)
      }
    }
  } finally {
    if (!tornDown) for (const { server } of started) { kill(server.proc); untrack(server.proc) }
  }

  // Everything the contract lists before the last selected check, that this run skipped.
  const lastSelected = spec.checks.lastIndexOf(selected[selected.length - 1])
  const skippedBefore = spec.checks
    .slice(0, lastSelected)
    .filter(c => !selected.includes(c))
    .map((c, i) => c.name ?? `check ${i + 1}`)

  const serveSkipped = serves.length > 0 && !needsApp
  const failures = results.filter(r => r.status === 'failed')

  // Requirement coverage. A check passing is evidence for whatever that check asserts; a
  // criterion with nothing pointing at it has no evidence at all, however green the run is.
  const criteria = coverage(spec, results)
  const uncoveredIds = uncovered(criteria)
  // Which contract produced this verdict, and whether it is still the one that was sealed.
  const seal = integrity(spec, specPath ?? SPEC_PATH)
  // Checks the contract itself switched off. A completion verdict is a claim about the whole
  // contract, so one of these withholds it exactly as a subset run does — the difference is
  // that the reason is written in the file and travels with the diff.
  const skipped = results.filter(r => r.status === 'skipped').map(r => ({ check: r.name, reason: r.observed }))
  // Three ways a green run still makes no completion claim: it ran part of the contract, the
  // contract switched a check off, or a criterion has no evidence in it at all. A fourth when
  // the contract was sealed and has moved since — the evidence is about a definition of "done"
  // nobody has reviewed.
  const incomplete = partial || skipped.length > 0 || uncoveredIds.length > 0 || seal.status === 'modified'
  // Evidence proof already had and never read: every run of this contract is on disk, and the
  // only one ever consulted was the last. A check that passes four runs in five rendered
  // exactly like one that always passes.
  const flaky = flakiness(history, results, treeBefore)

  const appStarted = serves.length > 0 && !serveSkipped
  // Not on a subset run. Every advisory is a statement about what the whole contract proves,
  // and a subset did not run the whole contract — the INCOMPLETE verdict already says the
  // run makes no completion claim. Reporting "no http check asserts content" for checks that
  // were never selected is a caveat about something the reader did not ask for.
  const advisory = incomplete || failures.length ? null : contractAdvisory(spec, { appStarted })
  const assertedBy = new Map(results.map(r => [r.name, r.asserted ?? null]))

  const result = {
    status: failures.length ? 'failed' : incomplete ? 'partial' : 'passed',
    goal: spec.goal ?? null,
    // Which contract this verdict is about. With `--spec` a project can have several, and
    // they all write into one `.proof/runs` — two contracts sharing a goal produced runs
    // nothing could tell apart.
    spec: specPath ?? SPEC_PATH,
    run: runDir,
    at: new Date().toISOString(),
    git,
    partial,
    only: only ?? null,
    // Which criterion's evidence this run selected, when that is how it was narrowed.
    criterion: wanted.length ? wanted : null,
    // Said out loud: the absence of `app boots` from a subset run is a decision, not a gap.
    serve_skipped: serveSkipped,
    // Checks switched off in the contract, each with the reason written beside it.
    skipped,
    // Each declared criterion, the checks that carry it, and what this run says about them.
    criteria,
    // The contract this verdict is about, by content, and whether that is the sealed one.
    contract_hash: seal.hash,
    contract_integrity: seal.status,
    // Checks whose recent history holds both outcomes for the same assertion.
    flaky,
    // The app this run was pointed at, when it was not one proof started.
    against,
    advisory,
    warnings: [
      // Nothing here was started, so three of the checks a serve block earns are claims proof
      // cannot make, and `env:` reads proof's own environment rather than the deployment's.
      // A run that dropped those rows silently would look like a contract that never had them.
      ...(against
        ? [`checks ran against ${against}, which proof did not start — \`app boots\`, \`app still running\``
          + " and the log gate were not run, `run:` and `file:` checks still ran here, and an `env:` check"
          + " reads proof's own environment rather than that deployment's"]
        : []),
      // The same rule as `--only`: a switched-off check is a hole in the verdict, and it has
      // to be visible in the run rather than only in the file.
      // A green run carrying one of these is the case worth interrupting: the verdict is the
      // thing being trusted, and it was arrived at by a check that does not always agree.
      ...flaky.map(fillFlakyNotice),
      // A criterion nobody wrote a check for. The run is green and the requirement it names
      // has no evidence in it — the gap this whole layer exists to make visible.
      ...(uncoveredIds.length ? [fillUncoveredNotice(uncoveredIds)] : []),
      // The contract moved after it was sealed, so this verdict is against expectations
      // nobody has reviewed since.
      ...(seal.status === 'modified' ? [fillModifiedNotice(seal)] : []),
      ...(skipped.length
        ? [`${skipped.length} check(s) are skipped in the contract (${skipped.map(s => `${s.check}: ${s.reason}`).join('; ')})`
          + ' — this run cannot report completion while they are']
        : []),
      // `changed` says this too, but the DONE verdict is the thing CI and agents act on, and
      // a verdict is a claim about a contract. If this diff rewrote the contract, the claim
      // is against expectations the same diff set — which the verdict alone cannot show.
      ...contractWarning(specPath),
      // The same fact about the other half of the verification. `changed` reports both; the
      // verdict is what gets acted on, and "the suite passed" means less when this diff is
      // also what the suite now says.
      ...testsWarning(),
      ...results.flatMap(r => (r.warnings ?? []).map(w => `${r.name}: ${w}`)),
      // Relative `path` and `visit` values resolve against exactly one URL. Where several
      // processes declare one, which was chosen is not something to leave implicit: a contract
      // verified against the wrong service passes, for a reason nothing in the run shows.
      ...(appStarted && serves.filter(s => s.ready_url ?? s.url).length > 1
        ? [`${serves.filter(s => s.ready_url ?? s.url).length} serve blocks declare a URL, so relative`
          + ` \`path\` and \`visit\` values resolve against the last of them (${serveBase(serves)}).`
          + ' Point a check at another with an absolute `url`, or a `browser.base_url`.']
        : []),
      // A verdict describes the code that was checked. If the tree moved while checking,
      // say so — in an agent loop the editor may still be running.
      ...(treeBefore && fingerprint() !== treeBefore
        ? ['the working tree changed while this run was in progress — the verdict describes the code as it was when the run started']
        : []),
      // Checks run in order against one app and share a cookie jar, so a subset that skips
      // earlier ones starts from a different state. `--only profile` failed with a bare 401
      // because `login` never ran — a failure an agent reads as an auth bug in the code.
      ...(skippedBefore.length
        ? [`${skippedBefore.length} check(s) earlier in the contract did not run (${skippedBefore.join(', ')})`
          + ' — whatever state they establish is absent here: a login, a cookie, a seeded database,'
          + ' a file an earlier command wrote. A failure in this subset may be the subset rather'
          + ' than the code']
        : []),
    ],
    tree: treeBefore, // lets `proof report` say when the code has moved on since this verdict

    // Counted separately on purpose. Folding the synthetic serve checks into the contract
    // total made a subset run report "selected 3 of 4" when it had covered 1 of 3.
    contract_checks: spec.checks.length,
    selected_checks: selected.length,
    ran_checks: results.filter(r => r.kind !== 'serve' && r.status !== 'skipped').length,
    checks: Object.fromEntries(results.map(r => [r.name, r.status])),
    // `full` and `source` are stripped here: result.json stays readable, commands.log holds
    // everything the command said, and a capture source carries headers and whole bodies.
    results: results.map(({ full, source, ...rest }) => rest),
    // Always all five keys. JSON.stringify drops undefined, so a failure with no output
    // used to lose the field entirely — and an agent reading failure.output would crash
    // on exactly the failures that carry the least context.
    failures: failures.map(({ name, expected, observed, output, evidence, unmet }) => ({
      check: name,
      expected: expected ?? null,
      observed: observed ?? null,
      output: output ?? null,
      evidence: evidence ?? null,
      // True when the check never ran: a value it needed was never captured, because the
      // check that produces it failed. A cause, not a problem of its own.
      unmet: Boolean(unmet),
      // "You broke this" and "you have not finished this" render identically without it, and
      // only one of them is about the change just made.
      was: comparableStatus(previously.get(name), assertedBy.get(name)),
      since: previously.has(name) ? previousRun : null,
    })),
  }

  try {
    writeFileAtomic(join(runDir, 'result.json'), JSON.stringify(result, null, 2))
  } catch (e) { throw evidenceError(e, runDir) }
  // The `$` promised a command the line never showed. Record what the check required, so
  // the log can be read back without the contract that produced it.
  writeFileAtomic(join(runDir, 'commands.log'), results.map(r =>
    `$ ${r.name} [${r.kind}] -> ${r.status} (${r.ms}ms)\n`
    + (r.asserted ? `  asserted: ${r.asserted}\n` : '')
    + `${r.full ?? r.output ?? ''}\n`).join('\n'))

  if (json) console.log(JSON.stringify(stripOutput(result), null, 2))
  else printHuman(result)

  return failures.length ? 1 : 0
}

// keep --json payloads small; full output lives in the evidence bundle
const stripOutput = r => ({
  ...r,
  results: r.results.map(({ output, ...rest }) => rest),
  failures: r.failures.map(f => ({ ...f, output: f.output ? tail(f.output, 20) : null })),
})

export const VERDICT = {
  passed: 'DONE',
  failed: 'NOT DONE',
  partial: 'INCOMPLETE — this run does not make a completion claim',
}

/**
 * The verdict line, with the reason a completion claim is being withheld.
 *
 * A subset run and a run with an uncovered criterion are both INCOMPLETE and have nothing else
 * in common, and "selected checks passed" printed under a full run that covered nothing was an
 * answer to a question nobody asked.
 */
export const verdictLine = r => (r.status === 'partial' && r.partial
  ? 'INCOMPLETE — selected checks passed; run `proof check` for a completion verdict'
  : VERDICT[r.status] ?? r.status)

/** The tag in the CHECKS column. A skip is neither of the two things a verdict is made of. */
export const STATUS_TAG = { passed: 'PASS', failed: 'FAIL', skipped: 'SKIP' }

// Colour only for a person at a terminal: a pipe, a log file or NO_COLOR gets the plain text,
// and so does every test that captures console.log.
const tty = () => process.stdout.isTTY && !process.env.NO_COLOR
const paint = code => text => tty() ? `\x1b[${code}m${text}\x1b[0m` : text
const bold = paint('1'), dim = paint('2')
const TAG_COLOR = { passed: paint('32'), failed: paint('31'), skipped: paint('33') }
const VERDICT_COLOR = { passed: paint('1;32'), failed: paint('1;31') }

/**
 * The tally as a bar, one colour per status. Any nonzero count keeps at least one cell: one
 * failure among five hundred checks is the thing the bar exists to show.
 */
export function tallyBar(counts, width = 30) {
  const total = counts.reduce((n, c) => n + c.n, 0)
  if (!total) return ''
  const cells = counts.map(c => c.n ? Math.max(1, Math.round(c.n / total * width)) : 0)
  cells[cells.indexOf(Math.max(...cells))] += width - cells.reduce((a, b) => a + b, 0)
  return counts.map((c, i) => cells[i] ? c.paint('█'.repeat(cells[i])) : '').join('')
}

function printHuman(r) {
  const names = r.results.map(x => truncateToWidth(x.name, NAME_COLUMN_MAX))
  const w = columnWidth(r.results.map(x => x.name), NAME_COLUMN_MAX)
  console.log(`\n${bold('PROOF')}`)
  if (r.goal) console.log(`\n${bold('Requirement:')}\n${block(r.goal, '  ')}`)
  console.log(`\n${bold('CHECKS')}`)
  r.results.forEach((c, i) => console.log(`  ${padTo(names[i], w + 2)}${(TAG_COLOR[c.status] ?? TAG_COLOR.failed)(STATUS_TAG[c.status] ?? 'FAIL')}`))
  for (const f of r.failures) {
    console.log(`\n${bold(paint('31')('FAILURE'))}\n  Check:\n    ${f.check}`)
    // The one fact that separates "this change broke it" from "this change did not fix it".
    // Both render identically otherwise, and only the first is about the edit just made.
    if (f.was === 'passed') console.log(`  Regression:\n    passed in run ${f.since}, fails now`)
    else if (f.was === 'failed') console.log(`  Not new:\n    also failed in run ${f.since}`)
    else if (f.was === 'changed') console.log(`  Not comparable:\n    this check asserted something else in run ${f.since}`)
    if (f.expected) console.log(`  Expected:\n${block(f.expected)}`)
    console.log(`  Observed:\n${block(f.observed)}`)
    // Also bound each line's width: a minified JSON body is a single line, so line-based
    // clipping alone lets 4000 characters flood the terminal.
    if (f.output) {
      const shown = clip(f.output, 8, 8).split('\n').map(l => '    ' + ellipsize(l)).join('\n')
      console.log(`  Output:\n${shown}`)
    }
    if (f.evidence?.length) console.log(`  Evidence:\n${f.evidence.map(e => '    ' + e).join('\n')}`)
  }
  if (r.partial) {
    const skipped = r.serve_skipped ? ' The serve block was not started: nothing selected needs it.' : ''
    const how = r.criterion ? `--criterion ${r.criterion.join(',')}` : `--only "${r.only}"`
    console.log(`\nSubset run: ${how} selected ${r.selected_checks} of ${r.contract_checks} check(s).${skipped}`)
  }
  // The requirement, check by check. Passing checks are evidence for what the checks assert;
  // this is the column that says whether that adds up to what was asked for.
  if (r.criteria?.length) {
    const idWidth = columnWidth(r.criteria.map(c => c.id), 12)
    const textWidth = columnWidth(r.criteria.map(c => c.requirement ?? ''), 48)
    console.log('\nREQUIREMENT COVERAGE')
    for (const c of r.criteria) {
      console.log(`  ${padTo(truncateToWidth(c.id, 12), idWidth + 2)}`
        + `${padTo(truncateToWidth(c.requirement ?? '', 48), textWidth + 2)}${c.status.toUpperCase()}`)
    }
  }

  if (r.skipped?.length) {
    console.log(`\nSKIPPED\n${r.skipped.map(s => `  ${s.check} — ${s.reason}`).join('\n')}`)
  }
  const indent = w => wrap(w, TERMINAL_WIDTH - 2).map(l => `  ${l}`).join('\n')
  if (r.warnings?.length) {
    // Blank line between them: these are separate facts, and run together as one block the
    // second one begins mid-sentence-looking, right after the first one's full stop.
    console.log(`\nOBSERVED BUT NOT GATED\n${r.warnings.map(indent).join('\n\n')}`)
  }

  // One NOTE section, not two with an Evidence block between them wearing the same heading.
  const notes = [r.advisory, evidenceGrowth(RUNS())].filter(Boolean)
  if (notes.length) console.log(`\nNOTE\n${notes.map(indent).join('\n\n')}`)
  console.log(`\n${bold('Evidence:')}\n  ${dim(join(r.run, 'result.json'))}\n  ${dim(join(r.run, 'commands.log'))}`)
  // A tally, because at any size past a handful nobody counts the rows — and past a
  // screenful the list has scrolled away by the time the verdict appears.
  const count = status => r.results.filter(c => c.status === status).length
  const tally = [
    `${count('passed')} passed`,
    ...(count('failed') ? [`${count('failed')} failed`] : []),
    ...(count('skipped') ? [`${count('skipped')} skipped`] : []),
  ].join(', ')

  // On its own line: the INCOMPLETE verdict already carries a sentence, and appending to it
  // produced a run-on with two em-dashes.
  const covered = r.criteria?.length
    ? `, ${r.criteria.filter(c => c.status === 'verified').length}/${r.criteria.length} criteria verified`
    : ''
  // The bar is decoration for a person at a terminal; logs and pipes keep the plain tally line.
  const bar = tty()
    ? tallyBar(['passed', 'failed', 'skipped'].map(s => ({ n: count(s), paint: TAG_COLOR[s] }))) + '  '
    : ''
  console.log(`\n${bold('VERDICT')}\n  ${(VERDICT_COLOR[r.status] ?? paint('1;33'))(verdictLine(r))}\n  ${bar}${tally}${covered}\n`)
}
