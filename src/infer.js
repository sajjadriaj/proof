import { readFileSync, existsSync } from 'node:fs'
import YAML from 'yaml'
import { changedFiles, noCommonHistory, SHALLOW } from './git.js'
import { walk, dependents, coverage, scanWarnings, resetScan, dependencyChanges, stripComments, stripPy, fileRoute, PKG } from './changed.js'
import { isTestFile } from './diff.js'
import { loadSpec, SPEC_PATH, PROOF_DIR, withSpecLock, writeFileAtomic } from './spec.js'
import { padTo, truncateToWidth, columnWidth, block } from './terminal.js'
import { PLACEHOLDER_RUN, placeholderChecks } from './validate.js'

// A REST path with parameter segments is easily a hundred characters, and padding every
// row to the longest one wraps the whole list.
const TITLE_COLUMN_MAX = 64

export { stripComments, stripPy, fileRoute } from './changed.js'
export { isTestFile } from './diff.js'

// A file proof could not read yields no routes and no env references — which is
// indistinguishable from a file that has none, unless it is recorded. `scanned` counted it
// anyway, so the header claimed the file had been scanned for gaps when it had not.
const unreadable = new Set()
const read = f => {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    // Only a file that is there but cannot be opened. The same helper probes optional
    // .env files, and listing every one a project does not have is noise, not a warning.
    if (existsSync(f)) unreadable.add(f)
    return ''
  }
}
const CODE = /\.[jt]sx?$|\.[cm][jt]s$|\.py$|\.go$/



// --- surface detectors -------------------------------------------------------
// ponytail: regex over source, not an AST. Each detector must be able to point at
// a file:line — a gap we cannot locate is a gap we should not report.

// `export async function POST(...)`, `export const POST = ...` — the app-router convention
// for declaring which methods a route answers.
const HANDLER_EXPORT = /export\s+(?:async\s+)?(?:function\s+|const\s+|let\s+|var\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g

const ROUTE_CALL = /\b(app|router|server|fastify|api)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi

// `app.use('/api/v2', router)` — the prefix everything on that router answers under. Without
// it `router.get('/users')` was reported as `/users`, and the generated check requested a
// path the app does not serve.
const MOUNT = /\b(?:app|server)\s*\.\s*use\s*\(\s*['"`](\/[^'"`]*)['"`]\s*,\s*([A-Za-z_$][\w$]*)/g

/**
 * Receivers whose paths may be mounted under a prefix elsewhere. Only `router`: `api` is
 * just as often an http client (`api.post('/api/login')`), and a note about mounting on a
 * client call is noise attached to the wrong thing.
 */
const MOUNTABLE = new Set(['router'])

const lineOf = (src, index) => src.slice(0, index).split('\n').length

// --- python & go -------------------------------------------------------------
// Same contract as the JS detectors: regex over comment-stripped source, every hit
// locatable as file:line. Go has no import graph yet — `changed` says so — but a route or
// an env read is the same shape in any language, and "proof cannot look here" was the
// answer for the two ecosystems `init` already scaffolds serve commands for.
//
// `stripPy` lives beside the Python import scan in changed.js, next to the JS one it mirrors.

// `@app.route("/x", methods=["POST"])`, and the FastAPI/Flask 2 shorthand `@router.get("/x")`.
const PY_ROUTE = /@\s*([A-Za-z_]\w*)\s*\.\s*(route|get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]([^)]*)/g

function pyRoutes(file) {
  const src = stripPy(read(file))
  const out = []
  for (const m of src.matchAll(PY_ROUTE)) {
    if (!m[3].startsWith('/')) continue
    const at = `${file}:${lineOf(src, m.index)}`
    if (m[2] === 'route') {
      // methods=["POST", "GET"] on the same call; Flask defaults to GET without it
      const listed = [...(m[4] ?? '').matchAll(/['"](GET|POST|PUT|PATCH|DELETE)['"]/gi)].map(x => x[1].toUpperCase())
      for (const method of listed.length ? [...new Set(listed)] : ['GET']) out.push({ method, path: m[3], at })
    } else {
      out.push({ method: m[2].toUpperCase(), path: m[3], at })
    }
  }
  return out
}

// `http.HandleFunc("/x", h)` and the chi/gin/echo method receivers. Go 1.22 patterns put
// the method inside the string: HandleFunc("POST /orders", h).
const GO_ROUTE = /\.\s*(HandleFunc|Handle|Get|Post|Put|Patch|Delete|GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"/g

function goRoutes(file) {
  const src = stripComments(read(file))   // Go comments are the C family stripComments knows
  const out = []
  for (const m of src.matchAll(GO_ROUTE)) {
    const at = `${file}:${lineOf(src, m.index)}`
    let method = m[1].toUpperCase()
    let path = m[2]
    if (method === 'HANDLEFUNC' || method === 'HANDLE') {
      const pattern = path.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/)
      if (pattern) { method = pattern[1]; path = pattern[2] }
      else method = 'GET'                  // net/http registers every method; GET stands for the route
    }
    if (!path.startsWith('/')) continue
    out.push({ method, path, at })
  }
  return out
}

const PY_ENV = /os\.(?:environ\s*(?:\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]|\.get\(\s*['"]([A-Z][A-Z0-9_]{2,})['"])|getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"])/g
const GO_ENV = /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]{2,})"/g


export function routesIn(file) {
  if (file.endsWith('.py')) return pyRoutes(file)
  if (file.endsWith('.go')) return goRoutes(file)
  const out = []
  const src = stripComments(read(file))
  const path = fileRoute(file)

  if (path) {
    // An app-router file declares its methods by exporting a handler per method. Assuming
    // GET generated `http: {method: GET, path: /api/checkout, expect: {status: 200}}` for a
    // route that only exports POST — a check that can never pass, offered as the fix.
    const handlers = [...src.matchAll(HANDLER_EXPORT)]
    if (handlers.length) {
      const seen = new Set()
      for (const m of handlers) {
        const method = m[1].toUpperCase()
        if (seen.has(method)) continue
        seen.add(method)
        out.push({ method, path, at: `${file}:${lineOf(src, m.index)}` })
      }
    } else {
      // pages/api exports one default handler for every method; GET stands for the route.
      out.push({ method: 'GET', path, at: `${file}:1` })
    }
  }

  const mounts = new Map([...src.matchAll(MOUNT)].map(m => [m[2], m[1].replace(/\/$/, '')]))

  for (const m of src.matchAll(ROUTE_CALL)) {
    // Routes are paths. Without this, Express's settings getter `app.get('port')` and
    // client calls like `api.get('users')` both register as routes.
    if (!m[3].startsWith('/')) continue

    const receiver = m[1].toLowerCase()
    const prefix = mounts.get(m[1]) ?? ''
    const mountable = MOUNTABLE.has(receiver) && !prefix

    out.push({
      method: m[2].toUpperCase(),
      path: `${prefix}${m[3]}`.replace(/\/{2,}/g, '/'),
      at: `${file}:${lineOf(src, m.index)}`,
      // Reported so the gap can say so: the route is real, the prefix is not knowable here.
      ...(mountable ? { mountable: true } : {}),
    })
  }
  return out
}

// `[id]`, `:id` and an unresolved `${id}` all mean the URL cannot be requested as written.
export const isDynamicPath = p => /[:[{<]/.test(p)

const ENV_REF = /(?:process\.env|import\.meta\.env)(?:\.([A-Z][A-Z0-9_]{2,})|\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\])/g

export function envRefsIn(file) {
  if (file.endsWith('.py')) {
    const src = stripPy(read(file))
    return [...src.matchAll(PY_ENV)].map(m => ({ name: m[1] ?? m[2] ?? m[3], at: `${file}:${lineOf(src, m.index)}` }))
  }
  if (file.endsWith('.go')) {
    const src = stripComments(read(file))
    return [...src.matchAll(GO_ENV)].map(m => ({ name: m[1], at: `${file}:${lineOf(src, m.index)}` }))
  }
  const src = stripComments(read(file))
  return [...src.matchAll(ENV_REF)].map(m => ({ name: m[1] ?? m[2], at: `${file}:${lineOf(src, m.index)}` }))
}

// Injected by the platform or the runtime, not by your deployment config. Flagging these
// on every repository is noise that buries the variables that actually go missing.
const PLATFORM_ENV = new Set([
  'NODE_ENV', 'PORT', 'HOST', 'CI', 'HOME', 'PATH', 'PWD', 'USER', 'SHELL', 'LANG', 'TZ', 'TMPDIR', 'HOSTNAME',
])
const PLATFORM_ENV_PREFIX = /^(npm_|VERCEL_|NETLIFY_|GITHUB_|RENDER_|FLY_|AWS_LAMBDA_)/

export const isPlatformEnv = name => PLATFORM_ENV.has(name) || PLATFORM_ENV_PREFIX.test(name)

const ENV_FILES = ['.env.example', '.env.sample', '.env.template', '.env']
export function declaredEnv() {
  const names = new Set()
  for (const f of ENV_FILES) {
    for (const line of read(f).split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/)
      if (m) names.add(m[1])
    }
  }
  return names
}

const MIGRATORS = [
  ['prisma', 'npx prisma migrate deploy'],
  ['drizzle-kit', 'npx drizzle-kit migrate'],
  ['knex', 'npx knex migrate:latest'],
  ['sequelize-cli', 'npx sequelize-cli db:migrate'],
  ['typeorm', 'npx typeorm migration:run'],
]

export function migrateCommand() {
  if (!existsSync('package.json')) return null
  let pkg
  try { pkg = JSON.parse(read('package.json')) } catch { return null }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  return MIGRATORS.find(([d]) => d in deps)?.[1] ?? null
}

const isMigration = f => /(?:^|\/)migrations?\//.test(f)

// --- gap assembly ------------------------------------------------------------

const RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 }

/** Every (method, path) an existing contract already exercises. */
export function assertedRoutes(checks) {
  const out = []
  for (const c of checks) {
    if (c?.http) {
      const method = (c.http.method ?? 'GET').toUpperCase()
      if (c.http.path) out.push({ method, path: c.http.path })
      if (c.http.url) { try { out.push({ method, path: new URL(c.http.url).pathname }) } catch {} }
    }
    for (const s of c?.browser?.flow ?? []) {
      const r = s?.expect_request
      if (r?.path) out.push({ method: (r.method ?? 'GET').toUpperCase(), path: r.path })
    }
  }
  return out
}

export const assertedEnv = checks =>
  new Set(checks.map(c => (typeof c?.env === 'string' ? c.env : c?.env?.name)).filter(Boolean))

export const assertsMigration = checks =>
  checks.some(c => typeof c?.run === 'string' && /migrat/i.test(c.run))

export function findGaps(files, existingChecks = [], { reportUncovered = true } = {}) {
  // Compare against the actual fields of existing checks. Substring-searching the
  // stringified contract meant `/api/users` swallowed the gap for `/api/user`, and
  // a check merely mentioning STRIPE_KEY_ID swallowed the one for STRIPE_KEY.
  const routes = assertedRoutes(existingChecks)
  const envs = assertedEnv(existingChecks)
  const gaps = []
  const push = g => gaps.push(g)

  // Application code only: a route in a fixture is a scenario, not a surface to verify.
  const code = files.filter(f => CODE.test(f) && !isTestFile(f))

  for (const f of code) {
    for (const r of routesIn(f)) {
      if (routes.some(a => a.method === r.method && a.path === r.path)) continue
      const dynamic = isDynamicPath(r.path)
      const notes = [
        dynamic ? 'dynamic segment — replace with a real value' : null,
        // The route is real; where the app mounts it is decided in a file this scan has
        // not read. Generating the bare path silently would produce a check that 404s.
        r.mountable ? 'declared on a router — confirm the prefix the app mounts it under' : null,
      ].filter(Boolean)

      push({
        severity: 'HIGH',
        title: `${r.method} ${r.path} is reachable`,
        at: r.at,
        note: notes.length ? notes.join('; ') : null,
        check: { name: `${r.method.toLowerCase()} ${r.path}`, http: { method: r.method, path: r.path, expect: { status: 200 } } },
      })
    }
  }

  const declared = declaredEnv()
  const envSeen = new Set()
  for (const f of code) {
    for (const e of envRefsIn(f)) {
      if (envSeen.has(e.name) || isPlatformEnv(e.name) || envs.has(e.name)) continue
      envSeen.add(e.name)
      push({
        severity: declared.has(e.name) ? 'MEDIUM' : 'HIGH',
        title: `env ${e.name} is set at run time`,
        at: e.at,
        note: declared.has(e.name) ? null : `not declared in ${ENV_FILES.filter(existsSync).join(', ') || 'any .env file'}`,
        check: { name: `env ${e.name}`, env: e.name },
      })
    }
  }

  if (files.some(isMigration) && !assertsMigration(existingChecks)) {
    const cmd = migrateCommand()
    push({
      severity: 'HIGH',
      title: 'database migrations apply cleanly',
      at: files.find(isMigration),
      note: cmd ? null : 'no migrator detected — replace the placeholder command',
      check: { name: 'migrations', run: cmd ?? [...PLACEHOLDER_RUN.keys()][1] },
    })
  }

  // Only meaningful for a diff — on a whole-repo scan every untested file would flood the list.
  for (const { file, checks } of reportUncovered ? coverage(existingChecks, code) : []) {
    if (checks.length) continue
    push({
      severity: 'MEDIUM',
      title: `no check names ${file}`,
      at: file,
      note: null,
      check: null,
    })
  }

  return gaps.sort((a, b) => RANK[a.severity] - RANK[b.severity])
}

// --- command -----------------------------------------------------------------

// The whole read-modify-write is inside the lock: holding it only for the write would
// still let two runs read the same original and each append the same checks.
const appendChecks = (gaps, path = SPEC_PATH) => withSpecLock(() => {
  const doc = YAML.parseDocument(read(path))
  const checks = doc.get('checks')
  if (!checks?.add) throw new Error(`${path} has no checks list to append to`)

  // Re-read inside the lock, so gaps another run just wrote are not appended twice.
  const already = new Set(checks.items.map(item => String(item.get?.('name') ?? '')))
  const added = gaps.filter(g => g.check && !already.has(g.check.name))

  for (const g of added) {
    const node = doc.createNode(g.check)
    // The gap note is printed once, in a terminal. Whoever opens the contract next — a
    // teammate, CI, the same person on Monday — sees only the check. Put the reason where
    // the edit has to happen.
    if (g.note) node.commentBefore = ` ${g.note}`
    checks.add(node)
  }
  writeFileAtomic(path, doc.toString())
  return added.length
})

/**
 * The line a commented-out `serve:` block starts on, or null. `init` writes one with the
 * project's own dev command, so the useful instruction is "uncomment line 13", not a blank
 * template the reader has to fill in again.
 */
export function commentedServeLine(path) {
  let lines
  try { lines = readFileSync(path, 'utf8').split('\n') } catch { return null }

  const i = lines.findIndex(l => /^\s*#\s*serve:\s*$/.test(l))
  return i === -1 ? null : i + 1
}

export function infer({ json = false, write = false, depth = 1, base = 'HEAD', specPath } = {}) {
  resetScan()
  unreadable.clear()
  const diff = changedFiles(base).filter(f => !f.startsWith(PROOF_DIR + '/'))
  // seed the walk with bumped packages too — importers of them are in the blast radius
  // every manifest in the diff, not just the root one
  const manifests = diff.filter(f => f === 'package.json' || f.endsWith('/package.json'))
  const deps = manifests.length ? dependencyChanges(base, manifests) : []
  const seeds = [...diff, ...deps.map(d => `${PKG}${d.name}`)]
  const scope = diff.length ? [...diff, ...dependents(seeds, depth).flat()] : walk()

  // Gaps come from the code, not the contract. A contract that does not validate costs the
  // ability to tell which gaps are already covered — worth saying, not worth withholding the
  // whole answer for. `--write` is different: appending to a file the user must edit anyway
  // would add duplicates of checks proof could not see.
  let spec = null
  let specProblem = null
  try {
    spec = loadSpec(specPath)
  } catch (e) {
    if (e.code === 'EBADSPEC') specProblem = e.problems?.[0] ?? e.message
    else if (e.code !== 'ENOSPEC') throw e
  }

  if (specProblem && write) {
    throw Object.assign(
      new Error(`${specPath ?? SPEC_PATH} is invalid, so \`--write\` would append to a contract proof cannot read:`
        + `\n  - ${specProblem}\nFix it, or run \`proof infer\` without \`--write\` to see the gaps.`),
      { code: 'EBADSPEC', problems: [specProblem] },
    )
  }
  const existing = spec?.checks ?? []

  const gaps = findGaps(scope, existing, { reportUncovered: diff.length > 0 })

  // Generated http checks use relative paths, which need somewhere to resolve against.
  // Writing them into a contract with no serve block would leave it invalid.
  const needsServe = !spec?.serve && gaps.some(g => g.check?.http?.path)
  // `init` scaffolds the serve block commented out, with the project's own dev command
  // already filled in. Printing a blank template told people to author something sitting in
  // their contract four lines below where they were looking.
  const scaffolded = needsServe ? commentedServeLine(specPath ?? SPEC_PATH) : null

  // Only code files can yield route/env gaps. Reporting "no gaps found" when nothing was
  // scannable is a clean bill of health for a scan that never ran.
  const scanned = scope.filter(f => CODE.test(f) && !isTestFile(f) && !unreadable.has(f)).length
  // Said out loud: "0 scannable" for a diff of nothing but tests should not look like a
  // scan that failed.
  const testFiles = scope.filter(f => CODE.test(f) && isTestFile(f)).length

  const out = {
    scope: diff.length ? 'diff' : 'repository',
    files: scope.length,
    scanned,
    test_files: testFiles,
    gaps,
    needs_serve: needsServe,
    serve_scaffold_line: scaffolded,
    // `check` refuses while one of these is in the contract. Appending real checks beside a
    // placeholder and saying nothing left the next `proof check` failing for a reason the
    // command that just ran already knew about.
    unfinished: placeholderChecks(spec ?? {}).map(u => u.name ?? `check[${u.i}]`),
    spec_invalid: specProblem,
    spec_path: specPath ?? SPEC_PATH,
    warnings: [
      // `--write` appends checks derived from this scope, so a fork point git could not find
      // becomes checks for files this branch never touched, written into the contract.
      ...(noCommonHistory(base) ? [SHALLOW(base)] : []),
      ...scanWarnings(),
      // The import-graph warning covers dependents only. The gap detectors read the same
      // files, and their silence about a file they could not open reads as "nothing here".
      ...(unreadable.size
        ? [`${unreadable.size} file(s) could not be read (${[...unreadable].sort().join(', ')})`
          + ' — routes and environment variables in them were not detected, so gaps there are missing']
        : []),
    ],
  }

  let written = 0
  if (write && gaps.length) written = appendChecks(gaps, specPath ?? SPEC_PATH)
  out.written = written

  if (json) console.log(JSON.stringify(out, null, 2))
  else printHuman(out, gaps, write)
  return 0
}

function printHuman(o, gaps, write) {
  const skipped = o.test_files ? `, ${o.test_files} test file(s) skipped` : ''
  console.log(`\nDetected change:\n  ${o.files} file(s) in scope (${o.scope}), ${o.scanned} scannable for gaps${skipped}`)

  if (o.spec_invalid) {
    console.log(`\nNOTE\n${block(`the contract is invalid, so proof could not tell which of these are`
      + ` already covered — ${o.spec_invalid}`, '  ')}`)
  }

  // Before the early return: "no gaps found" is the result a degraded scan produces,
  // so that is exactly where the caveat has to appear.
  for (const warning of o.warnings ?? []) console.log(`\nNOTE\n${block(warning, '  ')}`)

  if (!gaps.length) {
    // "Nothing was scanned" is what a degraded scan says. A diff of nothing but tests is not
    // degraded — proof skipped those on purpose, and saying otherwise sends someone looking
    // for a problem with the scan.
    // "no code file is in scope" contradicted the .py file listed two lines above. The
    // limitation is proof's detectors, not the diff, and naming it is the difference between
    // a caveat someone can act on and one that looks like a bug.
    const nothingScanned = o.scanned > 0
      ? '\nNo verification gaps found.\n'
      : o.test_files
        ? `\nEverything in scope was a test or fixture (${o.test_files} file(s)) — proof does not derive`
          + ' application gaps from those.\n'
        : o.files > 0
          ? '\nNo file in scope is one proof can scan for gaps — its route and environment detectors'
            + ' read JavaScript, TypeScript, Python and Go. `run:` checks work in any language.\n'
          : '\nNothing is in scope, so there are no gaps to derive from this change.\n'
    console.log(`\n${block(nothingScanned.trim(), '')}\n`)
    return
  }
  console.log('\nPotential verification gaps:')
  const w = columnWidth(gaps.map(g => g.title), TITLE_COLUMN_MAX)
  for (const g of gaps) {
    const title = padTo(truncateToWidth(g.title, TITLE_COLUMN_MAX), w + 2)
    console.log(`  ${g.severity.padEnd(8)}${title}${g.at ? `(${g.at})` : ''}`)
    // Hanging indent: the arrow marks the first line, continuations align under the text.
    if (g.note) console.log(block(g.note, ' '.repeat(14)).replace(/^ {14}/, `${' '.repeat(12)}↳ `))
  }
  const emittable = gaps.filter(g => g.check).length
  console.log(`\n${gaps.length} gap(s); ${emittable} can be generated as checks.`)
  console.log(write
    ? `Appended ${o.written} check(s) to ${o.spec_path}.`
    : `Run \`proof infer --write\` to append them to ${o.spec_path}.`)

  // `check` refuses a contract holding these, so say it here rather than let the next
  // command be the one to explain what this one just wrote.
  if (write && o.written > 0) {
    const patterns = gaps.filter(g => g.check?.http && /(?:^|\/)[:[{]/.test(g.check.http.path ?? '')).length
    if (patterns) {
      console.log(`\nNOTE\n${block(`${patterns} generated check(s) still contain a route pattern`
        + ' — replace the dynamic segment with a real value. `proof check` refuses to run until you do.', '  ')}`)
    }
  }

  if (o.unfinished?.length) {
    console.log(`\nNOTE\n${block(`${o.unfinished.length} check(s) still hold proof's own placeholder command`
      + ` (${o.unfinished.join(', ')}). \`proof check\` refuses to run until they are replaced or deleted.`, '  ')}`)
  }

  if (o.needs_serve) {
    console.log(o.serve_scaffold_line
      ? `\nNOTE\n  The generated http checks use relative paths, so the contract needs a serve block.`
        + `\n  One is already scaffolded in ${o.spec_path} at line ${o.serve_scaffold_line} — uncomment it`
        + '\n  and confirm the port.'
      : '\nNOTE\n  The generated http checks use relative paths, so the contract needs a serve block:'
        + '\n    serve:\n      run: <your dev command>\n      ready_url: http://localhost:<port>')
  }
  console.log()
}
