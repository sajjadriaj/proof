import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve } from 'node:path'

/**
 * `npm pack` → install → run was verified by hand once. These hold what that probe proved,
 * statically, so a file referenced but not shipped fails here instead of at the first
 * install after the change.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('every import in shipped code resolves to a shipped file', () => {
  // The tarball is `files` plus package.json/README/LICENSE. An import of ../test/helper.js
  // or a module added outside src/ would run here and die at the installed location.
  const shippedDirs = pkg.files.filter(f => statSync(join(root, f)).isDirectory())
  const sources = shippedDirs.flatMap(d =>
    readdirSync(join(root, d)).filter(f => f.endsWith('.js')).map(f => join(d, f)))
  assert.ok(sources.length >= 12, `only found ${sources.length} shipped sources`)

  for (const file of sources) {
    const src = readFileSync(join(root, file), 'utf8')
    for (const m of src.matchAll(/from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)) {
      const spec = m[1] ?? m[2]
      if (!spec.startsWith('.')) continue      // node: builtins and dependencies
      const target = resolve(root, dirname(file), spec)
      const rel = target.slice(root.length)
      assert.ok(existsSync(target), `${file} imports ${spec}, which does not exist`)
      assert.ok(shippedDirs.some(d => rel.startsWith(d + '/')) || rel === 'package.json',
        `${file} imports ${spec} → ${rel}, which is outside the shipped file list ${JSON.stringify(pkg.files)}`)
    }
  }
})

test('the version read reaches package.json from where bin/proof.js ships', () => {
  // bin/proof.js reads new URL('../package.json', import.meta.url); in the tarball bin/ sits
  // directly under the package root, so exactly one `../` is right. Two would escape it.
  const src = readFileSync(join(root, 'bin/proof.js'), 'utf8')
  assert.match(src, /new URL\('\.\.\/package\.json', import\.meta\.url\)/)
  assert.ok(existsSync(resolve(root, 'bin', '../package.json')))
})

test('the bin entry points at a file that ships, with a node shebang', () => {
  const bin = pkg.bin.proof
  assert.ok(existsSync(join(root, bin)), `${bin} is missing`)
  assert.ok(pkg.files.some(d => bin.startsWith(d + '/')), `${bin} is not in files`)
  assert.match(readFileSync(join(root, bin), 'utf8'), /^#!\/usr\/bin\/env node\n/)
})

test('the only runtime dependency is yaml, and playwright stays optional', () => {
  // the spec's constraint: single runtime dependency, Playwright as an optional peer —
  // a dependency added casually would install for every user of the CLI
  assert.deepEqual(Object.keys(pkg.dependencies), ['yaml'])
  assert.equal(pkg.peerDependenciesMeta.playwright.optional, true)
  assert.ok(!('playwright' in pkg.dependencies))
})

test('nothing shipped imports from test/', () => {
  const files = ['bin', 'src'].flatMap(d =>
    readdirSync(join(root, d)).filter(f => f.endsWith('.js')).map(f => join(d, f)))
  assert.ok(files.length >= 12, 'the scan found the shipped sources at all')

  for (const f of files) {
    assert.doesNotMatch(readFileSync(join(root, f), 'utf8'), /from '[^']*\/test\//,
      `${f} reaches into test/`)
  }
})
