import { mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const STEP_VERBS = ['visit', 'fill', 'click', 'expect_text', 'expect_request', 'expect_url', 'wait']

export function normalizeFlow(spec) {
  const steps = []
  if (spec.visit) steps.push({ visit: spec.visit })
  for (const s of spec.flow ?? []) {
    if (!s || typeof s !== 'object') throw new Error(`browser step must be a mapping: ${JSON.stringify(s)}`)
    if (!STEP_VERBS.some(v => v in s)) throw new Error(`browser step has no known verb (${STEP_VERBS.join('|')}): ${JSON.stringify(s)}`)
    steps.push(s)
  }
  if (!steps.length) throw new Error('browser check needs a visit or a flow')
  return steps
}

export const describeStep = s =>
  'visit' in s ? `Visit ${s.visit}`
    : 'fill' in s ? `Fill ${Object.keys(s.fill).join(', ')}`
      : 'click' in s ? `Click "${s.click}"`
        : 'expect_text' in s ? `Expect text "${s.expect_text}"`
          : 'expect_request' in s ? `Expect ${(s.expect_request.method ?? 'ANY').toUpperCase()} ${s.expect_request.path ?? s.expect_request.path_matches ?? s.expect_request.url}`
            : 'expect_url' in s ? `Expect URL ${s.expect_url}`
              : `Wait ${s.wait}ms`

/**
 * Exact, never substring: `/dashboard` must not be satisfied by `/dashboard-error`.
 * A path compares by pathname (plus search when the contract gives one); an absolute
 * URL compares whole.
 */
export function urlMatches(actual, expected) {
  let a
  try { a = new URL(actual) } catch { return actual === expected }
  if (ABSOLUTE_URL.test(expected)) return a.href === expected
  return expected.includes('?') ? a.pathname + a.search === expected : a.pathname === expected
}

export const ABSOLUTE_URL = /^https?:\/\//i

export function matchRequest(req, want) {
  if (want.method && req.method.toUpperCase() !== want.method.toUpperCase()) return false
  if (want.url !== undefined && !req.url.includes(want.url)) return false

  let pathname
  try { pathname = new URL(req.url).pathname } catch { pathname = req.url }

  // Exact, not substring: `/api/user` must not be satisfied by a call to
  // `/api/user-preferences`. Use `path_matches` for dynamic segments.
  if (want.path !== undefined && pathname !== want.path) return false
  if (want.path_matches !== undefined && !new RegExp(want.path_matches).test(pathname)) return false
  return true
}

// ponytail: ordered guesses, first match wins. A spec can always pass an explicit
// CSS selector as the key instead ({"#email": "a@b.c"}).
export function fieldSelectors(field) {
  if (/^[#.[]/.test(field)) return [field] // already a selector
  const q = field.replace(/"/g, '\\"')
  return [
    `[name="${q}"]`,
    `[data-testid="${q}"]`,
    `#${q.replace(/[^\w-]/g, '\\$&')}`,
    `[placeholder*="${q}" i]`,
    `[aria-label*="${q}" i]`,
    `input[type="${q}"]`,
  ]
}

const firstLine = s => String(s).split('\n')[0].trim()
const MAX_SLUG = 60

// Grace after the last step so a late console error still counts, matching the same
// window `check` gives a server's log before reading it.
const SETTLE_MS = 300

// A page in an error loop produced 20,000 console entries, a 2.5 MB evidence bundle and a
// 2.8 MB result.json — the payload `report --json` hands to an agent. Keep both ends: the
// first errors explain the failure, the last show where it ended up.
export const CONSOLE_CAP = 100
export const REQUEST_CAP = 1000

/**
 * Both ends of a list, for storage only. Distinct from boundedList: the live request array
 * must stay intact because `expect_request` slices it by index, so this bounds what is
 * written out rather than what is kept.
 */
export const boundEnds = (items, cap) => {
  if (items.length <= cap) return items
  const half = Math.floor(cap / 2)
  return [...items.slice(0, half), ...items.slice(items.length - half)]
}

export function boundedList(cap) {
  const half = Math.max(1, Math.floor(cap / 2))
  const head = []
  let tail = []
  let total = 0

  return {
    push(item) {
      total++
      if (head.length < half) head.push(item)
      else {
        tail.push(item)
        if (tail.length > half) tail.shift()
      }
    },
    get total() { return total },
    get dropped() { return Math.max(0, total - head.length - tail.length) },
    items() { return [...head, ...tail] },
  }
}

/**
 * Filename-safe identity for a check name. Unicode letters and digits survive: stripping
 * them collapsed every non-Latin name to one value, and since duplicate detection compares
 * slugs, two perfectly distinct names were rejected as duplicates of each other.
 */
export const slug = s => {
  const text = String(s)
  const base = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  const short = createHash('sha1').update(text).digest('hex').slice(0, 8)

  // nothing sluggable (emoji, punctuation) or truncated: keep names distinct either way
  if (!base) return `check-${short}`
  return base.length > MAX_SLUG ? `${base.slice(0, MAX_SLUG)}-${short}` : base
}

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const fieldCandidates = (page, name) => {
  const out = fieldSelectors(name).map(sel => [sel, page.locator(sel)])
  if (!/^[#.[]/.test(name)) out.push([`label ~ /${name}/i`, page.getByLabel(new RegExp(escapeRegex(name), 'i'))])
  return out
}

const clickCandidates = (page, text) => [
  ['button role', page.getByRole('button', { name: text })],
  ['link role', page.getByRole('link', { name: text })],
  ['submit input', page.locator(`[type="submit"][value="${text.replace(/"/g, '\\"')}"]`)],
  ['text', page.getByText(text)],
]

// Ordered fallback, NOT a union. `a.or(b).first()` merges the candidate sets and then
// picks by DOM order, so a newsletter signup box outranks [name="email"], and a paragraph
// mentioning "Send reset link" outranks the actual button — which fires no request and
// then reads exactly like the bug this check exists to catch.
// Wait for any candidate to exist, then take the highest-priority one that does.
async function resolve(candidates, timeout, what) {
  const union = candidates.map(([, loc]) => loc).reduce((a, b) => a.or(b))
  try {
    await union.first().waitFor({ state: 'attached', timeout })
  } catch {
    // `diagnosed`: this message explains the failure better than a budget message would
    throw Object.assign(
      new Error(`no element found for ${what} — tried ${candidates.map(([how]) => how).join(', ')}`),
      { diagnosed: true },
    )
  }
  for (const [how, loc] of candidates) {
    if (await loc.count()) return { loc: loc.first(), how }
  }
  return { loc: union.first(), how: 'first attached' }
}

/**
 * Only "it is not there" earns the install advice. A corrupt install or a native module built
 * for another Node version also throws on import, and telling someone to `npm i` a package
 * they already have sends them the wrong way with the actual reason discarded.
 *
 * Separated from the import so it can be tested without breaking the installation.
 */
export const playwrightImportError = e =>
  (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND'
    ? new Error('browser checks need playwright — run `npm i -D playwright && npx playwright install chromium`')
    : new Error(`playwright is installed but could not be loaded: ${e?.message ?? e}`))

/**
 * `npm i -D playwright` installs the package; the browser binaries are a separate download,
 * so having one without the other is the ordinary state of a fresh checkout. Playwright says
 * so in a drawn box several lines tall — which arrives here as a crash reason, gets wrapped,
 * and was cut off one line above the command it tells you to run. One line instead.
 */
export const browserLaunchError = e => {
  const message = String(e?.message ?? e)

  // Two different walls behind two near-identical boxes. Telling someone to download
  // browsers they already have, when what is missing is libnss3, sends them in a circle.
  if (/install-deps|missing dependencies/i.test(message)) {
    return new Error('the browser is installed but the system libraries it needs are not —'
      + ' run `sudo npx playwright install-deps` (common in containers and CI images)')
  }
  if (/Executable doesn't exist|playwright install/i.test(message)) {
    return new Error('browser checks need the browser binaries — run `npx playwright install chromium`'
      + ' (the playwright package is installed, its browsers are not)')
  }
  return e
}

// `load` is injectable so the not-installed path can be exercised without uninstalling
// playwright — a mutation deleting the translation left every test passing.
export async function importPlaywright(load = () => import('playwright')) {
  try {
    return await load()
  } catch (e) {
    throw playwrightImportError(e)
  }
}

export async function runBrowser(c, ctx) {
  const spec = c.browser
  const steps = normalizeFlow(spec)
  const { chromium } = await importPlaywright()

  // Same rule as the http verb: never guess a host.
  const base = spec.base_url ?? ctx.baseUrl
  const absolute = u => /^https?:\/\//i.test(u)
  if (!base && steps.some(s => 'visit' in s && !absolute(s.visit))) {
    return {
      status: 'failed',
      expected: 'a base URL to resolve visits against',
      observed: 'no serve block, no browser.base_url, and the visit is relative',
    }
  }
  // `timeout` is the budget for the whole check, matching what it means on `run:`.
  // Per-step it would be unbounded in aggregate: 20 steps at 15s each is five minutes.
  const budgetSec = c.timeout ?? 60
  const deadline = Date.now() + budgetSec * 1000
  const name = slug(c.name ?? 'browser')
  const requests = []
  const consoleErrors = boundedList(CONSOLE_CAP)
  const resolved = [] // which selector actually matched — otherwise a mis-targeted fill is invisible
  const warnings = [] // observed but not gated: redirects, console noise

  let browser
  try {
    browser = await chromium.launch()
  } catch (e) { throw browserLaunchError(e) }
  const page = await (await browser.newContext({ baseURL: base })).newPage()

  // Correlate each request with what came back. Without this, `expect_request` proves only
  // that the browser tried — a 500 looks identical to a success.
  const byRequest = new Map()
  page.on('request', r => {
    const record = { method: r.method(), url: r.url(), status: null, failed: false }
    requests.push(record)
    byRequest.set(r, record)
  })
  page.on('response', res => {
    const record = byRequest.get(res.request())
    if (record) record.status = res.status()
  })
  page.on('requestfailed', r => {
    const record = byRequest.get(r)
    if (record) {
      record.failed = true
      record.failure = r.failure()?.errorText ?? 'request failed'
    }
  })
  page.on('console', m => {
    if (m.type() !== 'error') return
    const l = m.location()
    // CDP counts lines from 0; editors, stack traces and humans count from 1. Reporting
    // the raw number points at a line that is not the one that logged.
    const line = Number.isInteger(l?.lineNumber) ? l.lineNumber + 1 : null
    consoleErrors.push({ text: m.text(), at: l?.url ? `${l.url}:${line ?? '?'}` : null })
  })
  // Keep the whole stack in the bundle. The first frame is often framework internals, and
  // the app's own frame — the one worth reading — sits further down.
  page.on('pageerror', e => consoleErrors.push({
    text: e.message,
    at: firstLine(e.stack?.split('\n')[1] ?? '').replace(/^at\s+/, '') || null,
    stack: e.stack ?? null,
  }))

  let failure = null
  let mark = 0
  let shot = null

  try {
    for (const step of steps) {
      const desc = describeStep(step)
      // Playwright reads timeout 0 as "wait forever", so an exhausted budget must stop here.
      const stepStart = Date.now()
      const timeout = deadline - stepStart
      if (timeout <= 0) {
        failure = {
          step: desc,
          expected: `the flow completes within ${budgetSec}s`,
          observed: `timeout budget exhausted before this step (set \`timeout\` higher on this check)`,
        }
        break
      }
      try {
        if ('visit' in step) {
          mark = requests.length
          const res = await page.goto(step.visit, { timeout, waitUntil: 'domcontentloaded' })
          // Otherwise a 404 route surfaces as a mystery selector timeout on the next step.
          if (res && res.status() >= 400) {
            failure = { step: desc, expected: `${step.visit} loads`, observed: `status ${res.status()}` }
            break
          }
          // goto follows redirects, so a page that bounced to a login screen looks identical
          // to one that loaded. Same rule as the http verb: a pass, but never a silent one.
          if (!urlMatches(page.url(), step.visit)) {
            warnings.push(`${step.visit} did not load directly — it redirected to ${page.url()}`)
          }
        }
        else if ('fill' in step) {
          mark = requests.length
          for (const [k, v] of Object.entries(step.fill)) {
            const { loc, how } = await resolve(fieldCandidates(page, k), timeout, `field "${k}"`)
            resolved.push({ step: desc, target: k, matched_by: how })
            await loc.fill(String(v), { timeout })
          }
        } else if ('click' in step) {
          mark = requests.length
          const { loc, how } = await resolve(clickCandidates(page, step.click), timeout, `clickable "${step.click}"`)
          resolved.push({ step: desc, target: step.click, matched_by: how })
          await loc.click({ timeout })
        }
        else if ('wait' in step) await page.waitForTimeout(step.wait)
        // filter first: `.first()` alone picks the first match in DOM order, which is
        // often a hidden duplicate (responsive markup, templates) and would time out
        // while the real, visible copy sat right there.
        else if ('expect_text' in step) {
          await page.getByText(step.expect_text).filter({ visible: true }).first().waitFor({ state: 'visible', timeout })
        }
        else if ('expect_url' in step) {
          try {
            await page.waitForURL(u => urlMatches(u.toString(), step.expect_url), { timeout })
          } catch {
            // naming where it actually is beats Playwright's generic navigation timeout
            throw Object.assign(new Error(`URL is ${page.url()}`), { diagnosed: true })
          }
        }
        else if ('expect_request' in step) {
          const want = step.expect_request
          const waitMs = Math.min(want.timeout_ms ?? 5000, timeout)
          const until = Date.now() + waitMs
          let hit
          do {
            hit = requests.slice(mark).find(r => matchRequest(r, want))
            if (!hit) await page.waitForTimeout(100)
          } while (!hit && Date.now() < until)
          if (!hit) {
            const seen = requests.slice(mark)
            failure = {
              step: desc,
              expected: desc.replace(/^Expect /, ''),
              observed: seen.length
                ? `no matching request in ${waitMs}ms — ${seen.length} other request(s): ${seen.slice(0, 5).map(r => `${r.method} ${r.url}`).join(', ')}`
                : `no matching request in ${waitMs}ms — no network request was generated`,
            }
            break
          }

          // The request fired; now let the response land so we can say what it was.
          const settleBy = Math.max(until, Date.now() + 1000)
          while (hit.status === null && !hit.failed && Date.now() < settleBy) await page.waitForTimeout(50)

          const outcome = hit.failed ? hit.failure : hit.status === null ? 'no response' : `status ${hit.status}`
          if (want.status !== undefined) {
            if (hit.status !== want.status) {
              failure = { step: desc, expected: `status ${want.status}`, observed: outcome }
              break
            }
          } else if (hit.failed || (hit.status !== null && hit.status >= 400)) {
            // A request that fired and then failed is not what "the button works" means.
            warnings.push(`${hit.method} ${new URL(hit.url).pathname} was sent but answered ${outcome}`
              + ' — add `status:` to expect_request to fail on this')
          }
        }
      } catch (e) {
        // A step usually consumes the last of the budget rather than starting past it.
        // Reporting Playwright's leftover-milliseconds timeout would name a number that
        // appears nowhere in the contract; name the budget instead.
        //
        // Measured against the step's own allotment, not the wall clock: Playwright can
        // throw a millisecond early, and `Date.now() >= deadline` then reads false and
        // leaks "Timeout 702ms exceeded" to the user.
        const usedItsWholeAllotment = Date.now() - stepStart >= timeout - 50
        failure = usedItsWholeAllotment && !e.diagnosed
          ? {
              step: desc,
              expected: `the flow completes within ${budgetSec}s`,
              observed: `timeout budget exhausted during this step (set \`timeout\` higher on this check)`,
            }
          : { step: desc, expected: desc, observed: firstLine(e.message) }
        break
      }
    }

    // Let late failures land before judging. A page that throws milliseconds after the
    // last assertion — the shape of an async error — was otherwise gated on evidence that
    // had not arrived yet, and then reported as a warning once it did.
    if (!failure && Date.now() < deadline) await page.waitForTimeout(Math.min(SETTLE_MS, deadline - Date.now()))

    if (!failure && spec.expect_no_console_errors && consoleErrors.total) {
      failure = {
        step: 'console',
        expected: 'no console errors',
        observed: `${consoleErrors.total} console error(s): ${consoleErrors.items().slice(0, 3).map(e => e.text).join('; ')}`,
      }
    }

    shot = join(ctx.runDir, 'screenshots', `${name}.png`)
    mkdirSync(join(ctx.runDir, 'screenshots'), { recursive: true })
    await page.screenshot({ path: shot, fullPage: true }).catch(() => { shot = null })
  } finally {
    await browser.close().catch(() => {})
  }

  // The live array must stay intact — expect_request slices it by index — so bound only
  // what is written out.
  const storedRequests = boundEnds(requests, REQUEST_CAP)

  const bundle = join(ctx.runDir, `browser-${name}.json`)
  writeFileSync(bundle, JSON.stringify({
    check: c.name ?? name,
    base,
    steps,
    resolved,
    failure,
    requests: storedRequests,
    requests_total: requests.length,
    requests_dropped: requests.length - storedRequests.length,
    consoleErrors: consoleErrors.items(),
    console_errors_total: consoleErrors.total,
    console_errors_dropped: consoleErrors.dropped,
    screenshot: shot,
  }, null, 2))

  const evidence = [bundle, shot].filter(Boolean)

  if (!failure) {
    // Observed but not gated. Staying silent about console errors we watched happen would
    // be reporting confidence instead of evidence; failing on them is opt-in, saying so is not.
    // Only when the gate is off. With it on, errors are a failure — telling someone to set
    // a flag they already set would be advice contradicting their own contract.
    if (consoleErrors.total && !spec.expect_no_console_errors) {
      warnings.push(`${consoleErrors.total} console error(s) logged — set \`expect_no_console_errors: true\` to fail on them`)
    }
    return {
      status: 'passed',
      observed: `${steps.length} step(s) ok`,
      evidence,
      consoleErrors: consoleErrors.items(),
      console_errors_total: consoleErrors.total,
      warnings: warnings.length ? warnings : undefined,
    }
  }

  // Console errors almost always explain the failure — surface them with it.
  const output = consoleErrors.total
    ? 'Browser console:\n' + consoleErrors.items().map(e => `  ${e.text}${e.at ? `\n    at ${e.at}` : ''}`).join('\n')
    : undefined

  return {
    status: 'failed',
    expected: failure.expected,
    observed: `${failure.step} → ${failure.observed}`,
    output,
    evidence,
    consoleErrors: consoleErrors.items(),
    console_errors_total: consoleErrors.total,
  }
}
