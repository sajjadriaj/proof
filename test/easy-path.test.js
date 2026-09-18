import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import YAML from 'yaml'
import { detectPort, SCHEMA_LINE } from '../src/spec.js'
import { snippet, HOOK_TIMEOUT_SEC } from '../src/hook.js'

// The distance between `proof init` and a contract that means something, and between an
// agent and the gate. Each of these used to be a step someone had to know to take.

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')

const proof = (dir, args, input) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', input: input ?? '' })
  return { code: r.status, out: r.stdout + r.stderr, stdout: r.stdout, stderr: r.stderr }
}

const project = (files, prefix = 'proof-easy-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  }
  return dir
}

const spec = dir => readFileSync(join(dir, '.proof/spec.yaml'), 'utf8')

// --- init knows the port -----------------------------------------------------

test('a port written into the dev script makes the serve block live', () => {
  const dir = project({ 'package.json': { scripts: { dev: 'node server.js --port 4100', test: 'true' } } })
  const r = proof(dir, ['init', 'the api answers'])

  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /on port 4100 \(the dev script\) — the serve block is live/)
  const parsed = YAML.parse(spec(dir))
  assert.equal(parsed.serve.run, 'npm run dev')
  assert.equal(parsed.serve.ready_url, 'http://localhost:4100')
  // and it is a contract `check` would accept as it stands
  assert.equal(proof(dir, ['lint']).code, 0)
})

test('a framework default is evidence enough; nothing known is not', () => {
  process.chdir(project({ 'package.json': { scripts: { dev: 'next dev' }, dependencies: { next: '15.0.0' } } }))
  assert.deepEqual(detectPort('npm run dev'), { port: '3000', from: "next's default" })

  process.chdir(project({ 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '6.0.0' } } }))
  assert.deepEqual(detectPort('npm run dev'), { port: '5173', from: "vite's default" })

  process.chdir(project({ 'package.json': { scripts: { dev: 'node server.js' } } }))
  assert.equal(detectPort('npm run dev'), null, 'a bare node script says nothing about its port')
})

test('a PORT in .env is read, and the script beats it', () => {
  process.chdir(project({ 'package.json': { scripts: { dev: 'node s.js' } }, '.env': 'PORT=9100\nSECRET=x\n' }))
  assert.deepEqual(detectPort('npm run dev'), { port: '9100', from: '.env' })

  process.chdir(project({ 'package.json': { scripts: { dev: 'PORT=7000 node s.js' } }, '.env': 'PORT=9100\n' }))
  assert.deepEqual(detectPort('npm run dev'), { port: '7000', from: 'the dev script' })
})

test('with no evidence the block stays commented, exactly as before', () => {
  const dir = project({ 'package.json': { scripts: { dev: 'node server.js' } } })
  proof(dir, ['init', 'r'])
  assert.match(spec(dir), /^# serve:\n#   run: npm run dev\n#   ready_url: http:\/\/localhost:3000/m)
  assert.equal(YAML.parse(spec(dir)).serve, undefined)
})

test('the contract proof writes carries its own schema line for the editor', () => {
  const dir = project({ 'package.json': { scripts: { test: 'true' } } })
  proof(dir, ['init', 'r'])
  assert.ok(spec(dir).startsWith(SCHEMA_LINE + '\n'), spec(dir).split('\n')[0])
  assert.match(SCHEMA_LINE, /^# yaml-language-server: \$schema=https:\/\/.*spec\.schema\.json$/)
})

test('init says what to do next, and names lint and infer', () => {
  const dir = project({ 'package.json': { scripts: { test: 'true' } } })
  const r = proof(dir, ['init', 'r'])
  assert.match(r.out, /proof infer/)
  assert.match(r.out, /proof lint/)
  assert.match(r.out, /writing-a-contract\.md/)
})

// --- lint --------------------------------------------------------------------

test('lint says what a contract would prove without running anything', () => {
  const dir = project({
    '.proof/spec.yaml': `goal: g
serve: {run: "sleep 30", ready_url: "http://127.0.0.1:9"}
checks:
  - name: suite
    run: "false"
  - name: status only
    http: {path: /a, expect: {status: 200}}
  - name: content
    http: {path: /b, expect: {status: 200, body_contains: "x"}}
`,
  })
  const started = Date.now()
  const r = proof(dir, ['lint'])
  assert.ok(Date.now() - started < 5000, 'nothing was booted or run')
  assert.equal(r.code, 0)
  assert.match(r.out, /3 check\(s\); 2 exercise the running app; 1 assert what it returns; 1 process\(es\)/)
  assert.match(r.out, /1 check\(s\) only assert a status \(status only\)/)
  assert.match(r.out, /STATUS\n {2}OK/)
  assert.ok(!existsSync(join(dir, '.proof/runs')), 'lint records no run')
})

test('lint carries the same advisory check would give on a pass', () => {
  const dir = project({ '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: a\n    run: "true"\n' })
  const r = proof(dir, ['lint', '--json'])
  const o = JSON.parse(r.stdout)
  assert.match(o.advisory, /Nothing in this contract exercises the running application/)
  assert.equal(o.runtime_checks, 0)
})

test('lint reports a placeholder as unfinished and exits 2, as check would', () => {
  const dir = project({ 'package.json': { name: 'x' } })
  proof(dir, ['init', 'r'])                       // no test command → the placeholder
  const r = proof(dir, ['lint'])
  assert.equal(r.code, 2)
  assert.match(r.out, /UNFINISHED — `proof check` would refuse/)
})

// --- hook --------------------------------------------------------------------

const hookInput = JSON.stringify({ session_id: 's', hook_event_name: 'Stop', stop_hook_active: false })

test('the stop hook refuses a stop while the contract fails, with the evidence as the reason', () => {
  const dir = project({ '.proof/spec.yaml': 'goal: the marker exists\nchecks:\n  - name: marker\n    file: marker.txt\n' })
  const r = proof(dir, ['hook', '--max-attempts', '3'], hookInput)

  assert.equal(r.code, 0, r.out)
  const decision = JSON.parse(r.stdout)
  assert.equal(decision.decision, 'block')
  assert.match(decision.reason, /NOT DONE \(attempt 1 of 3\)/)
  assert.match(decision.reason, /marker\.txt exists/)
  assert.match(decision.reason, /Requirement: the marker exists/)
  assert.ok(existsSync(join(dir, '.proof/feedback.md')), 'the same feedback guard writes')
})

test('once the contract passes the hook lets the stop through and clears its state', () => {
  const dir = project({ '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: marker\n    file: marker.txt\n' })
  proof(dir, ['hook'], hookInput)                               // blocked
  assert.ok(existsSync(join(dir, '.proof/hook-state.json')))

  writeFileSync(join(dir, 'marker.txt'), '')
  const r = proof(dir, ['hook'], hookInput)
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '', 'no decision means: allowed')
  assert.match(r.stderr, /contract passed/)
  assert.ok(!existsSync(join(dir, '.proof/hook-state.json')))
  assert.ok(!existsSync(join(dir, '.proof/feedback.md')), 'stale evidence never sits beside a green verdict')
})

test('the attempt budget is the override: after it the agent may stop, with the evidence left behind', () => {
  const dir = project({ '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: marker\n    file: marker.txt\n' })
  const first = proof(dir, ['hook', '--max-attempts', '2'], hookInput)
  const second = proof(dir, ['hook', '--max-attempts', '2'], hookInput)
  const third = proof(dir, ['hook', '--max-attempts', '2'], hookInput)

  assert.equal(JSON.parse(first.stdout).decision, 'block')
  assert.match(JSON.parse(second.stdout).reason, /attempt 2 of 2/)
  assert.equal(third.stdout.trim(), '', 'the third stop is allowed')
  assert.match(third.stderr, /still fails after 2 attempt\(s\) — letting the agent stop/)
  assert.ok(existsSync(join(dir, '.proof/feedback.md')))
  // and the budget resets for the next session rather than blocking forever after
  assert.ok(!existsSync(join(dir, '.proof/hook-state.json')))
})

test('with no contract the hook has no opinion, so a global install is safe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-easy-nocontract-'))
  const r = proof(dir, ['hook'], hookInput)
  assert.equal(r.code, 0)
  assert.equal(r.out.trim(), '')
})

test('a contract that can never complete does not hold the agent hostage', () => {
  const dir = project({ '.proof/spec.yaml': 'goal: g\nchecks:\n  - name: a\n    run: "true"\n    skip: "see #1"\n' })
  const r = proof(dir, ['hook'], hookInput)
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '')
  assert.match(r.stderr, /skipped .* not gating this stop/s)
})

test('--install merges into .claude/settings.json without touching what is already there', () => {
  const dir = project({
    '.claude/settings.json': JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    }, null, 2),
  })
  const r = proof(dir, ['hook', '--install', '--max-attempts', '4'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /wrote \.claude\/settings\.json/)

  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))
  assert.deepEqual(settings.permissions, { allow: ['Bash(npm test)'] }, 'permissions untouched')
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo hi', 'other hooks untouched')
  assert.equal(settings.hooks.Stop.length, 1)
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'proof hook --max-attempts 4')
  // A Stop hook is killed at 60s by default; a contract that boots an app is routinely longer.
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, HOOK_TIMEOUT_SEC)

  // idempotent
  const again = proof(dir, ['hook', '--install'])
  assert.match(again.out, /already runs `proof hook`/)
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8')).hooks.Stop.length, 1)
})

test('--install creates the settings file when there is none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-easy-fresh-'))
  proof(dir, ['hook', '--install'])
  const settings = JSON.parse(readFileSync(join(dir, '.claude/settings.json'), 'utf8'))
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'proof hook --max-attempts 5')
})

test('a settings file that will not parse is refused, never replaced', () => {
  const dir = project({ '.claude/settings.json': '{ not json' })
  const r = proof(dir, ['hook', '--install'])
  assert.equal(r.code, 2)
  assert.match(r.out, /is not valid JSON/)
  assert.match(r.out, /add the hook by hand/)
  assert.equal(readFileSync(join(dir, '.claude/settings.json'), 'utf8'), '{ not json', 'the file is the user\'s')
})

test('--print shows the snippet and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-easy-print-'))
  const r = proof(dir, ['hook', '--print'])
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(snippet(5)))
  assert.ok(!existsSync(join(dir, '.claude')))
})

test('--install and --print together are refused rather than one silently winning', () => {
  const r = proof(mkdtempSync(join(tmpdir(), 'proof-easy-both-')), ['hook', '--install', '--print'])
  assert.equal(r.code, 2)
  assert.match(r.out, /--install and --print are alternatives/)
})
