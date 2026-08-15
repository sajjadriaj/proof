import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * The documented workflow, start to finish, on a project shaped like a real one:
 * init → changed → infer --write → edit → check → report.
 *
 * Every piece has unit tests. This asserts they compose — which is where the last several
 * bugs came from, each one a correct piece producing a false claim in combination.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const PORT = 8321

const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: process.env })
  return { code: r.status, out: r.stdout + r.stderr }
}

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-workflow-'))
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  const write = (p, body) => {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), body)
  }

  git('init', '-q', '-b', 'main', '.')
  git('config', 'user.email', 't@t.t')
  git('config', 'user.name', 't')

  write('package.json', JSON.stringify({ name: 'shop', type: 'module', scripts: { dev: 'node server.js', test: 'node --test' } }))
  write('server.js',
    "import http from 'node:http'\n"
    + `http.createServer((req, res) => {\n`
    + "  const p = req.url.split('?')[0]\n"
    + "  if (p === '/api/checkout' && req.method === 'POST') {\n"
    + "    if (!process.env.STRIPE_KEY) { res.writeHead(500); return res.end('not configured') }\n"
    + "    res.writeHead(200, {'content-type':'application/json'}); return res.end('{\"charged\":true}')\n"
    + '  }\n'
    + "  res.writeHead(200, {'content-type':'application/json'}); res.end('{\"ok\":true}')\n"
    + `}).listen(${PORT})\n`)
  write('src/lib/money.ts', 'export const round = n => Math.round(n)\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return { dir, write, git }
}

test('the documented workflow, end to end', async () => {
  const { dir, write, git } = project()

  // 1. init discovers the project's own commands
  const init = proof(dir, 'init', 'customers can complete checkout with a saved card')
  assert.equal(init.code, 0, init.out)
  assert.match(init.out, /discovered 1 check\(s\): test/)
  assert.match(init.out, /found `npm run dev`/, 'and how the project starts')
  git('add', '-A')
  git('commit', '-qm', 'spec')

  // 2. the agent writes a feature
  write('app/api/checkout/route.ts',
    "import { round } from '@/lib/money'\n"
    + 'export async function POST(req) {\n'
    + '  const key = process.env.STRIPE_KEY\n'
    + '  return Response.json({ charged: true, total: round(99.5) })\n'
    + '}\n')

  // 3. changed names the file and reports that nothing verifies it
  const changed = proof(dir, 'changed')
  assert.match(changed.out, /app\/api\/checkout\/route\.ts/)
  assert.match(changed.out, /no check names this file/)

  // 4. infer finds the route by its exported method, and the env var it reads
  const inferred = JSON.parse(proof(dir, 'infer', '--json').out)
  const titles = inferred.gaps.map(g => g.title)
  assert.ok(titles.some(t => t === 'POST /api/checkout is reachable'), `methods: ${titles}`)
  assert.ok(titles.some(t => t.includes('STRIPE_KEY')))

  // 5. --write appends them, with the caveat carried into the contract
  const written = proof(dir, 'infer', '--write')
  assert.match(written.out, /Appended 2 check\(s\)/)
  const contract = readFileSync(join(dir, '.proof/spec.yaml'), 'utf8')
  assert.match(contract, /# not declared in any \.env file/, 'the note travels with the check')

  // 6. the generated check uses a relative path, so until the serve block is uncommented the
  // contract does not validate — and `changed` says so rather than withholding the radius
  const degraded = proof(dir, 'changed')
  assert.match(degraded.out, /app\/api\/checkout\/route\.ts/, 'the blast radius is still reported')
  assert.match(degraded.out, /the contract is invalid, so coverage was not computed/)

  // 7. the one edit proof asked for: uncomment the serve block
  writeFileSync(join(dir, '.proof/spec.yaml'), contract.replace(
    /# serve:\n#   run: (.*)\n#   ready_url: (\S+)\n#   timeout: 60\n/,
    `serve:\n  run: npm run dev\n  ready_url: http://localhost:${PORT}/\n  timeout: 30\n`,
  ))

  // 7b. now the same file reads as covered, by the check infer wrote for it
  assert.match(proof(dir, 'changed').out, /OK {4}app\/api\/checkout\/route\.ts — post \/api\/checkout/)

  // 8. the run finds the real bug: the endpoint 500s without its key
  const failing = proof(dir, 'check')
  assert.equal(failing.code, 1, failing.out)
  assert.match(failing.out, /post \/api\/checkout {2}FAIL/)
  assert.match(failing.out, /env STRIPE_KEY {6}FAIL/)
  assert.match(failing.out, /status 500/)

  // 9. with the key, the contract passes — and says what it still does not prove
  const passing = spawnSync(process.execPath, [CLI, 'check'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, STRIPE_KEY: 'sk_test' },
  })
  assert.equal(passing.status, 0, passing.stdout + passing.stderr)
  assert.match(passing.stdout, /VERDICT\n {2}DONE\n {2}5 passed/)
  assert.match(passing.stdout, /asserts what the app actually returned/, 'the content advisory still applies')

  // 10. both runs are recorded, and the report reads the latest
  const list = proof(dir, 'report', '--list')
  assert.match(list.out, /0001/)
  assert.match(list.out, /0002/)
  assert.equal(proof(dir, 'report').code, 0)
})
