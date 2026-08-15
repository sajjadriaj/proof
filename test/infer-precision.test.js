import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routesIn, envRefsIn, findGaps, isPlatformEnv, isDynamicPath } from '../src/infer.js'

const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-precision-'))
  process.chdir(dir)
  mkdirSync('src', { recursive: true })
  return dir
}

test('the regression: only real paths count as routes', () => {
  sandbox()
  writeFileSync('src/server.ts', [
    "const port = app.get('port')", // Express settings getter
    "app.set('trust proxy', true)",
    "app.get('/health', h)",
    "router.post('/api/login', h)",
  ].join('\n'))

  assert.deepEqual(routesIn('src/server.ts'), [
    { method: 'GET', path: '/health', at: 'src/server.ts:3' },
    // declared on a router with no mount in this file, so the prefix is not knowable here
    { method: 'POST', path: '/api/login', at: 'src/server.ts:4', mountable: true },
  ])
})

test('client calls with relative specifiers are not routes; absolute ones still are', () => {
  sandbox()
  writeFileSync('src/client.ts', [
    "export const loadUsers = () => api.get('users')", // relative, not a path
    "export const loadAll = () => api.get('/api/users')",
  ].join('\n'))

  assert.deepEqual(routesIn('src/client.ts').map(r => r.path), ['/api/users'])
})

test('an unresolved template literal is flagged as dynamic, not emitted as a literal URL', () => {
  sandbox()
  writeFileSync('src/client.ts', 'const one = (id) => api.get(`/users/${id}`)\n')

  const [gap] = findGaps(['src/client.ts'], [], { reportUncovered: false })
  assert.equal(gap.severity, 'HIGH')
  assert.match(gap.note, /dynamic segment/)

  assert.equal(isDynamicPath('/users/${id}'), true)
  assert.equal(isDynamicPath('/users/[id]'), true)
  assert.equal(isDynamicPath('/users/:id'), true)
  assert.equal(isDynamicPath('/users'), false)
})

test('platform-injected env vars are not reported as gaps', () => {
  sandbox()
  writeFileSync('src/config.ts', [
    'const env = process.env.NODE_ENV',
    'const port = process.env.PORT',
    'const ci = process.env.GITHUB_ACTIONS',
    'const key = process.env.STRIPE_SECRET_KEY',
  ].join('\n'))

  // the raw scan still sees them all
  assert.deepEqual(envRefsIn('src/config.ts').map(e => e.name), ['NODE_ENV', 'PORT', 'GITHUB_ACTIONS', 'STRIPE_SECRET_KEY'])

  // but only the deployment-specific one is a gap worth reporting
  const gaps = findGaps(['src/config.ts'], [], { reportUncovered: false })
  assert.deepEqual(gaps.map(g => g.check.env), ['STRIPE_SECRET_KEY'])

  assert.equal(isPlatformEnv('NODE_ENV'), true)
  assert.equal(isPlatformEnv('npm_package_version'), true)
  assert.equal(isPlatformEnv('DATABASE_URL'), false)
})
