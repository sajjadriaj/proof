import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { validateSpec, VERBS } from '../src/validate.js'
import { STEP_VERBS } from '../src/browser.js'
import { TYPE_TOKENS } from '../src/json-match.js'
import { GLOBAL_FLAGS, COMMAND_FLAGS, COMMANDS } from '../src/cli.js'
import { ADVISORY } from '../src/check.js'
import { EVIDENCE_NOTICE } from '../src/runs.js'
import { TESTS_CHANGED_NOTICE } from '../src/diff.js'
import { CONTRACT_CHANGED_NOTICE } from '../src/spec.js'
import { ALLOWED } from '../src/validate.js'

const root = join(import.meta.dirname, '..')
// The corpus is the README plus everything under docs/ — the reference moved there, and
// a drift guard that stops at the front page would miss exactly the pages that drift.
const README = [join(root, 'README.md'),
  ...readdirSync(join(root, 'docs')).filter(f => f.endsWith('.md')).map(f => join(root, 'docs', f))]
  .map(f => readFileSync(f, 'utf8')).join('\n\n')
const USAGE = readFileSync(join(root, 'bin/proof.js'), 'utf8')

const yamlBlocks = () => [...README.matchAll(/```yaml\n([\s\S]*?)```/g)].map(m => m[1])

test('every contract shown in the README is one proof would accept', () => {
  const contracts = yamlBlocks()
    .map((body, i) => ({ i, doc: YAML.parse(body) }))
    .filter(({ doc }) => doc && typeof doc === 'object' && !Array.isArray(doc) && ('checks' in doc || 'goal' in doc))

  assert.ok(contracts.length > 0, 'the README documents at least one full contract')

  for (const { i, doc } of contracts) {
    assert.deepEqual(validateSpec(doc), [], `README yaml block ${i} is not a valid contract`)
  }
})

test('every yaml block in the README at least parses', () => {
  for (const [i, body] of yamlBlocks().entries()) {
    assert.doesNotThrow(() => YAML.parse(body), `README yaml block ${i} is not valid YAML`)
  }
})

test('every verb is documented', () => {
  for (const verb of VERBS) {
    assert.match(README, new RegExp(`\\| \`${verb}\` \\|`), `verb \`${verb}\` is missing from the README verb table`)
  }
})

test('every browser step verb is documented', () => {
  for (const step of STEP_VERBS) {
    assert.match(README, new RegExp(`\`${step}\``), `browser step \`${step}\` is undocumented`)
  }
})

test('every json type token is documented', () => {
  for (const token of TYPE_TOKENS) {
    assert.match(README, new RegExp(`\`${token.replace(/[<>]/g, m => `\\${m}`)}\``), `${token} is undocumented`)
  }
})

test('every command appears in the usage text', () => {
  for (const command of COMMANDS) {
    assert.match(USAGE, new RegExp(`proof ${command}`), `\`${command}\` is missing from --help`)
    assert.match(README, new RegExp(`proof ${command}`), `\`${command}\` is missing from the README`)
  }
})

test('the usage text lists exactly the flags the parser accepts', () => {
  const documented = new Set([...USAGE.matchAll(/^ {2}--(\w[\w-]*)/gm)].map(m => m[1]))
  const real = new Set([...GLOBAL_FLAGS, ...Object.values(COMMAND_FLAGS).flat()])

  for (const flag of real) assert.ok(documented.has(flag), `--${flag} is accepted but not in --help`)
  for (const flag of documented) assert.ok(real.has(flag), `--${flag} is in --help but rejected by the parser`)
})

test('each flag is attributed to the command that actually accepts it', () => {
  for (const [command, flags] of Object.entries(COMMAND_FLAGS)) {
    for (const flag of flags) {
      const line = USAGE.split('\n').find(l => l.trimStart().startsWith(`--${flag} `))
      assert.ok(line, `--${flag} has no usage line`)
      assert.match(line, new RegExp(`\\(([^)]*\\b${command}\\b[^)]*)\\)`),
        `--${flag} is accepted by \`${command}\` but its usage line does not say so: ${line.trim()}`)
    }
  }
})

test('exit codes are documented as the CLI implements them', () => {
  assert.match(USAGE, /exit codes: 0 passed, 1 failed, 2 configuration error/)
  assert.match(README, /`0` passed, `1` failed, `2` configuration error/)
})

// --- the agent-facing JSON contract -----------------------------------------

/** The field table for one command's --json payload. */
const documentedJsonFields = (command = 'proof check') => {
  const after = README.split(`### Every field of \`${command} --json\``)[1] ?? ''
  const section = after.split('\n### ')[0].split('\n## ')[0]
  return new Set([...section.matchAll(/^\| `(\w+)` \|/gm)].map(m => m[1]))
}

test('every field proof emits in --json is documented', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { check } = await import('../src/check.js')

  const dir = mkdtempSync(join(tmpdir(), 'proof-jsondoc-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'json shape',
    checks: [{ name: 'alpha', run: 'true' }, { name: 'bravo', run: 'exit 1' }],
  }))

  let printed = ''
  const real = console.log
  console.log = s => { printed += s }
  try { await check({ json: true }) } finally { console.log = real }

  const emitted = Object.keys(JSON.parse(printed))
  const documented = documentedJsonFields()

  for (const field of emitted) {
    assert.ok(documented.has(field), `--json emits "${field}" but the README does not document it`)
  }
})

test('every documented --json field is one proof actually emits', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { check } = await import('../src/check.js')
  const { report } = await import('../src/report.js')

  const dir = mkdtempSync(join(tmpdir(), 'proof-jsondoc2-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'json shape',
    checks: [{ name: 'alpha', run: 'true' }],
  }))

  const capture = async fn => {
    let printed = ''
    const real = console.log
    console.log = s => { printed += s }
    try { await fn() } finally { console.log = real }
    return JSON.parse(printed)
  }

  const fromCheck = await capture(() => check({ json: true }))
  const fromReport = await capture(() => report({ json: true }))
  const emitted = new Set([...Object.keys(fromCheck), ...Object.keys(fromReport)])

  for (const field of documentedJsonFields()) {
    assert.ok(emitted.has(field), `the README documents "${field}" but no command emits it`)
  }
})

test('the failure entry keys shown in the README are the ones emitted', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { check } = await import('../src/check.js')

  const dir = mkdtempSync(join(tmpdir(), 'proof-jsondoc3-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'failure shape',
    checks: [{ name: 'bravo', run: 'exit 1' }],
  }))

  let printed = ''
  const real = console.log
  console.log = s => { printed += s }
  try { await check({ json: true }) } finally { console.log = real }

  const failure = JSON.parse(printed).failures[0]
  const documented = (README.match(/\| `failures` \| `\{([^}]*)\}`/) ?? [])[1] ?? ''
  const names = documented.split(',').map(s => s.trim()).filter(Boolean)

  assert.ok(names.length >= 4, 'the README describes the failure entry shape')
  for (const key of names) assert.ok(key in failure, `failures[] should carry "${key}"`)

  // And the other direction. The guard was one-way, so a key added to the emitted shape
  // could go undocumented indefinitely — which is the drift it exists to catch.
  for (const key of Object.keys(failure)) {
    assert.ok(names.includes(key), `failures[] carries "${key}" but the README does not list it`)
  }
})

test('every advisory the README quotes is one the code still produces', () => {
  // The README quoted a version of the no-runtime advisory that the code had stopped
  // producing. Both are wrapped across lines in the README, so compare with whitespace
  // collapsed rather than trying to match the wrapping.
  const flat = README.replace(/\s+/g, ' ')

  for (const [name, message] of Object.entries(ADVISORY)) {
    assert.ok(flat.includes(message.replace(/\s+/g, ' ')), `README does not quote the ${name} advisory verbatim`)
  }
})

test('the README does not quote an advisory the code no longer has', () => {
  // The drift was one-directional last time; check the other direction too.
  const quoted = [...README.matchAll(/```\nNOTE\n([\s\S]*?)```/g)].map(m => m[1].replace(/\s+/g, ' ').trim())
  assert.ok(quoted.length > 0, 'the README quotes at least one NOTE block')

  // Some notices interpolate values, so match them as patterns rather than literals.
  const known = [...Object.values(ADVISORY), EVIDENCE_NOTICE, TESTS_CHANGED_NOTICE, CONTRACT_CHANGED_NOTICE].map(m => new RegExp(
    '^' + m.replace(/\s+/g, ' ').trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\{\w+\\\}/g, '.+?') + '$',
  ))
  for (const q of quoted) {
    assert.ok(known.some(re => re.test(q)), `README quotes a NOTE no advisory produces: ${q}`)
  }
})

/** A repo with a diff, a dependency bump and a route, so both scans have something to say. */
const scanProject = async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { execFileSync } = await import('node:child_process')
  const git = (...a) => execFileSync('git', a, { stdio: 'ignore' })

  const dir = mkdtempSync(join(tmpdir(), 'proof-jsonshape-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('.proof')
  mkdirSync('src')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  writeFileSync('package.json', JSON.stringify({ dependencies: { lodash: '1.0.0' } }))
  writeFileSync('src/base.ts', 'export const b = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  writeFileSync('src/routes.ts', "router.get('/api/x', h)\nconst k = process.env.SECRET\n")
  writeFileSync('package.json', JSON.stringify({ dependencies: { lodash: '2.0.0' } }))
  return dir
}

const emittedBy = fn => {
  let printed = ''
  const real = console.log
  console.log = s => { printed += s }
  try { fn() } finally { console.log = real }
  return Object.keys(JSON.parse(printed))
}

test('changed and infer document every --json field they emit', async () => {
  // Only `proof check --json` was guarded, and these two are what an agent reads to decide
  // what to verify at all.
  const { changed } = await import('../src/changed.js')
  const { infer } = await import('../src/infer.js')
  await scanProject()

  for (const [command, run] of [['proof changed', () => changed({ json: true })], ['proof infer', () => infer({ json: true })]]) {
    const documented = documentedJsonFields(command)
    assert.ok(documented.size > 0, `${command} --json has no documented field table`)

    for (const field of emittedBy(run)) {
      assert.ok(documented.has(field), `${command} --json emits "${field}" but the README does not document it`)
    }
  }
})

test('changed and infer emit every --json field they document', async () => {
  const { changed } = await import('../src/changed.js')
  const { infer } = await import('../src/infer.js')
  await scanProject()

  for (const [command, run] of [['proof changed', () => changed({ json: true })], ['proof infer', () => infer({ json: true })]]) {
    const emitted = new Set(emittedBy(run))
    for (const field of documentedJsonFields(command)) {
      assert.ok(emitted.has(field), `the README documents ${command} --json "${field}" but nothing emits it`)
    }
  }
})

test('report documents every --json field it emits, in both of its shapes', async () => {
  // `proof report --list --json` had no field table at all, and it is the shape an agent
  // reads to find a run before asking for it.
  const { check } = await import('../src/check.js')
  const { report } = await import('../src/report.js')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const dir = mkdtempSync(join(tmpdir(), 'proof-reportshape-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  await check({ json: true })

  // a run carries everything check recorded, plus what report adds
  const runFields = new Set([...documentedJsonFields('proof check'), ...documentedJsonFields('proof report')])
  for (const field of emittedBy(() => report({ json: true }))) {
    assert.ok(runFields.has(field), `proof report --json emits "${field}" but the README does not document it`)
  }

  const listFields = documentedJsonFields('proof report --list')
  assert.ok(listFields.size > 0, 'proof report --list --json has no documented field table')
  for (const field of emittedBy(() => report({ json: true, list: true }))) {
    assert.ok(listFields.has(field), `proof report --list --json emits "${field}" but the README does not document it`)
  }
})

test('report emits every --json field it documents', async () => {
  const { check } = await import('../src/check.js')
  const { report } = await import('../src/report.js')
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const dir = mkdtempSync(join(tmpdir(), 'proof-reportshape2-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: g\nchecks:\n  - name: a\n    run: "true"\n')
  await check({ json: true })

  const runEmitted = new Set(emittedBy(() => report({ json: true })))
  for (const field of documentedJsonFields('proof report')) {
    assert.ok(runEmitted.has(field), `the README documents proof report --json "${field}" but nothing emits it`)
  }

  const listEmitted = new Set(emittedBy(() => report({ json: true, list: true })))
  for (const field of documentedJsonFields('proof report --list')) {
    assert.ok(listEmitted.has(field), `the README documents proof report --list --json "${field}" but nothing emits it`)
  }
})

/** Element shapes the README spells out as `{a, b, c}` in a field table. */
const documentedElementKeys = field => {
  const row = README.match(new RegExp(`^\\| \`${field}\`[^\n]*`, 'm'))?.[0] ?? ''
  const shape = row.match(/\{([^}]+)\}/)?.[1] ?? ''
  const named = [...row.matchAll(/`(\w+)`/g)].map(m => m[1])
  return new Set([...shape.split(',').map(x => x.trim().split(':')[0]).filter(Boolean), ...named])
}

const capturePayload = fn => {
  let printed = ''
  const real = console.log
  console.log = s => { printed += s }
  try { fn() } finally { console.log = real }
  return printed
}

test('every key inside a documented array element is itself documented', async () => {
  // The tables spell these out as `{a, b, c}`, and nothing checked them: `results[].asserted`
  // and `dependencies[].manifest` were both added without the docs following.
  const { check } = await import('../src/check.js')
  const { changed } = await import('../src/changed.js')
  const { infer } = await import('../src/infer.js')
  const { report } = await import('../src/report.js')

  await scanProject()

  const payloads = [
    JSON.parse(capturePayload(() => changed({ json: true }))),
    JSON.parse(capturePayload(() => infer({ json: true }))),
  ]
  await check({ json: true })
  payloads.push(JSON.parse(capturePayload(() => report({ json: true }))))
  payloads.push(JSON.parse(capturePayload(() => report({ json: true, list: true }))))

  const arrays = ['dependencies', 'coverage', 'gaps', 'runs', 'results', 'failures']
  const exercised = new Set()

  for (const payload of payloads) {
    for (const field of arrays) {
      const rows = payload[field]
      if (!Array.isArray(rows) || !rows.length) continue

      const documented = documentedElementKeys(field)
      assert.ok(documented.size > 0, `${field}[] has no documented element shape`)

      for (const row of rows) {
        for (const key of Object.keys(row)) {
          assert.ok(documented.has(key), `${field}[].${key} is emitted but not documented`)
        }
      }
      exercised.add(field)
    }
  }

  // Without this the test passes by exercising nothing.
  assert.ok(exercised.size >= 4, `only these element shapes were exercised: ${[...exercised]}`)
})

test('the contract proof writes lists every key of the verbs it spells out', () => {
  // The README is guarded in both directions; the template `proof init` generates was not,
  // and drifted two verbs behind the validator without anything noticing.
  //
  // Per line, with word boundaries. A whole-header `includes` passes vacuously: `not_contains`
  // is a substring of `body_not_contains` on the http line, so the file line could drop it
  // and nothing failed. Only the scopes spelled out in full — `browser` is deliberately
  // abbreviated to `{visit, flow: [...]}`, a summary line rather than a schema.
  const src = readFileSync(new URL('../src/spec.js', import.meta.url), 'utf8')
  const start = src.indexOf('# Verbs:')
  assert.ok(start > 0, 'the template header moved')
  const header = src.slice(start, src.indexOf('${serveBlock', start))
  const line = verb => header.split('\n').find(l => l.trimStart().startsWith(`#   ${verb}:`))

  const SPELLED_OUT = {
    'check.file': line('file'),
    'check.env': line('env'),
    'check.http.expect': (line('http') ?? '').match(/expect: \{[^}]*\}/)?.[0],
  }

  for (const [scope, text] of Object.entries(SPELLED_OUT)) {
    assert.ok(text, `the template no longer spells out ${scope}`)
    for (const key of ALLOWED[scope]) {
      assert.match(text, new RegExp(`\\b${key}\\b`),
        `the \`proof init\` template's ${scope} line does not list \`${key}\`: ${text}`)
    }
  }
})
