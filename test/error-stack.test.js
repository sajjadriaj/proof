import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import YAML from 'yaml'
import { check } from '../src/check.js'

const PAGE = `<!doctype html><meta charset=utf-8><title>t</title><h1>Hi</h1>
<script>
function inner(){ return missingThing.value }
function middle(){ return inner() }
function outer(){ return middle() }
setTimeout(outer, 30)
</script>`

const serve = () => new Promise(resolve => {
  const s = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) })
  s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }))
})

const quiet = async fn => {
  const real = console.log
  console.log = () => {}
  try { return await fn() } finally { console.log = real }
}

const run = async (url, browserExtra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-stack-'))
  process.chdir(dir)
  mkdirSync('.proof')
  writeFileSync('.proof/spec.yaml', YAML.stringify({
    goal: 'page loads without errors',
    checks: [{
      name: 'home flow',
      timeout: 25,
      browser: { base_url: url, visit: '/', flow: [{ expect_text: 'Hi' }, { wait: 400 }], ...browserExtra },
    }],
  }))
  const code = await quiet(() => check({ json: true }))
  return {
    code,
    result: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/result.json'), 'utf8')),
    bundle: JSON.parse(readFileSync(join(dir, '.proof/runs/0001/browser-home-flow.json'), 'utf8')),
  }
}

test('the regression: the whole call stack is kept, not just the first frame', async () => {
  const { s, url } = await serve()
  try {
    const { bundle } = await run(url)
    const [err] = bundle.consoleErrors

    assert.equal(err.text, 'missingThing is not defined')
    assert.match(err.at, /inner \(/, 'the first frame is still there for display')

    assert.ok(err.stack, 'the full stack is stored')
    for (const frame of ['inner', 'middle', 'outer']) {
      assert.match(err.stack, new RegExp(frame), `stack retains the ${frame} frame`)
    }
  } finally { s.close() }
})

test('the stack travels with a gated failure too', async () => {
  const { s, url } = await serve()
  try {
    const { code, bundle } = await run(url, { expect_no_console_errors: true })
    assert.equal(code, 1)
    assert.match(bundle.consoleErrors[0].stack, /middle/)
  } finally { s.close() }
})

test('a console.error records a 1-based line, the one an editor shows', async () => {
  // console.error sits on line 4 of the document
  const doc = [
    '<!doctype html><meta charset=utf-8><title>t</title>',
    '<h1>Hi</h1>',
    '<script>',
    'console.error("plain message")',
    '</script>',
  ].join('\n')

  const noStack = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(doc)
  })
  await new Promise(r => noStack.listen(0, '127.0.0.1', r))
  try {
    const { bundle } = await run(`http://127.0.0.1:${noStack.address().port}`)
    const [err] = bundle.consoleErrors

    assert.equal(err.text, 'plain message')
    assert.equal('stack' in err, false, 'console messages carry a location, not a stack')
    assert.match(err.at, /:4$/, `expected line 4, got ${err.at}`)
  } finally { noStack.close() }
})
