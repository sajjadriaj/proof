// The app the README demo verifies. It ships with the bug the recording catches: an error
// response that carries the stack trace. The tape fixes it on camera.
import { createServer } from 'node:http'

createServer((req, res) => {
  const json = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  if (req.url === '/') return json(200, { ok: true })
  if (req.url === '/login' && req.method === 'POST')
    return json(200, { user: 'ada' }, { 'set-cookie': 'sid=s3cr3t; HttpOnly' })
  if (req.url === '/profile')
    return req.headers.cookie?.includes('sid=s3cr3t')
      ? json(200, { name: 'ada' })
      : json(401, { error: 'sign in first' })
  const err = new Error('invalid token')
  return json(500, { error: err.message, stack: err.stack })
}).listen(3000, () => console.log('listening on 3000'))
