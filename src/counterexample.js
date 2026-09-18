// What proof learned the hard way, kept.
//
// A counterexample is the one artifact in this tool that is worth more the older it gets: a
// concrete, reproducible scenario under which the contract said yes and the requirement was not
// met. `challenge` produces them from faults you named; `attack` produces them from scenarios it
// searched for. They land in the same place, they replay the same way, and `promote` turns
// either into a permanent check — so a contract that was caught being weak once cannot be weak
// in the same way twice.
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { loadSpec, PROOF_DIR, SPEC_PATH, withSpecLock, writeError, writeFileAtomic } from './spec.js'
import { block } from './terminal.js'

export const COUNTEREXAMPLES = join(PROOF_DIR, 'counterexamples')

/** The check body `proof promote` writes for a fault. Held to the same rule as every placeholder. */
export const PROMOTED_RUN = 'echo "TODO: assert the behaviour this fault broke"'

export const pathOf = id => join(COUNTEREXAMPLES, `${String(id).replace(/\.ya?ml$/, '')}.yaml`)

export function save(body) {
  const file = pathOf(body.id)
  try {
    mkdirSync(COUNTEREXAMPLES, { recursive: true })
    writeFileAtomic(file, YAML.stringify(body))
  } catch (e) {
    throw writeError(e, file, 'the counterexample',
      'It is the record of something this contract accepted; `proof promote` turns it into a check.')
  }
  return file
}

export function read(id) {
  try {
    return YAML.parse(readFileSync(pathOf(id), 'utf8'))
  } catch { return null }
}

export const list = () => {
  try {
    return readdirSync(COUNTEREXAMPLES).filter(f => f.endsWith('.yaml')).map(f => f.replace(/\.yaml$/, ''))
  } catch { return [] }
}

/**
 * How a counterexample was found, which decides what promoting it can produce.
 *
 * A fault is a command someone wrote; proof knows what it broke and cannot know what assertion
 * would have caught it. A scenario is steps proof executed itself, so promoting one can write a
 * check that runs it again — the difference between a placeholder and a working check.
 */
export const kindOf = example => (example?.apply ? 'fault' : example?.steps ? 'scenario' : 'unknown')

/**
 * A replay's outcome, written back beside the counterexample.
 *
 * Never deleted on a non-reproduction: a scenario that no longer reproduces is either a bug that
 * was fixed — the thing you want a record of — or one that only shows up sometimes, which is
 * worse news than a deterministic one and should not be thrown away for looking like good news.
 */
export function markReplay(id, result) {
  const example = read(id)
  if (!example) return null
  return save({ ...example, last_replay: { at: new Date().toISOString(), ...result } })
}

const promotedName = example => `counterexample: ${example.challenge ?? example.hypothesis ?? example.id}`

/**
 * A counterexample, promoted into the contract.
 *
 * A fault becomes a check holding proof's own placeholder: proof knows which fault went
 * unnoticed and cannot know what assertion would notice it, and `proof check` refuses a contract
 * with a placeholder in it, so the gap cannot sit there looking like coverage.
 *
 * A scenario becomes a check that replays it. That one is complete on its own — the steps, the
 * invariant and the observation are all on disk — and it passes exactly when the scenario stops
 * reproducing.
 */
export function promote({ id, json = false, specPath } = {}) {
  const available = list()
  if (!id) {
    throw Object.assign(
      new Error(available.length
        ? `proof promote <counterexample> — have: ${available.join(', ')}`
        : 'no counterexamples recorded yet — `proof challenge` writes one for every fault the contract'
          + ' missed, and `proof attack` for every scenario it found'),
      { code: 'EUSAGE' })
  }
  if (!existsSync(pathOf(id))) {
    throw Object.assign(
      new Error(`no counterexample "${id}"${available.length ? ` (have: ${available.join(', ')})` : ''}`),
      { code: 'ENOCOUNTEREXAMPLE' })
  }

  const example = read(id)
  const kind = kindOf(example)
  if (kind === 'unknown') {
    throw Object.assign(
      new Error(`${pathOf(id)} is not a counterexample proof wrote — it has neither an \`apply\` command`
        + ' nor the steps of a scenario, so there is nothing to promote'),
      { code: 'ENOCOUNTEREXAMPLE' })
  }

  const path = specPath ?? SPEC_PATH
  loadSpec(path)                                   // a contract that does not validate is not editable
  const name = promotedName(example)

  const added = withSpecLock(() => {
    const doc = YAML.parseDocument(readFileSync(path, 'utf8'))
    const checks = doc.get('checks')
    if (!checks?.add) throw new Error(`${path} has no checks list to append to`)
    if (checks.items.some(item => String(item.get?.('name') ?? '') === name)) return false

    const check = kind === 'fault'
      ? { name, run: PROMOTED_RUN }
      : { name, run: `proof replay ${example.id}` }
    const criteria = example.criteria ?? (example.criterion ? [example.criterion] : [])
    if (criteria.length) check.satisfies = criteria

    const node = doc.createNode(check)
    node.commentBefore = kind === 'fault'
      ? ` This fault went unnoticed by every check: ${example.apply}\n`
        + ` Recorded ${example.found_at} against ${String(example.commit ?? '').slice(0, 12)}.\n`
        + ' Replace the command with the assertion that would have caught it.'
      : ` ${example.hypothesis ?? 'A scenario the contract accepted'}\n`
        + ` ${example.invariant ?? ''} — observed ${example.result ?? 'a violation'}.\n`
        + ` Recorded ${example.found_at} against ${String(example.commit ?? '').slice(0, 12)}.\n`
        + ' This passes once the scenario no longer reproduces.'
    checks.add(node)
    writeFileAtomic(path, doc.toString())
    return true
  })

  const out = { status: added ? 'promoted' : 'already-present', counterexample: pathOf(id), spec: path, check: name, kind }
  if (json) console.log(JSON.stringify(out, null, 2))
  else if (!added) console.log(`\n${path} already has a check named "${name}" — nothing changed.\n`)
  else if (kind === 'fault') {
    console.log(`\nAdded "${name}" to ${path}.`)
    console.log(block('It holds proof\'s own placeholder command, so `proof check` will refuse the contract'
      + ' until you replace it with the assertion that catches this fault. That assertion is the thing'
      + ' proof cannot write for you.', '  '))
    console.log('')
  } else {
    console.log(`\nAdded "${name}" to ${path}.`)
    console.log(block(`It runs \`proof replay ${example.id}\`, which executes the scenario again and`
      + ' passes only while the invariant holds. Fix the behaviour and the check goes green; the'
      + ' contract is then permanently stronger than the one that accepted it.', '  '))
    console.log(block('The check needs `proof` on PATH, the way CI runs it. Where it is not, make the'
      + ' command `npx proof replay …` or whatever invokes proof in this project.', '  '))
    console.log('')
  }
  return 0
}
