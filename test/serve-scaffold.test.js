import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { commentedServeLine } from '../src/infer.js'

/**
 * `init` scaffolds the serve block commented out, with the project's own dev command already
 * filled in. `infer` printed a blank template instead — telling people to author something
 * sitting in their contract a few lines from where they were looking.
 */
const CLI = fileURLToPath(new URL('../bin/proof.js', import.meta.url))
const proof = (dir, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' })
  return { exit: r.status, out: r.stdout + r.stderr, stdout: r.stdout }
}

const project = ({ init }) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-scaffold-'))
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  mkdirSync(join(dir, 'app/api/x'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"s","type":"module","scripts":{"dev":"node server.js"}}\n')
  g('init', '-q', '-b', 'main', '.')
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't')
  g('add', '-A'); g('commit', '-qm', 'base')
  writeFileSync(join(dir, 'app/api/x/route.ts'), 'export async function GET() { return Response.json({}) }\n')

  if (init) proof(dir, 'init', 'a requirement')
  else {
    mkdirSync(join(dir, '.proof'))
    writeFileSync(join(dir, '.proof/spec.yaml'), 'goal: g\nchecks:\n  - name: t\n    run: "true"\n')
  }
  return dir
}

test('the note points at the scaffold init already wrote', () => {
  const dir = project({ init: true })
  const r = proof(dir, 'infer')

  assert.match(r.out, /already scaffolded in \.proof\/spec\.yaml at line \d+ — uncomment it/)
  assert.doesNotMatch(r.out, /<your dev command>/, 'proof knows the command; it wrote it there')
})

test('and the line number is where the block actually starts', () => {
  const dir = project({ init: true })
  const line = JSON.parse(proof(dir, 'infer', '--json').stdout).serve_scaffold_line

  const lines = readFileSync(join(dir, '.proof/spec.yaml'), 'utf8').split('\n')
  assert.match(lines[line - 1], /^\s*#\s*serve:\s*$/, `line ${line} is: ${lines[line - 1]}`)
})

test('a contract with no scaffold still gets the template', () => {
  // a hand-written contract has nothing to uncomment, and pointing at a line that is not
  // there would be worse than the generic form
  const dir = project({ init: false })
  const r = proof(dir, 'infer')

  assert.match(r.out, /<your dev command>/)
  assert.equal(JSON.parse(proof(dir, 'infer', '--json').stdout).serve_scaffold_line, null)
})

test('a missing or unreadable contract is not an error', () => {
  assert.equal(commentedServeLine('/nonexistent/spec.yaml'), null)
})

test('an already-uncommented serve block is not matched', () => {
  // it would be pointing at a block that needs no action
  const dir = mkdtempSync(join(tmpdir(), 'proof-scaffold-live-'))
  writeFileSync(join(dir, 'spec.yaml'), 'goal: g\nserve:\n  run: npm run dev\nchecks: []\n')
  assert.equal(commentedServeLine(join(dir, 'spec.yaml')), null)
})
