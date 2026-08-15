#!/usr/bin/env node
// Runs the suite, then removes the temp projects it created.
//
// Every test builds its fixture with mkdtempSync and none of them clean up: one file leaves
// five directories behind, the whole suite a few hundred. That went unnoticed until the disk
// filled and the next run failed with ENOSPC across dozens of unrelated tests — a failure
// that looks like a code regression and is not one.
//
// A wrapper rather than teardown in seventy test files: the shortest change that cannot be
// forgotten by the seventy-first.
import { spawnSync } from 'node:child_process'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'proof-'
const started = Date.now()

// Expanded here rather than by a shell: passing a glob through `shell: true` is deprecated,
// and quoting test paths through two layers is a bug waiting to happen.
const args = process.argv.slice(2)
const target = args.length
  ? args
  : readdirSync('test').filter(f => f.endsWith('.test.js')).sort().map(f => join('test', f))

// A syntax error costs a nine-minute run to discover, and surfaces as one test file that
// "failed" with no line number — the runtime can name the file and column in under a second.
// Fail fast with a precise diagnosis, which is the thing this whole tool is arguing for.
const sources = ['src', 'bin', 'test']
  .flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.js')).map(f => join(dir, f)))

const broken = sources
  .map(file => ({ file, check: spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }) }))
  .filter(({ check }) => check.status !== 0)

if (broken.length) {
  for (const { file, check } of broken) {
    console.error(`${file} does not parse:\n${(check.stderr || '').trim().split('\n').slice(0, 4).join('\n')}\n`)
  }
  console.error(`${broken.length} file(s) failed to parse — the suite was not run.`)
  process.exit(2)
}

const child = spawnSync(process.execPath, ['--test', ...target], { stdio: 'inherit' })

// Only what this run made. A concurrent run's fixtures are not ours to delete.
let removed = 0
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith(PREFIX)) continue
  const path = join(tmpdir(), name)
  try {
    if (statSync(path).birthtimeMs < started) continue
    rmSync(path, { recursive: true, force: true })
    removed += 1
  } catch { /* a fixture that vanished on its own is the outcome we wanted */ }
}
if (removed) console.log(`\ncleaned up ${removed} temp project(s)`)

// Cleanup must never change the verdict.
process.exitCode = child.status ?? 1
