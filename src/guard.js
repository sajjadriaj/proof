import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSpec, PROOF_DIR } from './spec.js'
import { placeholderChecks } from './validate.js'
import { TERMINAL_WIDTH, wrap } from './terminal.js'

const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const FEEDBACK = join(PROOF_DIR, 'feedback.md')

/**
 * The completion gate. The agent decides nothing about doneness: it runs, and when it
 * exits — its attempt at completion — the contract runs. Pass ends the loop; fail writes
 * the evidence where the next attempt will look and launches the agent again.
 *
 * The overrides are explicit, as the spec asks: Ctrl-C, or `--max-attempts`. Nothing else
 * ends the loop early except a broken contract — that is the human's definition of done to
 * repair, and relaunching an agent at it would burn attempts against a wall proof already
 * knows about.
 */
export async function guard({ command, maxAttempts = Infinity, specPath, json = false } = {}) {
  if (!command?.length) {
    throw Object.assign(
      new Error('guard needs the agent command to supervise — `proof guard -- <command...>`'),
      { code: 'EUSAGE' })
  }

  // Fail before the first launch, not after it. loadSpec throws the usual coded errors for
  // a missing or invalid contract; a placeholder would make `check` refuse every attempt,
  // which from the loop's outside looks like an agent that cannot finish.
  const spec = loadSpec(specPath)
  const waiting = placeholderChecks(spec)
  if (waiting.length) {
    throw Object.assign(
      new Error(`the contract still holds proof's own placeholder command`
        + ` (${waiting.map(c => c.name ?? `check[${c.i}]`).join(', ')}) — every attempt would be`
        + ' refused. Replace it with the command that proves the requirement, then guard.'),
      { code: 'EUNFINISHED' })
  }

  const say = line => console.log(wrap(line, TERMINAL_WIDTH).join('\n'))
  let feedback = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    say(`\nGUARD  attempt ${attempt}${Number.isFinite(maxAttempts) ? ` of ${maxAttempts}` : ''}`
      + ` — running: ${command.join(' ')}`)

    const agent = await runAgent(command, { attempt, feedback })
    if (agent.signal) {
      // Ctrl-C lands on the whole foreground group, and an agent killed any other way did
      // not attempt completion — treat both as the explicit override, not as a failure to fix.
      say(`\nGUARD  the agent was ended by ${agent.signal} — stopping without a verdict.`)
      return finish(json, { status: 'aborted', attempts: attempt, reason: `agent ${agent.signal}` }, 1)
    }

    const result = runCheck(specPath)
    if (result.config) {
      // exit 2: the contract itself is wrong. Possibly the agent rewrote it — either way it
      // is not something to iterate an agent against.
      console.error(`proof: ${result.error}`)
      return finish(json, { status: 'aborted', attempts: attempt, reason: 'contract error' }, 2)
    }

    if (result.status === 'passed') {
      try { rmSync(FEEDBACK) } catch { /* never written, or already gone */ }
      say(`\nGUARD  DONE after ${attempt} attempt(s) — the contract passed.`)
      say(`  evidence: ${result.run ?? '(see .proof/runs)'}`)
      return finish(json, { status: 'passed', attempts: attempt, run: result.run ?? null }, 0)
    }

    feedback = renderFeedback(result, attempt)
    writeFileSync(FEEDBACK, feedback)
    const names = (result.failures ?? []).map(f => f.check).join(', ')
    say(`\nGUARD  NOT DONE — ${result.failures?.length ?? '?'} failed (${names}).`
      + ` Evidence written to ${FEEDBACK}; relaunching the agent with it.`)
  }

  say(`\nGUARD  ${maxAttempts} attempt(s) used and the contract still fails.`
    + ' Raise --max-attempts to continue, or read the evidence and fix by hand.')
  return finish(json, { status: 'failed', attempts: maxAttempts, run: null }, 1)
}

function finish(json, summary, code) {
  if (json) console.log(JSON.stringify(summary))
  return code
}

/**
 * One agent session, interactive: the agent owns the terminal while it runs. Feedback
 * travels every way an agent might read it — `{feedback}` / `{feedback_file}` substituted
 * into its own arguments, and PROOF_GUARD_* in its environment for the ones that look there.
 */
function runAgent(command, { attempt, feedback }) {
  const args = command.map(a => a
    .replaceAll('{feedback}', feedback ?? '(first attempt — no verification has run yet)')
    .replaceAll('{feedback_file}', FEEDBACK))

  return new Promise(resolve => {
    const p = spawn(args[0], args.slice(1), {
      stdio: 'inherit',
      env: {
        ...process.env,
        PROOF_GUARD: '1',
        PROOF_GUARD_ATTEMPT: String(attempt),
        PROOF_GUARD_FEEDBACK: FEEDBACK,
      },
    })
    p.on('error', e => resolve({ error: e }))
    p.on('exit', (code, signal) => resolve({ code, signal }))
  }).then(r => {
    if (r.error) {
      throw Object.assign(
        new Error(`could not run the agent: ${args[0]} — ${r.error.code === 'ENOENT' ? 'not found on PATH' : r.error.message}`),
        { code: 'EUSAGE' })
    }
    return r
  })
}

// The CLI, not an in-process call: guard is exactly the generic agent loop the spec draws,
// and running `proof check --json` keeps it on the same interface every other agent uses.
function runCheck(specPath) {
  const r = spawnSync(process.execPath,
    [CLI, 'check', '--json', ...(specPath ? ['--spec', specPath] : [])],
    { encoding: 'utf8' })

  let out
  try { out = JSON.parse(r.stdout) } catch {
    return { config: true, error: `check produced no verdict:\n${(r.stdout + r.stderr).trim()}` }
  }
  if (r.status === 2 || out.status === 'error') return { config: true, error: out.error ?? 'contract error' }
  return { ...out, run: out.run ?? null }
}

const tail = (text, n) => String(text).split('\n').slice(-n).join('\n')

/** What the next attempt reads first. The same facts `check` printed, kept compact. */
function renderFeedback(result, attempt) {
  const lines = [
    `# Verification failed (attempt ${attempt})`,
    '',
    `Requirement: ${result.goal ?? '(unknown)'}`,
    '',
    'The acceptance contract did not pass. Fix the code until it does — the checks below are',
    'the definition of done, not suggestions.',
    '',
  ]
  for (const f of result.failures ?? []) {
    lines.push(`## ${f.check}`, '')
    if (f.expected) lines.push(`- Expected: ${f.expected}`)
    if (f.observed) lines.push(`- Observed: ${f.observed}`)
    if (f.was === 'passed') lines.push(`- Regression: this passed in run ${f.since} — the recent changes broke it`)
    if (f.output) lines.push('', '```', tail(f.output, 20), '```')
    lines.push('')
  }
  for (const w of result.warnings ?? []) lines.push(`> ${w}`, '')
  if (result.run) lines.push(`Full evidence: ${result.run} (\`proof report\` renders it).`)
  return lines.join('\n') + '\n'
}
