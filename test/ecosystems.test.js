import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverChecks, makeTargets, discoverServeCommand } from '../src/spec.js'

const project = files => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-eco-'))
  process.chdir(dir)
  for (const [path, body] of Object.entries(files)) writeFileSync(path, body)
  return dir
}

const commands = () => discoverChecks().map(c => c.run)

test('the regression: a Makefile with a test target is a discoverable test command', () => {
  // A Makefile is the most explicit statement a project makes about how to test itself,
  // and it is the one signal that works in any language.
  project({ Makefile: '.PHONY: test\ntest:\n\tpytest -q\n' })
  assert.deepEqual(commands(), ['make test'])
})

test('only targets the Makefile actually defines are offered', () => {
  // Scaffolding `make test` into a Makefile without that target writes a check that fails
  // on the first run — worse than the placeholder it would have replaced.
  project({ Makefile: 'build:\n\tgcc main.c\n' })
  assert.deepEqual(commands(), ['make build'])
})

test('a Makefile with no recognised target discovers nothing', () => {
  project({ Makefile: 'deploy:\n\trsync -a . server:/srv\n' })
  assert.deepEqual(commands(), [])
})

test('makeTargets reads targets, not variables or continuations', () => {
  project({
    Makefile: [
      'CFLAGS := -O2',
      'PREFIX = /usr/local',
      '.PHONY: test build',
      'test:',
      '\tpytest',
      'build: test',
      '\tcc main.c',
      '# comment: not a target',
    ].join('\n'),
  })

  const targets = makeTargets('Makefile')
  assert.ok(targets.has('test'))
  assert.ok(targets.has('build'))
  assert.ok(!targets.has('CFLAGS'), 'an assignment is not a target')
  assert.ok(!targets.has('PREFIX'), 'a plain assignment is not a target either')
  assert.ok(!targets.has('.PHONY'), '.PHONY declares targets, it is not one')
})

test('python without pyproject is still recognised', () => {
  project({ 'pytest.ini': '[pytest]\n' })
  assert.deepEqual(commands(), ['pytest -q'])

  project({ 'tox.ini': '[tox]\n' })
  assert.deepEqual(commands(), ['tox'])
})

test('ruby, maven and gradle are recognised', () => {
  project({ Gemfile: "source 'https://rubygems.org'\n" })
  assert.deepEqual(commands(), ['bundle exec rake test'])

  project({ 'pom.xml': '<project></project>\n' })
  assert.deepEqual(commands(), ['mvn -q test'])

  project({ 'build.gradle': 'plugins { id "java" }\n' })
  assert.deepEqual(commands(), ['./gradlew test'])
})

test('a project manifest wins over a Makefile that wraps it', () => {
  // Both are present in plenty of repos; `npm test` is the more precise statement.
  project({
    'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
    Makefile: 'test:\n\tnpm test\n',
  })

  assert.deepEqual(commands(), ['npm run test'])
})

test('a project with nothing recognisable discovers nothing, and says so by discovering nothing', () => {
  project({ 'README.md': '# hello\n' })
  assert.deepEqual(commands(), [])
})

test('an unreadable Makefile is not a crash', () => {
  project({})
  assert.deepEqual([...makeTargets('Makefile')], [])
})

const serve = () => discoverServeCommand()

test('the regression: a non-JavaScript project gets a serve command too', () => {
  // Only npm scripts were read, so every other project got no serve block and no prompt to
  // add one — and http and browser checks are exactly the ones that show a requirement works.
  project({ 'Cargo.toml': '[package]\nname="x"\n' })
  assert.equal(serve(), 'cargo run')

  project({ 'go.mod': 'module x\n' })
  assert.equal(serve(), 'go run .')

  project({ 'manage.py': "if __name__ == '__main__': pass\n" })
  assert.equal(serve(), 'python3 manage.py runserver')
})

test('a Makefile target the project defined beats anything guessed from the language', () => {
  project({ Makefile: 'dev:\n\tflask run\n', 'Cargo.toml': '[package]\nname="x"\n' })
  assert.equal(serve(), 'make dev')
})

test('only serve-ish targets count', () => {
  project({ Makefile: 'deploy:\n\trsync -a . server:/srv\n' })
  assert.equal(serve(), null)
})

test('an npm dev script still wins', () => {
  project({
    'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
    Makefile: 'run:\n\tnode server.js\n',
  })
  assert.equal(serve(), 'npm run dev')
})

test('a project with no obvious entry point is not given a guessed one', () => {
  // `python app.py` scaffolded at a project whose entry point is elsewhere is a serve block
  // that fails to boot, and a failing boot short-circuits every check after it.
  project({ 'requirements.txt': 'flask\n' })
  assert.equal(serve(), null)
})

test('a malformed package.json does not stop the other signals being read', () => {
  project({ 'package.json': '{ not json', Makefile: 'dev:\n\tflask run\n' })
  assert.equal(serve(), 'make dev')
})

test('the regression: the scaffolded port follows the command, not the Node convention', async () => {
  // 3000 for a Django project is a wrong guess the reader has to notice and correct.
  const { writeSpec } = await import('../src/spec.js').then(m => ({ writeSpec: m.writeSpec ?? null }))
  const { readFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))

  const dir = project({ 'manage.py': 'pass\n' })
  execFileSync(process.execPath, [CLI, 'init', 'r'], { cwd: dir, stdio: 'ignore' })

  const spec = readFileSync(join(dir, '.proof/spec.yaml'), 'utf8')
  assert.match(spec, /ready_url: http:\/\/localhost:8000/)
  assert.match(spec, /run: python3 manage\.py runserver/)
})

test('where there is no convention, the port is a placeholder rather than a guess', async () => {
  const { readFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))

  const dir = project({ 'Cargo.toml': '[package]\nname="x"\n' })
  execFileSync(process.execPath, [CLI, 'init', 'r'], { cwd: dir, stdio: 'ignore' })

  const spec = readFileSync(join(dir, '.proof/spec.yaml'), 'utf8')
  assert.match(spec, /ready_url: http:\/\/localhost:<port>/)
})

test('an uncommented placeholder is refused, with advice rather than a parse error', async () => {
  const { validateSpec } = await import('../src/validate.js')
  const problems = validateSpec({
    goal: 'g',
    serve: { run: 'cargo run', ready_url: 'http://localhost:<port>' },
    checks: [{ name: 'c', run: 'true' }],
  })

  assert.equal(problems.length, 1, `one mistake, one problem: ${problems.join(' | ')}`)
  assert.match(problems[0], /still has the placeholder <port> in it/)
  assert.match(problems[0], /Replace it with a real value/)
})

test('a real port is accepted', async () => {
  const { validateSpec } = await import('../src/validate.js')
  assert.deepEqual(validateSpec({
    goal: 'g',
    serve: { run: 'cargo run', ready_url: 'http://localhost:8080' },
    checks: [{ name: 'c', run: 'true' }],
  }), [])
})
