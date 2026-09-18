#!/usr/bin/env node
// Writes schema/spec.schema.json from the validator's own table. A test holds the committed
// copy equal to this output, so the schema cannot drift behind a new key.
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { specSchema } from '../src/schema.js'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(join(root, 'schema'), { recursive: true })
const path = join(root, 'schema/spec.schema.json')
writeFileSync(path, `${JSON.stringify(specSchema(), null, 2)}\n`)
console.log(`wrote ${path}`)
