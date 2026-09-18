// The completion gate, native to Claude Code.
//
// `guard` wraps an agent from the outside and reruns it until the contract passes. Claude Code
// already has a place for exactly that decision — a Stop hook runs when the agent believes it
// is finished, and can refuse to let it stop. `proof hook` is `guard` turned inside out: the
// agent's own loop calls proof, and proof answers "not yet" with the evidence attached.
//
// Nothing here parses the agent's transcript or judges its work. The contract runs; the exit
// code decides; the same feedback `guard` writes is what the agent reads next.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSpec, PROOF_DIR, SPEC_PATH, writeFileAtomic } from './spec.js'
import { runCheck, renderFeedback, FEEDBACK } from './guard.js'

const STATE = join(PROOF_DIR, 'hook-state.json')
const SETTINGS = join('.claude', 'settings.json')

/** How many times the hook refuses a stop before letting the agent go with the evidence. */
export const DEFAULT_MAX_ATTEMPTS = 5

// Bounded, and above the default: a Stop hook is killed at 60 seconds by default, and a
// contract that boots an app and drives a browser is routinely longer than that. A hook killed
// mid-run lets the agent stop with no verdict at all — the one outcome the gate exists to prevent.
export const HOOK_TIMEOUT_SEC = 900

export const hookEntry = (maxAttempts = DEFAULT_MAX_ATTEMPTS, specPath) => ({
  hooks: [{
    type: 'command',
    command: `proof hook --max-attempts ${maxAttempts}${specPath ? ` --spec ${specPath}` : ''}`,
    timeout: HOOK_TIMEOUT_SEC,
  }],
})

export const snippet = (maxAttempts, specPath) =>
  JSON.stringify({ hooks: { Stop: [hookEntry(maxAttempts, specPath)] } }, null, 2)

const isOurs = entry => (entry?.hooks ?? []).some(h => typeof h?.command === 'string' && /^proof hook\b/.test(h.command))

/**
 * Add the Stop hook to the project's Claude Code settings.
 *
 * Merged, never overwritten: the file is the user's, and it holds every other hook and
 * permission they configured. A file that will not parse is refused rather than replaced —
 * a settings file proof rewrote is a settings file proof now owns.
 */
export function install({ maxAttempts, specPath, json = false } = {}) {
  let settings = {}
  if (existsSync(SETTINGS)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS, 'utf8'))
    } catch (e) {
      throw Object.assign(
        new Error(`${SETTINGS} is not valid JSON (${e.message}) — fix it, or add the hook by hand:\n${snippet(maxAttempts, specPath)}`),
        { code: 'EBADSETTINGS' })
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw Object.assign(new Error(`${SETTINGS} is not a JSON object`), { code: 'EBADSETTINGS' })
    }
  }

  settings.hooks ??= {}
  settings.hooks.Stop ??= []
  const already = settings.hooks.Stop.some(isOurs)
  if (!already) settings.hooks.Stop.push(hookEntry(maxAttempts, specPath))

  mkdirSync('.claude', { recursive: true })
  if (!already) writeFileAtomic(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`)

  const out = { status: already ? 'already-installed' : 'installed', settings: SETTINGS, max_attempts: maxAttempts }
  if (json) console.log(JSON.stringify(out, null, 2))
  else if (already) console.log(`\n${SETTINGS} already runs \`proof hook\` on Stop — nothing changed.\n`)
  else {
    console.log(`\nwrote ${SETTINGS}`)
    console.log('Claude Code now runs the contract every time it believes it is finished. A failing contract'
      + `\nsends the evidence back and keeps it working — up to ${maxAttempts} time(s), then it may stop with`
      + '\nthe evidence in .proof/feedback.md.\n')
    console.log('The hook is a no-op in a directory with no contract, so it is safe to leave installed.\n')
    // The hook enforces the contract; the skill is how one gets written in the first place.
    console.log('For the other half — teaching the agent to write the contract before the code —')
    console.log('copy skills/proof/SKILL.md from the proof repository into .claude/skills/proof/.\n')
  }
  return 0
}

const readState = () => {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return { attempts: 0 } }
}
const clearState = () => {
  for (const f of [STATE, FEEDBACK]) { try { unlinkSync(f) } catch { /* never written */ } }
}

/** Whatever Claude Code sent on stdin. Tolerated when absent, so the hook can be run by hand. */
const readStdin = () => {
  try {
    const raw = readFileSync(0, 'utf8').trim()
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

/**
 * The Stop hook itself.
 *
 * Exit 0 with nothing printed lets the agent stop. Exit 0 with `{"decision": "block", "reason"}`
 * refuses, and Claude Code hands the reason to the agent as its next instruction. The reason is
 * the same feedback `guard` writes: the requirement, each failure's expected and observed, the
 * regression marker, and where the full evidence is.
 */
export async function stopHook({ maxAttempts = DEFAULT_MAX_ATTEMPTS, specPath } = {}) {
  readStdin()   // consumed so the pipe closes; nothing in it changes the decision

  // No contract, no opinion. Installed in a user's global settings this runs in every project,
  // and most of them have nothing for it to enforce.
  if (!existsSync(specPath ?? SPEC_PATH)) return 0

  // The same refusals `guard` makes before its first launch, for the same reason: a contract
  // that can never pass would block every stop until the attempts ran out, for nothing the
  // agent did. Letting it stop with the reason on stderr is the honest outcome.
  try {
    const spec = loadSpec(specPath)
    const off = (spec.checks ?? []).filter(c => c?.skip !== undefined)
    if (off.length) {
      console.error(`proof: ${off.length} check(s) are skipped in the contract, so no run can report completion — not gating this stop`)
      return 0
    }
  } catch (e) {
    console.error(`proof: the contract cannot be run — ${e.message.split('\n')[0]}`)
    return 0
  }

  const result = runCheck(specPath)
  if (result.config) {
    console.error(`proof: ${result.error}`)
    return 0
  }

  if (result.status === 'passed') {
    clearState()
    console.error(`proof: contract passed — ${result.run ?? ''}`.trim())
    return 0
  }

  const state = readState()
  const attempt = (state.attempts ?? 0) + 1
  const feedback = renderFeedback(result, attempt)
  mkdirSync(PROOF_DIR, { recursive: true })
  writeFileSync(FEEDBACK, feedback)

  if (attempt > maxAttempts) {
    // The override, as `--max-attempts` is for guard. Let it stop, say why, and leave the
    // evidence where the next human or agent will look. The counter resets so the next
    // session starts its own budget.
    clearState()
    writeFileSync(FEEDBACK, feedback)
    console.error(`proof: contract still fails after ${maxAttempts} attempt(s) — letting the agent stop. Evidence: ${FEEDBACK}`)
    return 0
  }

  writeFileAtomic(STATE, JSON.stringify({ attempts: attempt, run: result.run ?? null }))
  const failed = (result.failures ?? []).map(f => f.check).join(', ')
  console.log(JSON.stringify({
    decision: 'block',
    reason: `proof check: NOT DONE (attempt ${attempt} of ${maxAttempts}) — ${result.failures?.length ?? '?'} check(s) failed: ${failed}.\n\n${feedback}`,
  }))
  return 0
}

export async function hook({ install: doInstall = false, print = false, maxAttempts = DEFAULT_MAX_ATTEMPTS, specPath, json = false } = {}) {
  if (print) {
    console.log(snippet(maxAttempts, specPath))
    return 0
  }
  if (doInstall) return install({ maxAttempts, specPath, json })
  return stopHook({ maxAttempts, specPath })
}
