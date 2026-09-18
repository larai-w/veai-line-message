// Exercise the entire deployed entrypoint with synthetic events. Disabling
// carecall prevents SDK/network initialization; no real credentials are loaded.
import assert from 'node:assert/strict'
import test from 'node:test'
import {pathToFileURL} from 'node:url'

process.env.CARECALL_ENABLED = '0'
process.env.REPORT_WEBHOOK_SECRET = 'synthetic-report-secret'
process.env.EVENT_WEBHOOK_SECRET = 'synthetic-event-secret'
const target = process.env.ROUTING_TEST_ENTRY
const {handler} = await import(target ? pathToFileURL(target) : new URL('../index.mjs', import.meta.url))

async function invoke(path, method) {
  const logs = []
  const original = {log: console.log, warn: console.warn, error: console.error}
  for (const key of Object.keys(original)) console[key] = (...args) => logs.push(args.join(' '))
  try {
    const result = await handler({rawPath: path, requestContext: {http: {method, path}},
      headers: {'x-carecall-token': 'synthetic-device-secret'}, body: '{}'})
    return {result, logs}
  } finally {
    Object.assign(console, original)
  }
}

for (const [name, path, method] of [
  ['status lookup', '/carecall/synthetic-test', 'GET'],
  ['call entry', '/carecall', 'POST'],
  ['LINE webhook', '/line/carecall/webhook', 'POST'],
]) {
  test(`${name} reaches carecall disabled response, never report authentication`, async () => {
    const {result} = await invoke(path, method)
    assert.equal(result.statusCode, 503)
    assert.equal(JSON.parse(result.body).error, 'care call disabled')
  })
}

test('carecall headers do not enter generic raw-event logging', async () => {
  const {logs} = await invoke('/carecall/synthetic-test', 'GET')
  assert.equal(logs.some(line => line.includes('synthetic-device-secret')), false)
})

test('unrelated report authentication remains enforced', async () => {
  const {result} = await invoke('/reports', 'POST')
  assert.equal(result.statusCode, 401)
})
