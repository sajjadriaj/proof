import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routesIn, envRefsIn, stripComments } from '../src/infer.js'

const scan = source => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-comments-'))
  process.chdir(dir)
  writeFileSync('a.js', source)
  return { routes: routesIn('a.js'), env: envRefsIn('a.js') }
}

test('the regression: a commented-out route is not reported as reachable', () => {
  // `infer --write` appended an http check for it. The check could never pass, so the agent
  // was told the requirement was unmet because of a line the runtime never sees.
  const { routes } = scan(
    "// app.post('/api/old', h)\n"
    + "/*\n * app.get('/api/ancient', h)\n */\n"
    + "app.get('/api/real', h)\n",
  )

  assert.deepEqual(routes.map(r => `${r.method} ${r.path}`), ['GET /api/real'])
})

test('a commented-out env reference is not reported either', () => {
  const { env } = scan('// const a = process.env.OLD_SECRET\nconst b = process.env.REAL_SECRET\n')
  assert.deepEqual(env.map(e => e.name), ['REAL_SECRET'])
})

test('line numbers still point at the code', () => {
  // Comments are blanked in place rather than removed, so every byte keeps its position.
  const { routes, env } = scan(
    "// filler\n// filler\n/* filler\n filler */\napp.get('/api/real', h)\nconst k = process.env.REAL\n",
  )
  assert.equal(routes[0].at, 'a.js:5')
  assert.equal(env[0].at, 'a.js:6')
})

test('a URL in a trailing comment does not eat the route on that line', () => {
  const { routes } = scan("app.get('/api/real', h) // docs at http://example.com/x\n")
  assert.deepEqual(routes.map(r => r.path), ['/api/real'])
})

test('a route path is not mistaken for a comment', () => {
  // `//` appears inside plenty of real strings — a protocol, a path, a regex source.
  const { routes } = scan("app.get('/api/a', h)\nconst base = 'https://api.example.com'\napp.get('/api/b', h)\n")
  assert.deepEqual(routes.map(r => r.path), ['/api/a', '/api/b'])
})

test('stripComments keeps the source length and line count', () => {
  const src = "const a = 1 // note\n/* block\n   comment */\nconst b = 'text // not a comment'\n"
  const out = stripComments(src)

  assert.equal(out.length, src.length, 'positions are preserved')
  assert.equal(out.split('\n').length, src.split('\n').length, 'lines are preserved')
  assert.match(out, /const a = 1/)
  assert.match(out, /text \/\/ not a comment/, 'a comment marker inside a string is left alone')
  assert.doesNotMatch(out, /note/)
  assert.doesNotMatch(out, /block/)
})

test('an unterminated comment does not swallow the rest of the file silently', () => {
  const out = stripComments("app.get('/a', h)\n/* never closed\n")
  assert.match(out, /\/a/, 'code before the comment survives')
})

test('the regression: a commented-out import is not an edge in the blast radius', async () => {
  // `changed` listed the file as a direct dependent, and `infer` then scanned it for gaps
  // and warned that no check named it — for a file the change cannot reach.
  const { reverseGraph } = await import('../src/changed.js')
  const dir = mkdtempSync(join(tmpdir(), 'proof-graph-comments-'))
  process.chdir(dir)
  mkdirSync('src')
  writeFileSync('src/target.js', 'export const x = 1\n')
  writeFileSync('src/live.js', "import { x } from './target.js'\n")
  writeFileSync('src/dead.js', "// import { x } from './target.js'\n/* import './target.js' */\n")

  const importers = [...(reverseGraph(['src/target.js', 'src/live.js', 'src/dead.js']).get('src/target.js') ?? [])]
  assert.deepEqual(importers, ['src/live.js'])
})

test('a real import beside a commented one still counts', async () => {
  const { reverseGraph } = await import('../src/changed.js')
  const dir = mkdtempSync(join(tmpdir(), 'proof-graph-both-'))
  process.chdir(dir)
  mkdirSync('src')
  writeFileSync('src/target.js', 'export const x = 1\n')
  writeFileSync('src/both.js', "// import './target.js' — the old way\nimport { x } from './target.js'\n")

  const importers = [...(reverseGraph(['src/target.js', 'src/both.js']).get('src/target.js') ?? [])]
  assert.deepEqual(importers, ['src/both.js'])
})

test('the regression: a regex containing a quote does not blind the rest of the file', async () => {
  // /['"`]/ put the scanner into string mode, so every comment after it stopped being
  // stripped — silently undoing comment handling for exactly the files most likely to
  // contain such a regex: parsers, validators, sanitizers.
  const { stripComments } = await import('../src/changed.js')
  const src = `const QUOTES = /['"\`]/g\n// app.get('/commented-out', h)\nconst after = 1\n`

  const out = stripComments(src)
  assert.doesNotMatch(out, /commented-out/, 'the comment after the regex was not stripped')
  assert.match(out, /QUOTES/, 'the regex itself survives')
})

test('a division is not mistaken for a regex', async () => {
  const { stripComments } = await import('../src/changed.js')
  const out = stripComments('const half = total / count // halve it\nconst next = 1\n')

  assert.doesNotMatch(out, /halve it/)
  assert.match(out, /total \/ count/)
})

test('an escaped slash inside a regex does not end it early', async () => {
  const { stripComments } = await import('../src/changed.js')
  const out = stripComments('const RE = /a\\/b/\n// x.get("/q", h)\n')

  assert.match(out, /const RE/, 'the code itself survived — only the comment went')
  assert.doesNotMatch(out, /x\.get/)
})

test('a comment marker inside a string is still left alone', async () => {
  const { stripComments } = await import('../src/changed.js')
  const out = stripComments('const url = "http://example.com"\nconst note = \'a // b\'\n')

  assert.match(out, /http:\/\/example\.com/)
  assert.match(out, /a \/\/ b/)
})
