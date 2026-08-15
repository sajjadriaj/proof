import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PLACEHOLDER_RUN } from '../src/validate.js'

const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-placeholder-'))
  for (const args of [['init', '-q', '.'], ['config', 'user.email', 't@t.t'], ['config', 'user.name', 't']]) {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  return dir
}

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

test('the regression: init then check refuses instead of reporting DONE', () => {
  // `proof init` on a project with no discoverable test command writes a placeholder check.
  // That check passes, so the first `proof check` used to print VERDICT DONE and exit 0 —
  // a clean bill of health for a requirement nothing had verified.
  const dir = repo()
  assert.equal(proof(dir, 'init', 'users can reset their password').code, 0)

  const { code, out } = proof(dir, 'check')
  assert.equal(code, 2, 'an unfinished contract is a config error, not a pass')
  assert.doesNotMatch(out, /DONE/)
  assert.match(out, /placeholder/)
  assert.match(out, /without verifying anything/)
})

test('the refusal names the check and says what to do about it', () => {
  const dir = repo()
  proof(dir, 'init', 'g')

  const { out } = proof(dir, 'check')
  assert.match(out, /check\[0\] "tests"/, 'the offending check is identified')
  assert.match(out, /Replace it with the command that proves the requirement/)
})

test('--json reports it as an error rather than a status the agent can read as passing', () => {
  const dir = repo()
  proof(dir, 'init', 'g')

  const { code, out } = proof(dir, 'check', '--json')
  const parsed = JSON.parse(out)
  assert.equal(parsed.status, 'error')
  assert.equal(code, 2)
  assert.notEqual(parsed.status, 'passed')
})

test('replacing the placeholder is all it takes', () => {
  const dir = repo()
  proof(dir, 'init', 'g')

  const spec = join(dir, '.proof', 'spec.yaml')
  const [placeholder] = [...PLACEHOLDER_RUN.keys()]
  writeFileSync(spec, readFileSync(spec, 'utf8').replace(placeholder, 'echo ok'))

  const { code, out } = proof(dir, 'check')
  assert.equal(code, 0, out)
  assert.match(out, /DONE/)
})

test('every placeholder Proof writes is one validation rejects', () => {
  // The rule and the text are the same constant, so rewording one cannot silently
  // stop the other from matching.
  for (const [command, why] of PLACEHOLDER_RUN) {
    const dir = repo()
    writeFileSync(join(dir, 'spec.yaml'), '')
    execFileSync('mkdir', ['-p', join(dir, '.proof')])
    writeFileSync(
      join(dir, '.proof', 'spec.yaml'),
      `goal: g\nchecks:\n  - name: c\n    run: ${JSON.stringify(command)}\n`,
    )

    const { code, out } = proof(dir, 'check')
    assert.equal(code, 2, `${command} was accepted`)
    // Collapse whitespace: the CLI wraps long errors, so the reason spans lines.
    const flat = out.replace(/\s+/g, ' ')
    assert.ok(flat.includes(why.replace(/\s+/g, ' ')), `the reason for ${command} is not explained: ${out}`)
  }
})

test('a command that merely mentions the placeholder wording is left alone', () => {
  const dir = repo()
  execFileSync('mkdir', ['-p', join(dir, '.proof')])
  writeFileSync(
    join(dir, '.proof', 'spec.yaml'),
    'goal: g\nchecks:\n  - name: c\n    run: echo "replace me with a real command" && true\n',
  )

  const { code } = proof(dir, 'check')
  assert.equal(code, 0, 'only the exact untouched placeholder is rejected')
})

test('the regression: a contract with no goal does not print a bare VERDICT DONE', () => {
  // The human report drops its "Requirement:" section when the goal is missing, leaving
  // DONE as an answer with no question attached.
  const dir = repo()
  execFileSync('mkdir', ['-p', join(dir, '.proof')])
  writeFileSync(join(dir, '.proof', 'spec.yaml'), 'checks:\n  - name: a\n    run: echo hi\n')

  const { code, out } = proof(dir, 'check')
  assert.equal(code, 2)
  assert.doesNotMatch(out, /VERDICT/, 'no verdict is rendered at all')
  assert.match(out, /`goal`/)
})

test('a whitespace-only goal is no goal', () => {
  const dir = repo()
  execFileSync('mkdir', ['-p', join(dir, '.proof')])
  writeFileSync(join(dir, '.proof', 'spec.yaml'), 'goal: "   "\nchecks:\n  - name: a\n    run: echo hi\n')

  assert.equal(proof(dir, 'check').code, 2)
})

test('--json never pairs a null goal with a passing status', () => {
  const dir = repo()
  execFileSync('mkdir', ['-p', join(dir, '.proof')])
  writeFileSync(join(dir, '.proof', 'spec.yaml'), 'checks:\n  - name: a\n    run: echo hi\n')

  const parsed = JSON.parse(proof(dir, 'check', '--json').out)
  assert.equal(parsed.status, 'error')
})

test('the regression: infer --write is not blocked by the placeholder it exists to replace', () => {
  // As a validation error the rule blocked every command that loads the contract, including
  // the one that appends real checks. init wrote a placeholder, infer refused to touch the
  // contract because of it, and hand-editing was the only way out.
  const dir = repo()
  writeFileSync(join(dir, 'server.js'), "app.get('/health', h)\n")
  proof(dir, 'init', 'the health endpoint works')

  const { code, out } = proof(dir, 'infer', '--write')
  assert.equal(code, 0, out)
  assert.match(out, /Appended [1-9]\d* check\(s\)/)
  assert.match(readFileSync(join(dir, '.proof', 'spec.yaml'), 'utf8'), /\/health/)
})

test('infer says the placeholder will still block check', () => {
  const dir = repo()
  writeFileSync(join(dir, 'server.js'), "app.get('/health', h)\n")
  proof(dir, 'init', 'g')

  const { out } = proof(dir, 'infer')
  assert.match(out, /still hold proof's own placeholder/)
  assert.match(out, /`proof check` refuses to run/)
})

test('--json carries the unfinished checks by name', () => {
  const dir = repo()
  proof(dir, 'init', 'g')

  const { out } = proof(dir, 'infer', '--json')
  assert.deepEqual(JSON.parse(out).unfinished, ['tests'])
})

test('a finished contract reports nothing unfinished', () => {
  const dir = repo()
  execFileSync('mkdir', ['-p', join(dir, '.proof')])
  writeFileSync(join(dir, '.proof', 'spec.yaml'), 'goal: g\nchecks:\n  - name: a\n    run: echo ok\n')

  const { out } = proof(dir, 'infer', '--json')
  assert.deepEqual(JSON.parse(out).unfinished, [])
})

test('changed still works with a placeholder in the contract', () => {
  const dir = repo()
  writeFileSync(join(dir, 'server.js'), 'export const x = 1\n')
  proof(dir, 'init', 'g')

  assert.equal(proof(dir, 'changed').code, 0)
})

test('the regression: an uncommented serve block is refused if its command was not filled in', () => {
  // `<your dev command>` reaches the shell, where `<` is input redirection — the run fails
  // with a syntax error about a file that does not exist, nowhere near the real problem.
  const dir = repo()
  execFileSync('mkdir', ['-p', join(dir, '.proof')])
  writeFileSync(
    join(dir, '.proof', 'spec.yaml'),
    'goal: g\nserve:\n  run: <your dev command>\n  ready_url: http://localhost:3000\n'
    + 'checks:\n  - name: c\n    http: {path: /}\n',
  )

  const { code, out } = proof(dir, 'check')
  assert.equal(code, 2)
  assert.match(out.replace(/\s+/g, ' '), /serve › run: this is still the placeholder proof scaffolded/)
  assert.match(out.replace(/\s+/g, ' '), /could not tell how this project starts/)
})

test('a command containing angle brackets is left alone', () => {
  // A `<...>` rule over commands would fire on these, and a validation rule that cries wolf
  // is one people learn to ignore.
  const dir = repo()
  execFileSync('mkdir', ['-p', join(dir, '.proof')])
  writeFileSync(join(dir, 'index.html'), '<div>hi</div>\n')
  writeFileSync(
    join(dir, '.proof', 'spec.yaml'),
    "goal: g\nchecks:\n  - name: markup\n    run: grep '<div>' index.html\n"
    + '  - name: redirection\n    run: "sort < index.html > /dev/null"\n',
  )

  assert.equal(proof(dir, 'check').code, 0)
})

test('a real serve command is accepted', () => {
  // `timeout: 1` because the claim is about validation, not about booting: without it this
  // waited out the full 60s default for a server it never intended to start.
  const dir = repo()
  execFileSync('mkdir', ['-p', join(dir, '.proof')])
  writeFileSync(
    join(dir, '.proof', 'spec.yaml'),
    'goal: g\nserve:\n  run: sleep 30\n  ready_url: http://127.0.0.1:9\n  timeout: 1\n'
    + 'checks:\n  - name: c\n    run: echo ok\n',
  )

  const { out } = proof(dir, 'check')
  assert.doesNotMatch(out, /placeholder proof scaffolded/)
  assert.match(out, /not ready at/, 'it got as far as trying to boot, which is the point')
})
