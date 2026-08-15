import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, execFileSync } from 'node:child_process'
import { withSpecLock, writeFileAtomic, loadSpec } from '../src/spec.js'

const CLI = join(import.meta.dirname, '..', 'bin', 'proof.js')
const git = (...args) => execFileSync('git', args, { stdio: 'ignore' })

const project = routes => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-lock-'))
  process.chdir(dir)
  git('init', '-q', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')
  mkdirSync('src')
  mkdirSync('.proof')
  writeFileSync('package.json', '{}')
  // enough files that the scan is slow enough for the runs to genuinely overlap
  for (let i = 0; i < 300; i++) writeFileSync(join('src', `mod${i}.ts`), `export const v${i} = ${i}\n`)
  git('add', '-A')
  git('commit', '-qm', 'init')
  writeFileSync('src/routes.ts', routes)
  // a serve block, since the checks infer generates use relative paths
  // `timeout: 1`: the serve command exits 0 without starting anything, which proof now
  // treats as a possibly-detached launcher and polls for. This test is about lock
  // contention, not about booting, so it should not wait out the 60s default.
  writeFileSync('.proof/spec.yaml',
    'goal: g\nserve:\n  run: "true"\n  ready_url: http://127.0.0.1:9/\n  timeout: 1\n'
    + 'checks:\n  - name: build\n    run: "true"\n')
  return dir
}

const ROUTES = [
  "app.post('/api/one', h)",
  "app.get('/api/two', h)",
  "app.put('/api/three', h)",
  "app.patch('/api/four', h)",
  "app.delete('/api/five', h)",
].join('\n') + '\n'

const runCli = (dir, args) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { cwd: dir }, (err, stdout, stderr) => resolve({ err, stdout, stderr }))
})

test('the regression: concurrent infer --write leaves a valid contract, not a duplicated one', async () => {
  const dir = project(ROUTES)
  await Promise.all(Array.from({ length: 6 }, () => runCli(dir, ['infer', '--write'])))

  const names = loadSpec().checks.map(c => c.name)
  assert.equal(new Set(names).size, names.length, `duplicate checks written: ${names.join(', ')}`)
  assert.deepEqual(names.sort(), [
    'build', 'delete /api/five', 'get /api/two', 'patch /api/four', 'post /api/one', 'put /api/three',
  ])
})

test('the contract still loads after concurrent writes', async () => {
  const dir = project(ROUTES)
  await Promise.all(Array.from({ length: 4 }, () => runCli(dir, ['infer', '--write'])))

  const { stderr } = await runCli(dir, ['check', '--only', 'build'])
  assert.match(readFileSync(join(dir, '.proof/spec.yaml'), 'utf8'), /checks:/, 'a contract is there to load')
  assert.doesNotMatch(stderr, /is invalid/, 'no contract corruption to repair by hand')
})

test('the lock is released even when the critical section throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-lock2-'))
  process.chdir(dir)
  mkdirSync('.proof')

  assert.throws(() => withSpecLock(() => { throw new Error('boom') }), /boom/)
  assert.equal(existsSync(join(dir, '.proof/spec.lock')), false, 'lock removed on the error path')

  // and the lock can be taken again straight away
  assert.equal(withSpecLock(() => 'ok'), 'ok')
})

test('a stale lock left by a killed run is broken rather than blocking forever', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-lock3-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync(join(dir, '.proof/spec.lock'), '999999') // no such process

  const started = Date.now()
  assert.equal(withSpecLock(() => 'recovered'), 'recovered')
  assert.ok(Date.now() - started < 12000, 'gives up waiting and breaks the stale lock')
})

test('atomic writes leave no partial file and no stray temporaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-atomic-'))
  process.chdir(dir)

  writeFileAtomic('out.txt', 'first')
  assert.equal(readFileSync('out.txt', 'utf8'), 'first')

  writeFileAtomic('out.txt', 'second')
  assert.equal(readFileSync('out.txt', 'utf8'), 'second')
  assert.deepEqual(readdirSync(dir), ['out.txt'], 'the temp file is renamed, never left behind')
})

test('init gitignores the lock and temp files it may create', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-lock4-'))
  process.chdir(dir)
  writeFileSync('package.json', JSON.stringify({ scripts: { test: 'echo t' } }))

  execFileSync(process.execPath, [CLI, 'init', 'a requirement'], { cwd: dir, stdio: 'ignore' })
  const ignore = readFileSync(join(dir, '.proof/.gitignore'), 'utf8')
  assert.match(ignore, /spec\.lock/)
  assert.match(ignore, /\*\.tmp/)
})
