import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { loadSpec, PROOF_DIR, SPEC_PATH, writeFileAtomic, writeError, contractChange, CONTRACT_CHANGED_NOTICE } from './spec.js'
import { placeholderChecks, SERVE_CHECK_NAMES } from './validate.js'
import { evidenceGrowth, RUNS, previousResult } from './runs.js'
import { context as gitContext, fingerprint, inRepo } from './git.js'
import { testsChanged, fillTestsNotice } from './diff.js'
import { runBrowser, slug } from './browser.js'
import { jsonMismatch } from './json-match.js'
import { TERMINAL_WIDTH, padTo, truncateToWidth, wrap, block, columnWidth, ellipsize } from './terminal.js'

export { TERMINAL_WIDTH } from './terminal.js'

// One descriptive name is enough to pad every row past the terminal width.
const NAME_COLUMN_MAX = 48

const pass = (observed, output) => ({ status: 'passed', observed, output })
const fail = (expected, observed, output) => ({ status: 'failed', expected, observed, output })

// Kill the whole process group: `sh -c "npm test"` forks, so signalling the shell
// alone orphans every grandchild — a timed-out dev server keeps holding its port.
const kill = p => {
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

async function runShell(c) {
  const timeout = c.timeout ?? 600
  const r = await sh(c.run, timeout)
  const full = r.out + r.err
  const log = clip(full)
  const wantExit = c.expect_exit ?? 0

  const result = r.timedOut ? fail(`exit ${wantExit}`, `timed out after ${timeout}s`, log)
    : r.signal ? fail(`exit ${wantExit}`, describeSignal(r.signal), log)
      : r.code !== wantExit ? fail(`exit ${wantExit}`, describeExit(r.code), log)
      // `!== undefined`, never truthiness: `expect_output: 0` is a written assertion.
      : c.expect_output !== undefined && !full.includes(c.expect_output)
        ? fail(`output contains "${c.expect_output}"`, 'substring not found', log)
        : pass(`exit ${r.code}`, log)

  // `full` never reaches result.json — it goes to commands.log, so the bundle holds
  // everything the command said, not just the part that fitted.
  result.full = full
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
  let res, text
  try {
    res = await fetch(url, {
      ...init,
      redirect: follow ? 'follow' : 'manual',
      signal: AbortSignal.timeout((c.timeout ?? 30) * 1000),
    })
    text = await res.text()
  } catch (e) {
    // Node's fetch reports every connection problem as the same "fetch failed" and puts the
    // real reason in `cause`. Refused, DNS failure and TLS error all read identically without
    // it, and that reason is the whole diagnosis.
    return fail(`${method} ${url} responds`, `request failed: ${describeFetchError(e)}`)
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
    parts.push(w.status !== undefined ? `status ${w.status}` : 'a non-error status')
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

const RUNNERS = { run: runShell, http: runHttp, file: runFile, env: runEnv, browser: runBrowser }

const responds = async url => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) })
    return true
  } catch {
    return false
  }
}

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
  return out.length ? out : undefined
}

async function boot(serve) {
  const url = serve.ready_url ?? serve.url
  if (!url) throw new Error('serve needs a ready_url')
  const timeout = serve.timeout ?? 60

  // If the port already answers, nothing proof observes afterwards can be attributed to
  // the process it starts. A server that fails to bind then looks exactly like one that
  // booted, and every check runs against whatever was already there.
  const wasUp = await responds(url)
  if (serve.reuse_existing !== true && wasUp) {
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

    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) })
      // resolves once stdio has closed, so callers can wait for the last log lines
      return { proc: p, url, reused: wasUp, detached, log, closed }
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }

  if (detached) {
    throw Object.assign(
      new Error(`\`${serve.run}\` exited 0 without anything answering at ${url} within ${timeout}s`
        + ' — if it starts the app in the background, check the port; if it is meant to stay in the'
        + ' foreground, it stopped before proof could reach it'),
      { proc: p, log: log() },
    )
  }
  throw Object.assign(new Error(`not ready at ${url} within ${timeout}s`), { proc: p, log: log() })
}

/** The app's own log gate, evaluated only once its output has finished arriving. */
function logCheck(serve, log, evidence, detached) {
  if (!serve.log_must_not_match) return null

  // A launcher that detached took the app's output with it: what proof captured is the
  // launcher's, which is usually empty. Scanning that and reporting "no matching log lines"
  // passed a gate the user wrote precisely to catch what was in the log it never saw.
  if (detached) {
    return {
      name: SERVE_CHECK_NAMES[2],
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
    name: SERVE_CHECK_NAMES[2],
    kind: 'serve',
    asserted: `no runtime log line matches ${JSON.stringify(serve.log_must_not_match)}`,
    ...(hit
      ? fail(`no runtime log line matching /${serve.log_must_not_match}/`, hit.trim(), tail(log))
      : pass('no matching log lines')),
    evidence,
    ms: 0,
  }
}

async function livenessCheck(serve, server, evidence) {
  const log = server.log()
  const out = []

  // `run` is usually a shell wrapper that outlives the app it spawned, so its exit
  // code alone is not liveness. Healthy means the app still answers.
  const url = serve.ready_url ?? serve.url
  let reachable = false
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) })
    reachable = true
  } catch {}

  // Health is "still answering". The launcher's exit code is a diagnostic detail, not
  // the verdict — `npm run dev` style wrappers exit with 0 even when the app crashed.
  const exitCode = server.proc.exitCode
  out.push({
    name: SERVE_CHECK_NAMES[1],
    kind: 'serve',
    asserted: 'the app is still responding when the checks finish',
    ...(reachable
      ? pass('still responding at end of run')
      : fail(
          'app still responding at end of run',
          `no longer responding at ${url}${exitCode !== null ? `; the launcher ${describeExit(exitCode, 'exited')}` : ''}`,
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

export async function check({ json = false, specPath, only } = {}) {
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
  const selected = only
    ? spec.checks.filter(c => String(c.name ?? '').toLowerCase().includes(only.toLowerCase()))
    : spec.checks
  if (only && !selected.length) {
    throw Object.assign(new Error(`no check matches "${only}" — have: ${spec.checks.map(c => c.name ?? '(unnamed)').join(', ')}`), { code: 'ENOMATCH' })
  }
  const partial = selected.length !== spec.checks.length

  // Read before this run is recorded, so the baseline is the run before it.
  const before = previousResult(specPath ?? SPEC_PATH)
  const previousRun = before?.id ?? null
  // Keyed with what each check asserted, not just its status. A check edited between runs
  // keeps its name, and "passed in run 0001, fails now" then reads as a regression in the
  // code when nothing about the code moved — the assertion did.
  const previously = new Map((before?.result.results ?? [])
    .filter(r => r && typeof r.name === 'string')
    .map(r => [r.name, { status: r.status, asserted: r.asserted ?? null }]))

  const runDir = nextRunDir()
  const results = []
  let server = null

  // Captured BEFORE the checks, so the bundle describes the tree that was actually
  // verified rather than whatever it looks like once they finish.
  const git = gitContext()
  const treeBefore = fingerprint()

  const serveLogPath = join(runDir, 'serve.log')
  const writeServeLog = text => { writeFileSync(serveLogPath, text ?? ''); return [serveLogPath] }
  let tornDown = false

  // A full run honours the contract as written: `app boots`, `app still running` and the log
  // gate are checks in their own right, whatever verbs the rest uses. A *subset* skips the
  // server when nothing selected needs it — `--only "unit tests"` booted the dev server
  // anyway, and a server that would not start failed the run before the selected check ever
  // ran, blocking someone iterating on one unit test for an unrelated reason.
  const needsApp = !only || selected.some(c => 'http' in c || 'browser' in c)

  try {
    if (spec.serve && needsApp) {
      const t0 = Date.now()
      try {
        server = await boot(spec.serve)
        results.push({
          name: SERVE_CHECK_NAMES[0],
          kind: 'serve',
          asserted: `the app becomes ready at ${spec.serve.ready_url ?? spec.serve.url}`,
          ...pass(`ready at ${server.url}`),
          warnings: serveWarnings(server, spec.serve),
          ms: Date.now() - t0,
        })
      } catch (e) {
        if (e.proc) { kill(e.proc); untrack(e.proc) }
        results.push({
          name: SERVE_CHECK_NAMES[0],
          kind: 'serve',
          asserted: `the app becomes ready at ${spec.serve.ready_url ?? spec.serve.url}`,
          ...fail('app becomes ready', e.message, tail(e.log ?? '')),
          evidence: writeServeLog(e.log),
          ms: Date.now() - t0,
        })
      }
    }

    // ponytail: boot failure short-circuits — every downstream check would fail for the same reason.
    if (!results.some(r => r.status === 'failed')) {
      // one session for the run, shared by the http checks in the order they are written
      const ctx = { baseUrl: spec.serve?.ready_url ?? spec.serve?.url, runDir, cookies: new Map() }
      for (const [i, c] of selected.entries()) {
        const kind = Object.keys(RUNNERS).find(k => k in c)
        if (!kind) throw new Error(`check "${c.name ?? JSON.stringify(c)}" has no known verb (${Object.keys(RUNNERS).join('|')})`)
        const t0 = Date.now()
        // A crashing runner fails its own check; it must not discard the evidence
        // every earlier check already produced. Only pre-run errors (bad spec,
        // missing spec) abort the whole run.
        let r
        try {
          r = await RUNNERS[kind](c, ctx)
        } catch (e) {
          r = fail(`${kind} check runs`, `check crashed: ${crashReason(e)}`)
        }
        // index-suffixed so unnamed checks cannot collide in the results map either
        results.push({ name: c.name ?? `${kind} check ${i + 1}`, kind, asserted: describe(c, kind), ...r, ms: Date.now() - t0 })
      }
    }

    // Runtime verification: a dev server that died halfway through explains every
    // connection error after it, and nothing else in the run would say so.
    if (server) {
      // Settle before judging anything. The window exists so late output lands, but it is
      // also the window in which a crash caused by the last check happens: probing liveness
      // first reported "still running" for an app the run had just killed.
      await new Promise(res => setTimeout(res, SETTLE_MS))

      // Now ask whether it survived — while it is still ours to ask.
      results.push(...await livenessCheck(spec.serve, server, [serveLogPath]))

      // Then stop it and wait for its output to finish arriving. Reading the log while the
      // child is still writing loses the last lines, which are exactly the ones that explain
      // a failure.
      kill(server.proc)
      untrack(server.proc)
      tornDown = true
      await Promise.race([server.closed, new Promise(res => setTimeout(res, 2000).unref?.())])

      const log = server.log()
      writeServeLog(log)
      const gate = logCheck(spec.serve, log, [serveLogPath], server.detached)
      if (gate) results.push(gate)
    }
  } finally {
    if (server && !tornDown) { kill(server.proc); untrack(server.proc) }
  }

  // Everything the contract lists before the last selected check, that this run skipped.
  const lastSelected = spec.checks.lastIndexOf(selected[selected.length - 1])
  const skippedBefore = spec.checks
    .slice(0, lastSelected)
    .filter(c => !selected.includes(c))
    .map((c, i) => c.name ?? `check ${i + 1}`)

  const serveSkipped = Boolean(spec.serve) && !needsApp
  const failures = results.filter(r => r.status === 'failed')

  // The product's whole premise: a green test suite is not the same as a satisfied
  // requirement. A contract made only of `run:` commands proves exactly the thing
  // the tool exists to distrust, so say so — on a pass, where the false confidence is.
  const acceptance = spec.checks.some(c => 'http' in c || 'browser' in c || 'env' in c)

  // A status code says the app answered, not what it answered with. `infer` can only
  // generate `expect: {status: 200}` — it cannot know the requirement — so a contract built
  // from generated checks passes on a 200 carrying exactly the wrong body.
  const responseChecks = spec.checks.filter(c => 'http' in c || 'browser' in c)
  const assertsContent = c =>
    (c.http && (c.http.expect?.body_contains !== undefined || c.http.expect?.json !== undefined))
    || (c.browser && (c.browser.flow ?? []).some(s => s?.expect_text !== undefined || s?.expect_request !== undefined))

  // Three different gaps, narrowing. Saying "nothing exercises the running application"
  // when `app boots` just passed is false: the app was started and answered. What is
  // missing there is narrower, and naming it precisely is the difference between advice
  // someone acts on and a caveat they learn to skip.
  const started = Boolean(spec.serve) && !serveSkipped
  // Not on a subset run. Every advisory is a statement about what the whole contract proves,
  // and a subset did not run the whole contract — the INCOMPLETE verdict already says the
  // run makes no completion claim. Reporting "no http check asserts content" for checks that
  // were never selected is a caveat about something the reader did not ask for.
  const advisory = partial ? null
    : failures.length ? null
    : !acceptance && started ? ADVISORY.liveness_only
      : !acceptance ? ADVISORY.no_runtime
        : responseChecks.length && !responseChecks.some(assertsContent) ? ADVISORY.status_only
          : null
  const assertedBy = new Map(results.map(r => [r.name, r.asserted ?? null]))

  const result = {
    status: failures.length ? 'failed' : partial ? 'partial' : 'passed',
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
    // Said out loud: the absence of `app boots` from a subset run is a decision, not a gap.
    serve_skipped: serveSkipped,
    advisory,
    warnings: [
      // `changed` says this too, but the DONE verdict is the thing CI and agents act on, and
      // a verdict is a claim about a contract. If this diff rewrote the contract, the claim
      // is against expectations the same diff set — which the verdict alone cannot show.
      ...contractWarning(specPath),
      // The same fact about the other half of the verification. `changed` reports both; the
      // verdict is what gets acted on, and "the suite passed" means less when this diff is
      // also what the suite now says.
      ...testsWarning(),
      ...results.flatMap(r => (r.warnings ?? []).map(w => `${r.name}: ${w}`)),
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
    ran_checks: results.filter(r => r.kind !== 'serve').length,
    checks: Object.fromEntries(results.map(r => [r.name, r.status])),
    // `full` is stripped here: result.json stays readable, commands.log holds everything
    results: results.map(({ full, ...rest }) => rest),
    // Always all five keys. JSON.stringify drops undefined, so a failure with no output
    // used to lose the field entirely — and an agent reading failure.output would crash
    // on exactly the failures that carry the least context.
    failures: failures.map(({ name, expected, observed, output, evidence }) => ({
      check: name,
      expected: expected ?? null,
      observed: observed ?? null,
      output: output ?? null,
      evidence: evidence ?? null,
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
  partial: 'INCOMPLETE — selected checks passed; run `proof check` for a completion verdict',
}

function printHuman(r) {
  const names = r.results.map(x => truncateToWidth(x.name, NAME_COLUMN_MAX))
  const w = columnWidth(r.results.map(x => x.name), NAME_COLUMN_MAX)
  console.log('\nPROOF')
  if (r.goal) console.log(`\nRequirement:\n${block(r.goal, '  ')}`)
  console.log('\nCHECKS')
  r.results.forEach((c, i) => console.log(`  ${padTo(names[i], w + 2)}${c.status === 'passed' ? 'PASS' : 'FAIL'}`))
  for (const f of r.failures) {
    console.log(`\nFAILURE\n  Check:\n    ${f.check}`)
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
    console.log(`\nSubset run: --only "${r.only}" selected ${r.selected_checks} of ${r.contract_checks} check(s).${skipped}`)
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
  console.log(`\nEvidence:\n  ${join(r.run, 'result.json')}\n  ${join(r.run, 'commands.log')}`)
  // A tally, because at any size past a handful nobody counts the rows — and past a
  // screenful the list has scrolled away by the time the verdict appears.
  const ran = r.results.length
  const failed = r.results.filter(c => c.status === 'failed').length
  const tally = failed ? `${ran - failed} passed, ${failed} failed` : `${ran} passed`

  // On its own line: the INCOMPLETE verdict already carries a sentence, and appending to it
  // produced a run-on with two em-dashes.
  console.log(`\nVERDICT\n  ${VERDICT[r.status]}\n  ${tally}\n`)
}
