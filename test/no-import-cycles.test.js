import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')

/** Local imports only — node: builtins and packages cannot take part in a cycle here. */
const graph = () => {
  const edges = new Map()
  for (const file of readdirSync(SRC).filter(f => f.endsWith('.js'))) {
    const source = readFileSync(join(SRC, file), 'utf8')
    const targets = [...source.matchAll(/(?:import|export)[^'"]*from\s*['"](\.\/[^'"]+)['"]/g)]
      .map(m => m[1].replace(/^\.\//, ''))
    edges.set(file, targets)
  }
  return edges
}

/** Every cycle reachable from `start`, as a path of file names. */
const findCycle = (edges, start, seen = [], visited = new Set()) => {
  if (seen.includes(start)) return [...seen.slice(seen.indexOf(start)), start]
  if (visited.has(start)) return null
  visited.add(start)
  for (const next of edges.get(start) ?? []) {
    const cycle = findCycle(edges, next, [...seen, start], visited)
    if (cycle) return cycle
  }
  return null
}

test('the regression: src has no import cycles', () => {
  // `check` imported the evidence-size helpers from `report`, which imports VERDICT from
  // `check`. It worked only because every use happened to be inside a function — a later
  // top-level use of either binding would have failed with an opaque TDZ error at startup.
  const edges = graph()

  for (const file of edges.keys()) {
    const cycle = findCycle(edges, file)
    assert.equal(cycle, null, `import cycle: ${cycle?.join(' -> ')}`)
  }
})

test('the detector finds a cycle when there is one', () => {
  // Otherwise the test above passes just as happily on a broken graph walk.
  const edges = new Map([['a.js', ['b.js']], ['b.js', ['c.js']], ['c.js', ['a.js']]])
  assert.deepEqual(findCycle(edges, 'a.js'), ['a.js', 'b.js', 'c.js', 'a.js'])
})

test('the detector does not invent a cycle in a diamond', () => {
  // Two paths to the same module is not a cycle, and a depth-first walk that forgets to
  // distinguish "visited" from "on the current path" would say it was.
  const edges = new Map([['a.js', ['b.js', 'c.js']], ['b.js', ['d.js']], ['c.js', ['d.js']], ['d.js', []]])
  assert.equal(findCycle(edges, 'a.js'), null)
})

test('every local import resolves to a file that exists', () => {
  const files = new Set(readdirSync(SRC))
  for (const [file, targets] of graph()) {
    for (const t of targets) assert.ok(files.has(t), `${file} imports ${t}, which is not in src/`)
  }
})
