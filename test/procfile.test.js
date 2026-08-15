import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { procfileWeb, discoverServeCommand } from '../src/spec.js'

/**
 * Python without a framework convention has no single right start command, so proof said
 * nothing — correctly. But a Procfile is not a guess: it is the project stating how it
 * starts, the same principle that already prefers a Makefile target over the language.
 */
const withFiles = files => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-procfile-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  process.chdir(dir)
  return dir
}

test('the web process is the one that listens, wherever it sits', () => {
  withFiles({ Procfile: 'worker: celery -A app worker\nweb: gunicorn app:app\n' })
  assert.equal(procfileWeb('Procfile'), 'gunicorn app:app')
})

test('a single entry is used whatever it is named', () => {
  // a one-process Procfile rarely bothers with the convention
  withFiles({ Procfile: 'app: python -m http.server 8000\n' })
  assert.equal(procfileWeb('Procfile'), 'python -m http.server 8000')
})

test('comments and blank lines are not entries', () => {
  withFiles({ Procfile: '# how this starts\n\nweb: flask run\n' })
  assert.equal(procfileWeb('Procfile'), 'flask run')
})

test('an empty or commented-out Procfile discovers nothing', () => {
  withFiles({ Procfile: '# web: gunicorn app:app\n\n' })
  assert.equal(procfileWeb('Procfile'), null)
  assert.equal(discoverServeCommand(), null, 'and no language guess is invented in its place')
})

test('a missing file is not an error', () => {
  withFiles({})
  assert.equal(procfileWeb('Procfile'), null)
})

test('a Procfile beats a guess made from the language', () => {
  withFiles({ Procfile: 'web: ./target/debug/shop\n', 'Cargo.toml': '[package]\nname = "shop"\n' })
  assert.equal(discoverServeCommand(), './target/debug/shop')
})

test('but a package.json script still wins — it is equally declared and more specific', () => {
  withFiles({ Procfile: 'web: gunicorn app:app\n', 'package.json': '{"scripts":{"dev":"vite"}}' })
  assert.equal(discoverServeCommand(), 'npm run dev')
})

test('a FastAPI project that had nothing now has its own command', () => {
  withFiles({ Procfile: 'web: uvicorn main:app --port 8000\n', 'pyproject.toml': '[project]\nname = "shop"\n' })
  assert.equal(discoverServeCommand(), 'uvicorn main:app --port 8000')
})
