import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { specSchema } from '../src/schema.js'
import { ALLOWED } from '../src/validate.js'

// The schema is for editor completion, so a stale one is worse than none: it red-underlines a
// key that is valid and completes one that is not. It is generated from the same table the
// validator enforces, and this is what keeps the committed copy equal to the generator.

const root = join(import.meta.dirname, '..')
const committed = () => JSON.parse(readFileSync(join(root, 'schema/spec.schema.json'), 'utf8'))

test('the committed schema is what the generator produces', () => {
  assert.deepEqual(committed(), specSchema(),
    'schema/spec.schema.json is stale — regenerate it with `npm run schema`')
})

/** Every `additionalProperties: false` object in the tree, by the keys it allows. */
const objectsIn = (node, out = []) => {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const v of node) objectsIn(v, out); return out }
  if (node.additionalProperties === false && node.properties) out.push(new Set(Object.keys(node.properties)))
  for (const v of Object.values(node)) objectsIn(v, out)
  return out
}

test('every scope the validator knows appears in the schema, with exactly its keys', () => {
  const shapes = objectsIn(specSchema())

  for (const [scope, keys] of Object.entries(ALLOWED)) {
    // The top level carries `serve` and `checks` as hand-built nodes, so compare it by
    // property names rather than by looking for an identical key set.
    const wanted = new Set(keys)
    const found = shapes.some(shape => shape.size === wanted.size && [...wanted].every(k => shape.has(k)))
    assert.ok(found,
      `no object in the schema allows exactly ${scope || 'the top level'}'s keys: ${[...wanted].join(', ')}`)
  }
})

test('the schema rejects the keys the validator rejects', () => {
  const schema = specSchema()
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['goal', 'checks'])

  const check = schema.properties.checks.items
  assert.equal(check.additionalProperties, false)
  // The keys added since the schema was first written have to be here, or an editor marks a
  // valid contract as wrong — which is how people learn to switch the schema off.
  for (const key of ['capture', 'skip', 'parallel', 'expect_under_ms']) {
    assert.ok(key in check.properties, `\`${key}\` is a check key the schema does not list`)
  }
})

test('a file or env verb accepts both of its written forms', () => {
  const check = specSchema().properties.checks.items
  for (const verb of ['file', 'env']) {
    const forms = check.properties[verb].anyOf
    assert.ok(forms.some(f => f.type === 'string'), `${verb} should accept a bare string`)
    assert.ok(forms.some(f => f.type === 'object'), `${verb} should accept a mapping`)
  }
})
