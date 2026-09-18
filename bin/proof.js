#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { TERMINAL_WIDTH, wrap } from '../src/terminal.js'

// One category for "the invocation is wrong", so an agent can tell a mistake it made from a
// problem with the project. Everything below is a fixable command line, not a failed check.
const usage = message => Object.assign(new Error(message), { code: 'EUSAGE' })
import { init } from '../src/spec.js'
import { check } from '../src/check.js'
import { report, prune } from '../src/report.js'
import { guard } from '../src/guard.js'
import { changed } from '../src/changed.js'
import { suggest } from '../src/validate.js'
import { GLOBAL_FLAGS, COMMAND_FLAGS, VALUE_FLAGS, POSITIONALS } from '../src/cli.js'
import { infer } from '../src/infer.js'
import { lint } from '../src/lint.js'
import { falsify } from '../src/falsify.js'
import { hook } from '../src/hook.js'
import { seal, diff } from '../src/seal.js'
import { challenge } from '../src/challenge.js'
import { attack, replay, parseBudget } from '../src/attack.js'
import { promote } from '../src/counterexample.js'
import { done } from '../src/done.js'

const USAGE = `proof — verification CLI for AI coding agents

  proof init "<requirement>"   create an acceptance contract at .proof/spec.yaml
  proof infer                  find verification gaps in the current diff
  proof changed                blast radius of the current diff vs its checks
  proof lint                   what the contract would prove, without running it
  proof seal                   fingerprint the contract, so a later edit to it is visible
  proof diff                   what the contract has changed since it was sealed
  proof falsify                run the contract against the code before your change — it must fail
  proof check                  execute the contract
  proof challenge              inject faults into a copy of your code — the contract must catch them
  proof attack [<criterion>]   search for a scenario where the contract passes and the claim does not
  proof replay <id>            run a recorded counterexample again
  proof promote <id>           turn a counterexample the contract missed into a check
  proof done                   the completion gate: the whole verification chain, in one verdict
  proof report [run]           render the evidence for a run (default: latest)
  proof guard -- <agent...>    supervise an agent: rerun it until the contract passes
  proof hook                   Claude Code Stop hook: refuse to finish until the contract passes
  proof help                   this text
  proof --version              the installed version

  --json        machine-readable output
  --force       overwrite an existing spec (init)
  --write       append inferred checks to the spec (infer)
  --list        list recorded runs (report)
  --all         with --list, show every run rather than the recent ones (report)
  --prune       delete all but the most recent runs (report)
  --keep <n>    with --prune, how many runs to keep (report; default 20)
  --only TEXT   run only checks whose name contains TEXT (check)
  --base-url U  verify an app already running at U instead of starting one (check)
  --junit       render a run as JUnit XML for CI (report)
  --install     add the Stop hook to .claude/settings.json (hook)
  --print       show the settings snippet instead of installing it (hook)
  --max-attempts N  stop after N agent runs (guard: default until it passes; hook: default 5)
  --spec PATH   contract path (init/check/changed/infer/guard/lint/hook/falsify/seal/diff/challenge/attack/replay/promote/done)
  --depth N     import-graph hops to follow (changed/infer, default 1)
  --base REF    diff against REF instead of HEAD (changed/infer/falsify)
  --from CMD    read candidates from a command that prints them as JSON (challenge/attack)
  --budget T    how long one criterion's search may take, like 90s or 5m (attack)
  --seed N      fix the search order, so a run can be repeated exactly (attack)
  --strategy S  run one surface only: input, sequence or concurrency (attack)

exit codes: 0 passed, 1 failed, 2 configuration error

\`proof check\` reports what the contract did. \`proof done\` reports whether the
evidence justifies calling the work finished — coverage, falsification,
challenges and contract integrity — and exits non-zero unless the verdict is DONE.

A --only run reports INCOMPLETE, never DONE: completion is a claim about the
whole contract. Use it to iterate, then run a full \`proof check\`.
`

// Read, not imported: an import attribute pins this file to a JSON-module syntax that has
// moved more than once, and the file is two directories up in every install layout.
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0'
  } catch { return '0.0.0' }
})()

const rawArgv = process.argv.slice(2)
const cmd = rawArgv[0]

// Everything after `--` belongs to the supervised agent, verbatim — its flags are not
// proof's to police. Without the separator, an agent flag would hit the unknown-flag
// refusal, which is the right failure but needs to point at the fix.
const sep = cmd === 'guard' ? rawArgv.indexOf('--') : -1
const argv = sep === -1 ? rawArgv : rawArgv.slice(0, sep)
const passthrough = sep === -1 ? [] : rawArgv.slice(sep + 1)

// An ignored flag is a silent misreading of the request: `--dry-run` would run for real,
// and `--only` with its value forgotten would run the whole contract while reporting a
// complete verdict. Neither is something to guess at.
function parseArgs() {
  const allowed = [...GLOBAL_FLAGS, ...(COMMAND_FLAGS[cmd] ?? [])]
  const flags = {}
  const args = []

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) { args.push(token); continue }

    const [name, inline] = token.slice(2).split(/=(.*)/s)
    if (!allowed.includes(name)) {
      const hint = suggest(name, allowed)
      const guardHint = cmd === 'guard'
        ? `\n  if --${name} belongs to the agent, put the whole command after \`--\`: proof guard -- ${argv.slice(1).join(' ')}`
        : ''
      throw usage(`unknown flag --${name}${hint ? ` — did you mean --${hint}?` : ''}`
        + `\n  ${cmd ? `\`proof ${cmd}\`` : 'this command'} accepts: ${allowed.map(f => `--${f}`).join(', ')}${guardHint}`)
    }

    if (inline !== undefined) {
      if (VALUE_FLAGS.has(name) && inline === '') throw usage(emptyValue(name))
      flags[name] = inline
      continue
    }
    if (!VALUE_FLAGS.has(name)) { flags[name] = true; continue }

    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) {
      throw usage(`--${name} needs a value (use --${name}=<value> if it starts with "--")`)
    }
    if (value === '') throw usage(emptyValue(name))
    flags[name] = value
  }
  return { flags, args }
}

// An empty value is not a value, and `--only ""` was the expensive case: every check name
// contains the empty string, so the flag selected the whole contract and the run reported
// DONE — the completion claim `--only` exists to withhold.
const emptyValue = name => `--${name} was given an empty value`
  + `\n  ${name === 'only' ? 'pass the text a check name must contain, or drop the flag to run everything'
    : 'pass a value, or drop the flag'}`

// How many bare arguments each command takes. A dropped positional is the same silent
// misreading as a dropped flag: `proof check alpha` ran the entire contract and reported
// DONE to someone who meant to run one check.
function checkPositionals(args) {
  const rule = POSITIONALS[cmd]
  if (!rule || args.length <= rule.max) return

  const extra = args.slice(rule.max)
  const hint = rule.hint ? ` — ${rule.hint(extra[0])}` : ''
  throw usage(`unexpected argument${extra.length > 1 ? 's' : ''} ${extra.map(a => `"${a}"`).join(', ')}${hint}`
    + `\n  usage: ${rule.usage}`)
}

// A bad --depth used to reach the scanner as NaN, which walks nothing and reports
// "none found (import scan, depth NaN)" — a typo answered with an empty result.
const positiveInt = (value, name, fallback) => {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw usage(`--${name} must be a positive whole number (got "${value}")`)
  return n
}

// Read before parsing: a caller asking for JSON must get JSON even when the failure is
// in the arguments themselves.
let json = argv.includes('--json')

try {
  const { flags, args } = parseArgs()
  json = flags.json === true
  checkPositionals(args)

  switch (cmd) {
    case 'init':
      init(args.join(' '), { json, force: flags.force === true, specPath: flags.spec })
      break
    case 'infer':
      process.exitCode = infer({ json, write: flags.write === true, depth: positiveInt(flags.depth, 'depth', 1), base: flags.base ?? 'HEAD', specPath: flags.spec })
      break
    case 'changed':
      process.exitCode = changed({ json, depth: positiveInt(flags.depth, 'depth', 1), base: flags.base ?? 'HEAD', specPath: flags.spec })
      break
    case 'check':
      process.exitCode = await check({ json, only: flags.only, specPath: flags.spec, baseUrl: flags['base-url'] })
      break
    case 'guard':
      process.exitCode = await guard({
        command: [...args, ...passthrough],
        maxAttempts: flags['max-attempts'] === undefined ? Infinity : positiveInt(flags['max-attempts'], 'max-attempts', Infinity),
        specPath: flags.spec,
        json,
      })
      break
    case 'lint':
      process.exitCode = lint({ json, specPath: flags.spec })
      break
    case 'falsify':
      process.exitCode = falsify({ json, specPath: flags.spec, base: flags.base ?? 'HEAD' })
      break
    case 'seal':
      process.exitCode = seal({ json, specPath: flags.spec })
      break
    case 'diff':
      process.exitCode = diff({ json, specPath: flags.spec })
      break
    case 'challenge':
      process.exitCode = challenge({ json, specPath: flags.spec, from: flags.from })
      break
    case 'attack':
      process.exitCode = await attack({
        json,
        criterion: args[0],
        budget: parseBudget(flags.budget),
        seed: flags.seed === undefined ? undefined : positiveInt(flags.seed, 'seed', undefined),
        strategy: flags.strategy,
        from: flags.from,
        specPath: flags.spec,
      })
      break
    case 'replay':
      process.exitCode = await replay({ json, id: args[0], specPath: flags.spec })
      break
    case 'promote':
      process.exitCode = promote({ json, id: args[0], specPath: flags.spec })
      break
    case 'done':
      process.exitCode = done({ json, specPath: flags.spec })
      break
    case 'hook':
      if (flags.install === true && flags.print === true) throw usage('--install and --print are alternatives — pick one')
      process.exitCode = await hook({
        install: flags.install === true,
        print: flags.print === true,
        maxAttempts: positiveInt(flags['max-attempts'], 'max-attempts', 5),
        specPath: flags.spec,
        json,
      })
      break
    case 'report':
      // Same rule as an unknown flag: a flag that does nothing is a silently misread request.
      // `proof report --keep 5` reads as "prune to five" and rendered the latest report instead.
      if (flags.keep !== undefined && flags.prune !== true) throw usage('--keep only applies with --prune — `proof report --prune --keep 5`')
      if (flags.all === true && flags.list !== true) throw usage('--all only applies with --list — `proof report --list --all`')
      process.exitCode = flags.prune === true
        ? prune({ json, keep: positiveInt(flags.keep, 'keep', 20) })
        : report({ json, run: args[0], list: flags.list === true, all: flags.all === true, junit: flags.junit === true })
      break
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(USAGE)
      break
    // How anyone reporting a bug says which proof they ran, and the first thing typed after
    // installing. It answered `unknown command "--version"` — which is not even a command.
    case '-v':
    case '--version':
      console.log(VERSION)
      break
    default:
      throw usage(cmd.startsWith('-')
        ? `unknown flag "${cmd}" — it is not a command either\n\n${USAGE}`
        : `unknown command "${cmd}"\n\n${USAGE}`)
  }
} catch (e) {
  // `problems` as a list, not only embedded in the message: an agent fixing a contract wants
  // them one at a time, and re-parsing `  - ` out of a multi-line string is a parser nobody
  // should have to write against a tool built for agents.
  if (json) {
    console.log(JSON.stringify({
      status: 'error',
      // The category, so an agent branches on a value rather than on the wording of a
      // sentence proof is free to reword.
      ...(e.code ? { code: e.code } : {}),
      error: e.message,
      ...(Array.isArray(e.problems) ? { problems: e.problems } : {}),
      // Separate from `problems`: these are not validation errors, they are the next refusal
      // waiting behind this one. An agent fixing the contract wants both in one pass.
      ...(Array.isArray(e.placeholders) && e.placeholders.length ? { placeholders: e.placeholders } : {}),
    }, null, 2))
  }
  // Errors explain what to do next, and the useful half was running off the screen. The
  // usage text is pre-formatted, so only wrap the lines that are prose.
  else console.error(`proof: ${e.message}`.split('\n').flatMap(line => {
    if (line.length <= TERMINAL_WIDTH) return [line]
    // Keep the line's own indent: wrap() splits on whitespace, so the "  - " of a list of
    // contract problems was dropped and every continuation started at column zero.
    const indent = line.match(/^\s*/)[0]
    return wrap(line.trim(), TERMINAL_WIDTH - indent.length).map(l => indent + l)
  }).join('\n'))
  process.exitCode = 2
}
