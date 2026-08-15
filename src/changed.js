import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import YAML from 'yaml'
import { join, dirname, resolve, relative, extname, basename } from 'node:path'
import { changedFiles, fileAtRef, forkPoint, inRepo, noCommonHistory, SHALLOW, addedFiles } from './git.js'
import { loadSpec, PROOF_DIR, SPEC_PATH, contractChange, CONTRACT_CHANGED_NOTICE } from './spec.js'
import { isTestFile, testsChanged, fillTestsNotice } from './diff.js'
import { TERMINAL_WIDTH, ellipsize, block, padTo, columnWidth } from './terminal.js'

const SRC_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']
const IGNORE = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'target', '__pycache__', 'out'])

// Paths the scan could not read. An unreadable file used to vanish silently and an
// unreadable directory used to kill the command — both now degrade the same way, visibly.
const scanProblems = new Set()
let depProblem = null
export const resetScan = () => { scanProblems.clear(); depProblem = null; resetWorkspaces() }

export function walk(dir = '.', out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    scanProblems.add(dir)
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORE.has(e.name)) continue
    const p = dir === '.' ? e.name : join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (SRC_EXT.includes(extname(e.name))) out.push(p)
  }
  return out
}

// ponytail: regex, not an AST. Catches import/require/dynamic-import; misses re-export
// gymnastics and computed specifiers. Swap for a parser when a real miss shows up.
const SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g
/**
 * Blank out comments, keeping every byte position so `file:line` still points at the code.
 *
 * The detectors are regexes over source, and a commented-out route is not reachable. Left in,
 * `infer --write` appended an http check for `// app.post('/api/old', h)` and an env check for
 * a commented `process.env.KEY` — checks that can never pass, reporting the requirement unmet
 * because of a line the runtime never sees.
 *
 * ponytail: a character scanner, not a parser — it tracks strings and template literals so a
 * URL inside quotes is not mistaken for a comment. A `//` inside a regex literal would still
 * fool it; use a real parser if that ever shows up in practice.
 */
// Where a `/` starts a regex rather than a division. The standard heuristic: look at what
// came before it. Getting this wrong is not cosmetic — a regex containing a quote, like
// /['"`]/, put the scanner into string mode and every comment after it in the file stopped
// being stripped, silently undoing comment handling for exactly the files most likely to
// contain such a regex.
const REGEX_POSITION = /[(,=:[!&|?{};+\-*%^~<>]$/
const REGEX_KEYWORD = /\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/

const startsRegex = before => {
  const trimmed = before.trimEnd()
  return trimmed === '' || REGEX_POSITION.test(trimmed) || REGEX_KEYWORD.test(trimmed)
}

export function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += i < src.length ? '  ' : ''
      i += 2
      continue
    }
    if (ch === '/' && startsRegex(out)) {
      // Copy the literal verbatim: a quote or a `//` inside it is part of the pattern.
      out += ch
      i += 1
      let inClass = false
      while (i < src.length && src[i] !== '\n') {
        const c = src[i]
        if (c === '\\') { out += c + (src[i + 1] ?? ''); i += 2; continue }
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) { out += c; i += 1; break }
        out += c
        i += 1
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      out += ch
      i += 1
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        i += 1
      }
      out += src[i] ?? ''
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const importsOf = src => [...src.matchAll(SPECIFIER)].map(m => m[1])


const isFile = p => existsSync(p) && statSync(p).isFile()

// tsconfig.json permits comments and trailing commas, so JSON.parse alone chokes on it.
const stripJsonComments = s =>
  s.replace(/"(?:\\.|[^"\\])*"|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (m, comment) => (comment ? '' : m))
    .replace(/,(\s*[}\]])/g, '$1')

// Read the real aliases rather than assuming `@/` means `src/`. Cached per directory
// because callers chdir. `extends` is not followed — say so rather than half-support it.
let aliasCache = { cwd: null, list: [], error: null }

export function pathAliases() {
  if (aliasCache.cwd === process.cwd()) return aliasCache.list
  const list = []
  let error = null
  for (const file of ['tsconfig.json', 'jsconfig.json']) {
    if (!existsSync(file)) continue
    try {
      const cfg = JSON.parse(stripJsonComments(readFileSync(file, 'utf8')))
      const { baseUrl = '.', paths = {} } = cfg.compilerOptions ?? {}
      for (const [pattern, targets] of Object.entries(paths)) {
        if (Array.isArray(targets)) list.push({ pattern, targets: targets.map(t => join(baseUrl, t)) })
      }
    } catch (e) {
      // A malformed config is the project's problem, not a reason to crash — but silently
      // dropping its aliases under-reports the blast radius, which reads as "nothing is affected".
      error = `${file} could not be parsed (${e.message.split('\n')[0]}) — import aliases are unresolved, so dependents may be missing`
    }
    break
  }
  aliasCache = { cwd: process.cwd(), list, error }
  return list
}

/** Why alias resolution is degraded, if it is. */
export function aliasConfigError() {
  pathAliases()
  return aliasCache.error
}

/** Everything that made this scan less complete than it looks. */
export function scanWarnings() {
  const out = []
  const alias = aliasConfigError()
  if (alias) out.push(alias)
  if (depProblem) out.push(depProblem)
  if (scanProblems.size) {
    const shown = [...scanProblems].slice(0, 5).join(', ')
    out.push(`${scanProblems.size} path(s) could not be read (${shown}${scanProblems.size > 5 ? ', …' : ''})`
      + ' — imports there were not scanned, so dependents may be missing')
  }
  return out
}

function aliasTargets(spec) {
  const out = []
  for (const { pattern, targets } of pathAliases()) {
    if (!pattern.includes('*')) {
      if (spec === pattern) out.push(...targets)
      continue
    }
    const [prefix, suffix = ''] = pattern.split('*')
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue
    const stem = spec.slice(prefix.length, spec.length - suffix.length)
    for (const t of targets) out.push(t.replace('*', stem))
  }
  return out
}

/**
 * Workspace packages: `@acme/utils` is a directory in this repo, not something in
 * node_modules. Treating it as an installed package left the blast radius of every shared
 * package empty — `changed` reported "none found" for a change whose consumers are sitting
 * in the same checkout.
 *
 * ponytail: only a trailing `/*` glob, which is what workspace globs are in practice.
 * A deeper pattern falls through to the package treatment, same as before.
 */
let workspaceCache = null

const workspaceGlobs = () => {
  const globs = []
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    const w = pkg.workspaces
    globs.push(...(Array.isArray(w) ? w : w?.packages ?? []))
  } catch {}
  try {
    const y = YAML.parse(readFileSync('pnpm-workspace.yaml', 'utf8'))
    globs.push(...(y?.packages ?? []))
  } catch {}
  return globs
}

/** name -> directory, for every workspace package in this repo. */
export function workspacePackages() {
  if (workspaceCache) return workspaceCache
  workspaceCache = new Map()

  for (const glob of workspaceGlobs()) {
    const dirs = glob.endsWith('/*')
      ? (() => {
          const parent = glob.slice(0, -2)
          try {
            return readdirSync(parent, { withFileTypes: true })
              .filter(e => e.isDirectory())
              .map(e => join(parent, e.name))
          } catch { return [] }
        })()
      : [glob]

    for (const dir of dirs) {
      try {
        const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name
        if (name && !workspaceCache.has(name)) workspaceCache.set(name, dir)
      } catch {}
    }
  }
  return workspaceCache
}

export const resetWorkspaces = () => { workspaceCache = null }

/** `@acme/utils/deep` -> packages/utils/deep, when @acme/utils is a workspace here. */
const workspaceBase = spec => {
  const packages = workspacePackages()
  if (!packages.size) return []

  for (const [name, dir] of packages) {
    if (spec !== name && !spec.startsWith(`${name}/`)) continue
    const subpath = spec.slice(name.length).replace(/^\//, '')
    const base = subpath ? join(dir, subpath) : dir
    // A package entry point is usually src/index or index; both are tried by the caller.
    return subpath ? [resolve('.', base)] : [resolve('.', base), resolve('.', join(dir, 'src'))]
  }
  return []
}

const specifierBases = (spec, fromFile) =>
  (spec.startsWith('.')
    ? [resolve(dirname(fromFile), spec)]
    : workspaceBase(spec).length
      ? workspaceBase(spec)
    : aliasTargets(spec).length
      ? aliasTargets(spec).map(p => resolve('.', p))
      // no configured aliases: fall back to the common convention
      : /^[@~]\//.test(spec)
        ? [resolve('.', spec.slice(2)), resolve('src', spec.slice(2))]
        : [])

/**
 * TypeScript's NodeNext convention: source files import each other by the path the *output*
 * will have, so `./money.js` means `./money.ts`. Without this the blast radius of any such
 * project was empty — `changed` reported "none found" for every edit, which reads as an
 * answer rather than as a scan that resolved nothing.
 */
const OUTPUT_TO_SOURCE = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
])

/** Bases to try for one specifier: itself, plus the sources its extension could compile from. */
const withSourceBases = base => {
  const ext = extname(base)
  const sources = OUTPUT_TO_SOURCE.get(ext)
  if (!sources) return [base]
  const stem = base.slice(0, -ext.length)
  return [base, ...sources.map(e => stem + e)]
}

/** Every path this specifier could name, whether or not anything is there now. */
const candidatesFor = base => [
  ...withSourceBases(base),
  ...SRC_EXT.map(e => base + e),
  ...SRC_EXT.map(e => join(base, 'index' + e)),
]

export function specifierCandidates(spec, fromFile) {
  return specifierBases(spec, fromFile)
    .flatMap(base => candidatesFor(base).map(p => relative('.', p)))
}

export function resolveSpecifier(spec, fromFile) {
  for (const base of specifierBases(spec, fromFile)) {
    for (const cand of candidatesFor(base)) {
      if (isFile(cand)) return relative('.', cand)
    }
  }
  return null
}

export const PKG = 'pkg:'

/** The installed package a bare specifier belongs to (`lodash/fp` -> `lodash`). */
export const packageOf = spec => {
  if (!spec || spec.startsWith('.') || /^[@~]\//.test(spec)) return null
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const allDeps = pkg => Object.assign({}, ...DEP_FIELDS.map(f => pkg?.[f] ?? {}))

/**
 * Dependencies whose declared version differs from `base`, across every changed manifest.
 *
 * Only the root package.json was read, so in a monorepo a bump inside
 * `packages/api/package.json` showed the file as changed and no dependency change at all —
 * the empty radius this whole feature exists to prevent, one directory down.
 */
export function dependencyChanges(base = 'HEAD', manifests = ['package.json']) {
  return manifests
    .filter(m => m === 'package.json' || m.endsWith('/package.json'))
    .flatMap(m => manifestChanges(m, base))
}

function manifestChanges(manifest, base) {
  if (!existsSync(manifest)) return []

  // A package.json that will not parse — a merge conflict, a stray comma — used to return
  // "no dependency changes". The file is right there in the changed list, so the silence
  // reads as an answer: nothing dependency-related moved.
  let now, before
  try { now = JSON.parse(readFileSync(manifest, 'utf8')) } catch (e) {
    depProblem = `${manifest} could not be parsed (${e.message}) — dependency changes were not derived`
    return []
  }
  const previous = fileAtRef(forkPoint(base), manifest)
  if (previous === null) return []
  try { before = JSON.parse(previous) } catch (e) {
    depProblem = `${manifest} at ${base} could not be parsed (${e.message}) — dependency changes were not derived`
    return []
  }

  const a = allDeps(before)
  const b = allDeps(now)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(name => a[name] !== b[name])
    .sort()
    // The manifest is part of the answer: `express 4 -> 5` means something different in
    // packages/api than in packages/web, and a monorepo can change both at once.
    .map(name => ({ name, from: a[name] ?? null, to: b[name] ?? null, manifest }))
}

/** file -> Set of files importing it */
export function reverseGraph(files = walk()) {
  const rev = new Map()
  for (const f of files) {
    let src
    try { src = readFileSync(f, 'utf8') } catch { scanProblems.add(f); continue }
    const addEdge = (target, importer) => {
      if (!target || target === importer) return
      if (!rev.has(target)) rev.set(target, new Set())
      rev.get(target).add(importer)
    }

    for (const spec of importsOf(stripComments(src))) {
      const target = resolveSpecifier(spec, f)
      if (target) { addEdge(target, f); continue }

      // Nothing is there now. That is exactly what a just-deleted module looks like, and
      // deleting one breaks every importer — the blast radius that matters most. Record the
      // paths the specifier would have named so a lookup by the deleted path still finds them.
      const candidates = specifierCandidates(spec, f)
      if (candidates.length) {
        for (const candidate of candidates) addEdge(candidate, f)
        continue
      }

      // A bare specifier is a package. Keyed separately so a dependency bump can find
      // everything that imports it.
      const pkg = packageOf(spec)
      if (pkg) addEdge(`${PKG}${pkg}`, f)
    }
  }
  return rev
}

/** BFS outward from `seeds`; returns one sorted array per hop. */
export function dependents(seeds, depth = 1, rev = reverseGraph()) {
  const seen = new Set(seeds)
  const levels = []
  let frontier = seeds
  for (let d = 0; d < depth; d++) {
    const next = []
    for (const f of frontier) {
      for (const dep of rev.get(f) ?? []) {
        if (seen.has(dep)) continue
        seen.add(dep)
        next.push(dep)
      }
    }
    if (!next.length) break
    levels.push(next.sort())
    frontier = next
  }
  return levels
}

// A check "references" a file if its YAML mentions the path or a distinctive basename.
/** Framework routes declared by file path (Next app router / pages api). */
export function fileRoute(f) {
  let m = f.match(/(?:^|\/)app\/(.+)\/route\.[jt]sx?$/)
  if (m) return '/' + m[1].split('/').filter(s => !s.startsWith('(')).join('/')
  m = f.match(/(?:^|\/)pages\/api\/(.+)\.[jt]sx?$/)
  if (m) return '/api/' + m[1].replace(/\/index$/, '')
  return null
}

// Filenames a framework hands out by convention. They identify nothing on their own, and
// they fail in both directions: `index.ts` was excluded and so matched nothing, while
// `page.tsx` matched any check mentioning "page" — every page file in the repo at once.
// What identifies such a file is the directory it sits in.
const GENERIC = new Set(['index', 'route', 'page', 'layout', 'main', 'mod', 'handler'])

const usable = name => name.length >= 4 && !GENERIC.has(name.toLowerCase()) && !/^[[({]/.test(name)





const distinctive = f => {
  const segments = f.split('/').filter(Boolean)
  const last = segments.pop()
  const stem = basename(last, extname(last))
  if (usable(stem)) return stem

  // Walk up: src/lib/session/index.ts is the session module, app/dashboard/page.tsx is
  // dashboard. Dynamic segments ([id]) name nothing either, so they are stepped over.
  for (const segment of segments.reverse()) {
    if (usable(segment)) return segment
  }
  return null
}

// Whole tokens, not substrings: "sessionStorage polyfill tests" must not count as naming
// session.ts. Over-claiming here hides a gap, which is the direction that costs something.
const tokensOf = text => new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))

/** Paths a check requests: `/api/users` from http, and from a browser flow's expectations. */
const requestedPaths = c => {
  const out = []
  const add = v => { if (typeof v === 'string' && v.startsWith('/')) out.push(v.split('?')[0]) }
  add(c?.http?.path)
  if (typeof c?.http?.url === 'string') { try { out.push(new URL(c.http.url).pathname) } catch {} }
  for (const s of c?.browser?.flow ?? []) { add(s?.expect_request?.path); add(s?.visit) }
  add(c?.browser?.visit)
  return out
}

export function coverage(checks, files) {
  return files.map(file => {
    const stem = distinctive(file)
    const simpleStem = stem && /^[A-Za-z0-9]+$/.test(stem) ? stem.toLowerCase() : null
    // Every app-router file is called route.ts, so the filename says nothing about which
    // one it is. The URL it serves does: a check requesting /api/users covers the file that
    // implements /api/users, and without this every route file read as uncovered forever.
    const route = fileRoute(file)

    const names = checks
      .filter(c => {
        if (route && requestedPaths(c).includes(route)) return true
        const text = JSON.stringify(c)
        if (text.includes(file) || text.includes(basename(file))) return true
        if (simpleStem) return tokensOf(text).has(simpleStem)
        // a stem carrying separators (session-store) has no single token to match
        return stem ? text.toLowerCase().includes(stem.toLowerCase()) : false
      })
      .map(c => c.name ?? '(unnamed)')

    return { file, checks: names }
  })
}

export function changed({ json = false, depth = 1, base = 'HEAD', specPath } = {}) {
  resetScan()
  // the contract and its evidence are not code under test
  // Outside a repository every git call fails, and the empty file list printed as
  // "No changes — nothing to verify": proof reporting that it could not look as though it
  // had looked and found nothing. `infer` is fine here — it falls back to scanning the whole
  // tree — but the blast radius has no meaning without a commit to compare against.
  if (!inRepo()) {
    throw Object.assign(
      new Error('not a git repository — `changed` compares your working tree against a commit,'
        + ' so run it inside one (or `git init` here)'),
      { code: 'ENOREPO' })
  }

  const files = changedFiles(base).filter(f => !f.startsWith(PROOF_DIR + '/'))

  // A version bump breaks whatever imports that package, so seed the walk with it too.
  // every manifest in the diff, not just the root one
  const manifests = files.filter(f => f === 'package.json' || f.endsWith('/package.json'))
  const deps = manifests.length ? dependencyChanges(base, manifests) : []
  const seeds = [...files, ...deps.map(d => `${PKG}${d.name}`)]

  // Files that contributed nothing to the walk. A lockfile or a tsconfig can change the
  // whole build, but proof cannot derive dependents from them — and "none found" reads as
  // "nothing is affected" rather than "I cannot see this".
  const contributed = new Set([
    ...files.filter(f => SRC_EXT.includes(extname(f))),
    ...(deps.length ? ['package.json'] : []),
  ])
  const unscannable = files.filter(f => !contributed.has(f))

  const levels = seeds.length ? dependents(seeds, depth) : []
  const radius = [...files, ...levels.flat()]

  // a broken contract is an error worth showing; only a missing one is "no spec yet"
  let checks = null
  // A typo in one check should not withhold the blast radius: the files, their dependents
  // and the dependency changes are all independent of the contract. Only coverage needs it,
  // so only coverage is withheld — and it says why.
  let specProblem = null
  try {
    checks = loadSpec(specPath).checks
  } catch (e) {
    // The first problem, not the first line: the message's first line is only the heading.
    if (e.code === 'EBADSPEC') specProblem = e.problems?.[0] ?? e.message
    else if (e.code !== 'ENOSPEC') throw e
  }

  const cov = checks ? coverage(checks, radius) : null
  // A test file that no check names is not a gap: the file is the verification. Warning
  // about it is the noise that teaches people to skip this section.
  const uncovered = cov?.filter(c => !c.checks.length && !isTestFile(c.file)).map(c => c.file) ?? []

  const warnings = scanWarnings()

  // The thesis, in the form that costs the most: passing the existing suite is not the same
  // as satisfying the requirement, and here the suite is not the existing one. An agent that
  // relaxes an assertion and edits the code in one diff gets `OK — unit tests` on both files
  // and a DONE verdict. Editing tests is normal and often right; doing it unnoticed is not.
  const movedTests = testsChanged(base)
  if (movedTests.length) warnings.push(fillTestsNotice(movedTests))

  const contract = inRepo() ? contractChange(base, specPath ?? SPEC_PATH) : null
  if (contract) {
    // Additions alone stay quiet. A check that did not exist before cannot make a verdict
    // weaker, and `infer --write` adds checks as its whole job — warning there would fire on
    // the workflow proof itself recommends. They are still named when something else fired.
    const weakened = contract.unparseable || contract.goal
      || contract.removed.length > 0 || contract.modified.length > 0
    const parts = contract.unparseable
      ? ['it could not be parsed at both ends, so what moved is unknown']
      : [
        ...(contract.goal ? ['the goal itself was rewritten'] : []),
        ...(contract.removed.length ? [`${contract.removed.length} check(s) removed (${contract.removed.join(', ')})`] : []),
        ...(contract.modified.length ? [`${contract.modified.length} changed (${contract.modified.join(', ')})`] : []),
        ...(contract.added.length ? [`${contract.added.length} added (${contract.added.join(', ')})`] : []),
      ]
    if (weakened && parts.length) warnings.push(CONTRACT_CHANGED_NOTICE.replace('{what}', parts.join('; ')))
  }

  if (noCommonHistory(base)) {
    warnings.unshift(SHALLOW(base))
  }
  const out = {
    base,
    changed: files,
    dependencies: deps,
    unscannable,
    dependents: levels,
    uncovered,
    tests_changed: movedTests,
    contract_changed: contract && !contract.unparseable
      ? { removed: contract.removed, added: contract.added, modified: contract.modified, goal: contract.goal }
      : null,
    coverage: cov,
    spec: Boolean(checks),
    spec_invalid: specProblem,
    warnings,
  }

  if (json) console.log(JSON.stringify(out, null, 2))
  else printHuman(out, depth)
  return 0
}

function printHuman(o, depth) {
  if (!o.changed.length) {
    console.log(`\nNo changes against ${o.base} — nothing to verify.\n`)
    return
  }
  console.log('\nChanged:')
  for (const f of o.changed) console.log(`  ${f}`)

  if (o.dependencies?.length) {
    console.log('\nChanged dependencies:')
    // Name the manifest when it is not the root one: in a monorepo two packages bumping the
    // same dependency rendered as two identical lines.
    const width = columnWidth(o.dependencies.map(d => d.name), 40)
    for (const d of o.dependencies) {
      const where = d.manifest && d.manifest !== 'package.json' ? `  (${d.manifest})` : ''
      console.log(ellipsize(`  ${padTo(d.name, width)}  ${d.from ?? '(added)'} → ${d.to ?? '(removed)'}${where}`))
    }
  }

  if (o.dependents.length) {
    o.dependents.forEach((level, i) => {
      console.log(`\n${i === 0 ? 'Direct dependents:' : `Dependents (hop ${i + 1}):`}`)
      for (const f of level) console.log(`  ${f}`)
    })
  } else if (o.changed.length === o.unscannable?.length) {
    // nothing was scanned, so "none found" would be a claim proof never tested
    console.log('\nDirect dependents:\n  not derivable — no changed file could be scanned for imports')
  } else {
    console.log(`\nDirect dependents:\n  none found (import scan, depth ${depth})`)
  }

  if (o.unscannable?.length) {
    console.log('\nNot import-scannable (dependents cannot be derived from these):')
    for (const f of o.unscannable) console.log(`  ${f}`)
  }

  // Printed next to the dependents, because that is the number it makes unreliable.
  // One heading with the facts separated, not the heading repeated per fact — `check`
  // renders the same list the same way.
  if (o.warnings?.length) console.log(`\nNOTE\n${o.warnings.map(w => block(w, '  ')).join('\n\n')}`)

  // The file is there and unusable, which is not the same as absent — and the fix is a
  // different one.
  if (o.spec_invalid) {
    console.log(`\nChecks naming these files:\n${block(`the contract is invalid, so coverage was not`
      + ` computed — ${o.spec_invalid}`, '  ')}\n`)
    return
  }

  if (!o.coverage) {
    console.log('\nChecks naming these files:\n  no .proof/spec.yaml — run `proof init "<requirement>"`\n')
    return
  }
  // "names" not "covers": matching a check's text to a filename is a heuristic, and calling
  // it coverage would claim something proof has not measured.
  console.log('\nChecks naming these files:')
  // A file named by a dozen checks listed them all on one line. Fit what the width allows
  // and count the rest: truncating the line instead would cut off the count, which is the
  // part worth keeping. --json carries every name.
  const summarise = (names, budget) => {
    const shown = []
    let used = 0
    for (const name of names) {
      const cost = (shown.length ? 2 : 0) + name.length
      if (used + cost > budget - 12) break // room for ", +N more"
      shown.push(name)
      used += cost
    }
    if (shown.length === names.length) return shown.join(', ')
    return `${shown.join(', ')}${shown.length ? ', ' : ''}+${names.length - shown.length} more`
  }

  for (const { file, checks } of o.coverage) {
    const tag = checks.length ? 'OK  ' : isTestFile(file) ? 'TEST' : 'WARN'
    const prefix = `  ${tag}  ${file} — `
    const body = checks.length
      ? summarise(checks, TERMINAL_WIDTH - prefix.length)
      : isTestFile(file)
        ? 'a test, so it verifies rather than needs verifying'
        : 'no check names this file'
    console.log(ellipsize(prefix + body, TERMINAL_WIDTH))
  }
  if (o.uncovered.length) console.log(`\n${o.uncovered.length} file(s) in the blast radius have no check naming them.`)
  console.log()
}
