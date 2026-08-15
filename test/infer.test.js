import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileRoute, routesIn, envRefsIn, declaredEnv, migrateCommand, findGaps } from '../src/infer.js'
import { check } from '../src/check.js'

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-infer-'))
  process.chdir(dir)
  return dir
}

test('fileRoute maps framework file paths to URLs', () => {
  assert.equal(fileRoute('app/api/auth/callback/route.ts'), '/api/auth/callback')
  assert.equal(fileRoute('src/app/(marketing)/pricing/route.js'), '/pricing')
  assert.equal(fileRoute('pages/api/login.ts'), '/api/login')
  assert.equal(fileRoute('pages/api/users/index.ts'), '/api/users')
  assert.equal(fileRoute('src/lib/util.ts'), null)
})

test('routesIn finds express-style handlers with line numbers', () => {
  sandbox()
  writeFileSync('server.ts', "const a = 1\napp.post('/api/password-reset', h)\nrouter.get(`/health`, h)\n")
  assert.deepEqual(routesIn('server.ts'), [
    { method: 'POST', path: '/api/password-reset', at: 'server.ts:2' },
    { method: 'GET', path: '/health', at: 'server.ts:3', mountable: true },
  ])
})

test('envRefsIn catches dot and bracket access; declaredEnv reads .env.example', () => {
  sandbox()
  writeFileSync('db.ts', "const u = process.env.DATABASE_URL\nconst k = process.env['STRIPE_KEY']\n")
  writeFileSync('.env.example', '# comment\nDATABASE_URL=postgres://x\nexport OTHER=1\n')
  assert.deepEqual(envRefsIn('db.ts'), [
    { name: 'DATABASE_URL', at: 'db.ts:1' },
    { name: 'STRIPE_KEY', at: 'db.ts:2' },
  ])
  assert.deepEqual([...declaredEnv()].sort(), ['DATABASE_URL', 'OTHER'])
})

test('undeclared env ranks HIGH, declared ranks MEDIUM', () => {
  sandbox()
  writeFileSync('db.ts', "process.env.DATABASE_URL\nprocess.env.SECRET_TOKEN\n")
  writeFileSync('.env.example', 'DATABASE_URL=x\n')
  const gaps = findGaps(['db.ts'], [], { reportUncovered: false })
  assert.deepEqual(
    gaps.map(g => [g.severity, g.check.env]),
    [['HIGH', 'SECRET_TOKEN'], ['MEDIUM', 'DATABASE_URL']],
  )
})

test('migration change emits the detected migrator command', () => {
  sandbox()
  writeFileSync('package.json', JSON.stringify({ devDependencies: { prisma: '^5' } }))
  assert.equal(migrateCommand(), 'npx prisma migrate deploy')
  const gaps = findGaps(['prisma/migrations/001_init/migration.sql'], [], { reportUncovered: false })
  assert.equal(gaps.length, 1)
  assert.equal(gaps[0].check.run, 'npx prisma migrate deploy')
})

test('gaps already covered by an existing check are not reported', () => {
  sandbox()
  writeFileSync('server.ts', "app.post('/api/reset', h)\n")
  // method is part of the match — a GET check does not prove a POST endpoint
  const existing = [{ name: 'reset endpoint', http: { method: 'POST', path: '/api/reset' } }]
  assert.deepEqual(findGaps(['server.ts'], existing, { reportUncovered: false }), [])
  assert.equal(findGaps(['server.ts'], [], { reportUncovered: false }).length, 1)
  assert.equal(
    findGaps(['server.ts'], [{ name: 'read', http: { path: '/api/reset' } }], { reportUncovered: false }).length,
    1,
  )
})

test('generated http check is executable by proof check', async () => {
  const dir = sandbox()
  writeFileSync('server.ts', "app.get('/health', h)\n")
  const [gap] = findGaps(['server.ts'], [], { reportUncovered: false })

  const { createServer } = await import('node:http')
  const server = createServer((_, res) => { res.writeHead(200); res.end('ok') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`

  // write the generated check through YAML so we prove the emitted shape, not a hand-written one
  mkdirSync('.proof')
  const YAML = (await import('yaml')).default
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'generated',
    // the server is already up; this fixture deliberately reuses it
    serve: { run: 'sleep 30', ready_url: url, reuse_existing: true },
    checks: [gap.check],
  }))

  const code = await check({ json: true })
  server.close()
  assert.equal(code, 0)
  const result = JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8'))
  assert.equal(result.checks['get /health'], 'passed')
})

test('env verb fails on unset and passes on set', async () => {
  sandbox()
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', 'goal: env\nchecks:\n  - name: token\n    env: PROOF_TEST_TOKEN\n')
  delete process.env.PROOF_TEST_TOKEN
  assert.equal(await check({ json: true }), 1)

  process.env.PROOF_TEST_TOKEN = 'abc'
  assert.equal(await check({ json: true }), 0)
  delete process.env.PROOF_TEST_TOKEN
})
