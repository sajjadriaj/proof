import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import YAML from 'yaml'
import { validateSpec, PLACEHOLDER_RUN, placeholderChecks } from './validate.js'
import { fileAtRef, forkPoint } from './git.js'

export const PROOF_DIR = '.proof'
export const SPEC_PATH = join(PROOF_DIR, 'spec.yaml')
const LOCK_PATH = join(PROOF_DIR, 'spec.lock')

/** Write via a temp file in the same directory, so a crash cannot leave a half-written file. */
/**
 * Why a write failed, in the terms of what proof was trying to do.
 *
 * The raw errno — `EACCES: permission denied, mkdir '.proof/runs'` — says nothing about what
 * was being written or what to change, and a read-only mount is an ordinary state for a CI
 * container. Codes it does not recognise are passed through untouched, so an unrelated
 * failure is not dressed up as a permissions problem.
 */
/**
 * The contract is the definition of "done", so a diff that edits it is changing what passing
 * means. An agent that cannot make `proof check` pass can delete the check instead: the
 * removal is invisible in the blast radius (`.proof/` is excluded from it, correctly — the
 * contract is not code under test) and the run that follows reports DONE.
 *
 * Names only. The bodies are in the diff; what belongs in a one-line notice is which checks
 * stopped existing.
 */
export function contractChange(base, specPath = SPEC_PATH) {
  const previous = fileAtRef(forkPoint(base), specPath)
  if (previous === null) return null                 // not tracked at that ref: nothing to compare

  let before, after
  try {
    before = YAML.parse(previous)
    after = YAML.parse(readFileSync(specPath, 'utf8'))
  } catch { return { unparseable: true, removed: [], added: [], modified: [], goal: false } }
  if (!before || !after) return null

  const byName = spec => new Map((Array.isArray(spec.checks) ? spec.checks : [])
    .filter(c => c && typeof c.name === 'string')
    .map(c => [c.name, JSON.stringify(c)]))
  const [a, b] = [byName(before), byName(after)]

  return {
    unparseable: false,
    removed: [...a.keys()].filter(n => !b.has(n)),
    added: [...b.keys()].filter(n => !a.has(n)),
    modified: [...a.keys()].filter(n => b.has(n) && b.get(n) !== a.get(n)),
    goal: (before.goal ?? before.requirement) !== (after.goal ?? after.requirement),
  }
}

/** Filled by `changed`; a template so the README block can be checked against it. */
export const CONTRACT_CHANGED_NOTICE =
  'this diff also changes the contract — {what}. The contract is the definition of "done", so'
  + ' a verdict from it is a verdict against expectations this diff set. Read those changes'
  + ' first: a check that was removed cannot fail.'

export const writeError = (e, path, subject, hint) => {
  const why = {
    EACCES: 'permission denied',
    EPERM: 'permission denied',
    EROFS: 'the filesystem is read-only',
    ENOSPC: 'the disk is full',
    EDQUOT: 'the disk quota is exhausted',
  }[e?.code]

  // Not a permissions problem, so the caller's hint (make it writable, choose another tree)
  // would be the wrong advice. A check that cleans the working tree does exactly this.
  if (e?.code === 'ENOENT') {
    return Object.assign(
      new Error(`cannot write ${subject} to ${path} — it is no longer there. Something removed it`
        + ' while proof was running; a check that cleans or resets the working tree will do this.'),
      { code: 'EWRITE' })
  }
  if (!why) return e

  return Object.assign(new Error(`cannot write ${subject} to ${path} — ${why}. ${hint}`), { code: 'EWRITE' })
}

export function writeFileAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  } catch (e) {
    // The temp name is an implementation detail. Reporting `result.json.3387075.tmp` tells
    // someone about a file that never existed and sends them looking for it.
    if (typeof e?.message === 'string') e.message = e.message.split(tmp).join(path)
    throw e
  }
}

const sleepSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/**
 * Serialise read-modify-write of the contract. Without this, two `infer --write` runs both
 * read the original, both append, and the file ends up with every generated check twice —
 * a contract the user then has to repair by hand.
 */
export function withSpecLock(fn) {
  try {
    mkdirSync(PROOF_DIR, { recursive: true })
  } catch (e) {
    throw writeError(e, PROOF_DIR, 'the contract',
      'Modifying it needs a writable .proof directory; `proof infer` without `--write` only reads.')
  }
  let waited = 0
  let brokeStaleLock = false

  for (;;) {
    try {
      closeSync(openSync(LOCK_PATH, 'wx')) // exclusive create
      break
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw writeError(e, LOCK_PATH, 'the contract lock',
          'Modifying the contract needs a writable .proof directory; `proof infer` without `--write` only reads.')
      }
      if (waited < 5000) {
        sleepSync(50)
        waited += 50
        continue
      }
      // Held for 5s: assume the holder died before releasing. Break it once, then give up.
      if (brokeStaleLock) throw new Error(`could not acquire ${LOCK_PATH} — remove it if no proof run is active`)
      brokeStaleLock = true
      waited = 0
      try { unlinkSync(LOCK_PATH) } catch {}
    }
  }

  try {
    return fn()
  } finally {
    try { unlinkSync(LOCK_PATH) } catch {}
  }
}

/** Thrown only when the spec file is absent, so callers can tell "no contract" from "broken contract". */
export const missingSpec = path =>
  Object.assign(new Error(`no spec at ${path} — run \`proof init "<requirement>"\``), { code: 'ENOSPEC' })

export function loadSpec(path = SPEC_PATH) {
  if (!existsSync(path)) throw missingSpec(path)

  // Reading and parsing are different failures with different fixes. Reporting a file proof
  // could not open as "not valid YAML" sends someone to edit a file that is not broken.
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch (e) {
    const why = { EACCES: 'permission denied', EPERM: 'permission denied', EISDIR: 'it is a directory' }[e.code]
    throw Object.assign(
      new Error(why
        ? `cannot read the contract at ${path} — ${why}`
        : `cannot read the contract at ${path} — ${e.message}`),
      { code: 'ESPECREAD' },
    )
  }

  let spec
  try {
    spec = YAML.parse(source)
  } catch (e) {
    throw Object.assign(new Error(`${path} is not valid YAML — ${e.message.split('\n')[0]}`), { code: 'EBADSPEC' })
  }

  const problems = validateSpec(spec)
  if (problems.length) {
    // A placeholder is not a validation error — `infer --write` has to be allowed on a
    // contract holding one — but `check` refuses for it in a later phase. Reported here as
    // well as there, because proof knows about it now: without this, a fresh `init` plus
    // `infer --write` showed two problems, and a third only after both were fixed.
    const waiting = placeholderChecks(spec)
    const also = waiting.length
      ? `\n\nAlso, once the above are fixed: ${waiting.length} check(s) still hold proof's own`
        + ` placeholder command (${waiting.map(c => c.name ?? `check[${c.i}]`).join(', ')}).`
      : ''

    // Coded so callers can tell a broken contract from a missing one. `changed` needs the
    // difference: a blast radius does not depend on the contract being valid.
    throw Object.assign(
      new Error(`${path} is invalid:\n${problems.map(p => `  - ${p}`).join('\n')}${also}`),
      { code: 'EBADSPEC', problems, placeholders: waiting.map(c => c.name ?? `check[${c.i}]`) },
    )
  }
  return spec
}

/**
 * How to run pytest here, read from what the project shows rather than assumed.
 *
 * Bare `pytest` is on PATH only inside an activated virtualenv, and `init` is run from
 * whatever shell you happen to be in: on a repo with a `.venv` the scaffolded check failed
 * with `pytest: command not found` — a check that cannot pass for a reason that has nothing
 * to do with the requirement. Same rule as the `Makefile` row below, which already refuses to
 * scaffold a target the project does not define.
 */
export function pytestCommand() {
  // A binary that is right there needs no resolver, no network and no lockfile to be current.
  for (const venv of ['.venv', 'venv']) {
    if (existsSync(`${venv}/bin/pytest`)) return `${venv}/bin/pytest -q`
  }
  if (existsSync('uv.lock')) return 'uv run pytest -q'
  if (existsSync('poetry.lock')) return 'poetry run pytest -q'
  if (existsSync('Pipfile.lock')) return 'pipenv run pytest -q'

  // `python3 -m pytest`, not bare `pytest`: it works wherever pytest is importable, including
  // the interpreter an activated venv puts first, and PEP 394 guarantees `python3` exists
  // where a bare `pytest` console script may simply not be installed.
  return 'python3 -m pytest -q'
}

// ponytail: detection is a table, not a plugin system. Add a row per ecosystem.
const ECOSYSTEMS = [
  {
    file: 'package.json',
    checks: () => {
      const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {}
      return ['build', 'typecheck', 'lint', 'test']
        .filter(s => scripts[s])
        .map(s => ({ name: s, run: `npm run ${s}` }))
    },
  },
  { file: 'Cargo.toml', checks: () => [{ name: 'build', run: 'cargo build' }, { name: 'tests', run: 'cargo test' }] },
  { file: 'go.mod', checks: () => [{ name: 'build', run: 'go build ./...' }, { name: 'tests', run: 'go test ./...' }] },
  { file: 'pyproject.toml', checks: () => [{ name: 'tests', run: pytestCommand() }] },
  { file: 'pytest.ini', checks: () => [{ name: 'tests', run: pytestCommand() }] },
  { file: 'tox.ini', checks: () => [{ name: 'tests', run: 'tox' }] },
  { file: 'Gemfile', checks: () => [{ name: 'tests', run: 'bundle exec rake test' }] },
  { file: 'pom.xml', checks: () => [{ name: 'tests', run: 'mvn -q test' }] },
  { file: 'build.gradle', checks: () => [{ name: 'tests', run: './gradlew test' }] },
  { file: 'build.gradle.kts', checks: () => [{ name: 'tests', run: './gradlew test' }] },
  // Last, and only for targets it can see. A Makefile is the most explicit statement a
  // project makes about how to build and test itself, but only for targets it defines —
  // scaffolding `make test` into a Makefile without that target writes a check that fails
  // on the first run, which is worse than the placeholder it replaced.
  {
    file: 'Makefile',
    checks: () => {
      const targets = makeTargets('Makefile')
      return ['build', 'test', 'check', 'lint'].filter(t => targets.has(t))
        .map(t => ({ name: t === 'test' ? 'tests' : t, run: `make ${t}` }))
    },
  },
]

/** Target names a Makefile defines: `test:` at the start of a line, `.PHONY` and all. */
export function makeTargets(file) {
  const out = new Set()
  let source
  try { source = readFileSync(file, 'utf8') } catch { return out }

  for (const line of source.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/)
    if (m && m[1] !== '.PHONY') out.add(m[1])
  }
  return out
}

export function discoverChecks() {
  const eco = ECOSYSTEMS.find(e => existsSync(e.file))
  return eco ? eco.checks() : []
}

export const BACKUP_PATH = `${SPEC_PATH}.bak`

export function init(requirement, { json = false, force = false, specPath } = {}) {
  // Uniform with check/changed/infer: a contract kept elsewhere should be creatable the
  // same way it is read, rather than written to the default path and moved by hand.
  const path = specPath ?? SPEC_PATH
  const backup = `${path}.bak`
  const dir = dirname(path)

  if (existsSync(path) && !force) throw Object.assign(new Error(`${path} already exists — pass --force to overwrite`), { code: 'ESPECEXISTS' })
  if (!requirement) throw Object.assign(new Error('usage: proof init "<requirement>"'), { code: 'EUSAGE' })

  // A contract is written by hand over time. --force is explicit, but discarding it with
  // nothing kept is a worse trade than one file — every other write to this path is
  // locked and atomic, and this was the one path that simply destroyed it.
  const replacing = existsSync(path) ? readFileSync(path, 'utf8') : null

  const checks = discoverChecks()
  const serveCommand = discoverServeCommand()
  const spec = {
    goal: requirement,
    checks: checks.length ? checks : [{ name: 'tests', run: [...PLACEHOLDER_RUN.keys()][0] }],
  }

  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    throw writeError(e, dir, 'the contract',
      'The contract lives in the repository, so `proof init` needs to create that directory here.')
  }
  const doc = new YAML.Document(spec)

  withSpecLock(() => {
    if (replacing !== null) writeFileAtomic(backup, replacing)
    writeFileAtomic(path, header(checks.length, serveCommand) + doc.toString())
  })
  // Only for proof's own directory: evidence and locks live there whatever the contract's
  // path, and writing a .gitignore into someone else's directory is not proof's business.
  mkdirSync(PROOF_DIR, { recursive: true })
  writeFileSync(join(PROOF_DIR, '.gitignore'), 'runs/\nspec.lock\n*.tmp\n*.bak\n')

  const out = {
    status: 'ok',
    spec: path,
    discovered: checks.map(c => c.name),
    serve_command: serveCommand,
    replaced: replacing === null ? null : backup,
  }
  if (json) console.log(JSON.stringify(out, null, 2))
  else {
    console.log(`\nwrote ${path}`)
    if (out.replaced) console.log(`the previous contract was kept at ${out.replaced}`)
    console.log(checks.length
      ? `discovered ${checks.length} check(s): ${checks.map(c => c.name).join(', ')}`
      : 'no build/test commands discovered — edit the spec by hand')
    if (serveCommand) {
      console.log(`\nfound \`${serveCommand}\` — a serve block using it is scaffolded (commented) in the spec.`)
      console.log('Uncomment it and confirm the port to enable http and browser checks.')
    }
    console.log(`\nnext: add acceptance checks that prove the requirement, then run \`proof check\`\n`)
  }
  return out
}

/** The script that boots the app, if the project declares one. */
/**
 * How this project starts itself, so http and browser checks have somewhere to point.
 *
 * Only npm scripts were read, so every non-JavaScript project got no serve block scaffolded
 * and no prompt to add one — the commands that need it are exactly the ones that show a
 * requirement works.
 */
/**
 * The command a Procfile declares for the process that listens. `web` by convention; failing
 * that the first entry, since a one-process Procfile rarely bothers with the name.
 */
export function procfileWeb(file) {
  let source
  try { source = readFileSync(file, 'utf8') } catch { return null }

  const entries = []
  // The pattern is anchored at the start of the line, so comments and blanks fall out of it
  // without a separate skip — `# web: gunicorn` is not an entry because `#` is not a name.
  for (const line of source.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(\S.*?)\s*$/)
    if (m) entries.push({ name: m[1], command: m[2] })
  }
  if (!entries.length) return null

  return (entries.find(e => e.name === 'web') ?? entries[0]).command
}

export function discoverServeCommand() {
  if (existsSync('package.json')) {
    try {
      const { scripts = {} } = JSON.parse(readFileSync('package.json', 'utf8'))
      const name = ['dev', 'start', 'serve'].find(s => scripts[s])
      if (name) return `npm run ${name}`
    } catch { /* a manifest that will not parse is handled where it is validated */ }
  }

  // A target the project defined itself beats anything guessed from the language.
  const targets = existsSync('Makefile') ? makeTargets('Makefile') : new Set()
  const target = ['dev', 'serve', 'run', 'start'].find(t => targets.has(t))
  if (target) return `make ${target}`

  // Same principle one step further: a Procfile is the project stating its own start
  // command, in Python, Ruby, Go and Node alike. Preferred over any language guess, since
  // the guess is what proof would fall back to anyway.
  const web = procfileWeb('Procfile')
  if (web) return web

  if (existsSync('Cargo.toml')) return 'cargo run'
  if (existsSync('go.mod')) return 'go run .'
  // python3, not python: PEP 394 guarantees the former on POSIX, and plenty of Linux
  // systems have no bare `python` at all — a scaffolded command that is not there fails
  // to boot, which short-circuits every check after it.
  if (existsSync('manage.py')) return 'python3 manage.py runserver'

  // Python without a framework convention: no single command is right, so say nothing
  // rather than scaffold `python app.py` at a project whose entry point is elsewhere.
  return null
}

// Scaffolded commented rather than live: the command is read from package.json, but the
// port is not something proof can know, and a wrong ready_url is worse than an absent one.
/**
 * A port only where the ecosystem has one convention. Elsewhere a placeholder that cannot be
 * mistaken for a working value: a confident wrong port produces a serve block that fails to
 * boot, and a failing boot short-circuits every check after it.
 */
const readyUrlFor = cmd => {
  if (!cmd) return 'http://localhost:<port>'
  if (/^python3? manage\.py/.test(cmd)) return 'http://localhost:8000'
  if (cmd.startsWith('npm run')) return 'http://localhost:3000'
  return 'http://localhost:<port>'
}

const serveBlock = cmd => `#
# ${cmd ? `This project starts with \`${cmd}\`. Uncomment` : 'To add http or browser checks, uncomment'} the block below and confirm the port.
# Relative paths in http and browser checks resolve against ready_url:
#
# serve:
#   run: ${cmd ?? '<your dev command>'}
#   ready_url: ${readyUrlFor(cmd)}
#   timeout: 60
`

const header = (n, serveCommand) => `# Acceptance contract. Edit freely — this file is the definition of "done".
#
# Verbs:
#   run:  <shell command>          expect_exit: 0   expect_output: "substring"
#   http: {method, path|url, headers, body, expect: {status, body_contains, body_not_contains, json}}
#   file: <path>  |  {path, exists, contains, not_contains}
#   env:  <NAME>  |  {name, matches}
#   browser: {visit, flow: [...]}
${serveBlock(serveCommand)}#
${n ? '' : '# No project commands were auto-discovered — replace the placeholder below.\n#\n'}`
