#!/usr/bin/env node
// End to end: one real `claude -p` session with the plugin loaded, its model answered by a local mock of the Anthropic API, and both
// paths of its log rows received locally: Claude Code's own OTLP exporter, and the plugin's copy (sent to Mainwave's dev collector,
// which tests/e2e/redirect sends here instead). Every record is paired with its twin by session, event name and sequence, and the
// two are compared field by field. Nothing leaves the machine.
//
//   node tests/e2e/compare.mjs            # exit 0 when the copy matches the exporter
//   node tests/e2e/compare.mjs --keep     # keep the captures and the session's config folder, and print where
//
// Needs `claude` on PATH. The session runs in a fresh CLAUDE_CONFIG_DIR with an API key, so no login and no organization's settings
// reach it.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const keep = process.argv.includes('--keep')

const EXPORTER_KEY = 'exporter_e2e_key_0001'
const PLUGIN_KEY = 'mw_dev_e2e_key_0001'
/** Resource keys only the OpenTelemetry SDK's host detectors add; a plugin has nothing to read them from. */
const HOST_ONLY = new Set(['os.type', 'os.version', 'host.arch'])
/** Attribute keys that differ by design between the two paths. */
const ROUTE = 'mainwave.telemetry.route'
/** Rows Claude Code raises while it starts, before any plugin's hooks are registered: no plugin ever sees them. */
const STARTUP = new Set(['managed_settings_resolved', 'plugin_loaded'])
/** An example organization, put on every row through the resource so the plugin's stamping path runs as in a real organization. */
const ORG = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

// ── The mock model ───────────────────────────────────────────────────────────
// A request that offers tools and has no tool result yet gets one Bash call; every other request gets a short text answer.

let messageId = 0
function modelReply(req) {
  const last = req.messages?.at(-1)
  const content = Array.isArray(last?.content) ? last.content : []
  const sawResult = content.some(b => b?.type === 'tool_result')
  const offersBash = (req.tools ?? []).some(t => t?.name === 'Bash')
  const id = `msg_e2e_${++messageId}`
  const usage = { input_tokens: 1200 + messageId, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  if (offersBash && !sawResult) {
    return { id, block: { type: 'tool_use', id: `toolu_e2e_${messageId}`, name: 'Bash', input: { command: 'echo e2e', description: 'Print e2e' } }, stop: 'tool_use', usage }
  }
  return { id, block: { type: 'text', text: 'ok' }, stop: 'end_turn', usage }
}

function sse(res, req) {
  const { id, block, stop, usage } = modelReply(req)
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_e2e_${messageId}` })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
  send('message_start', { message: { id, type: 'message', role: 'assistant', model: req.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })
  if (block.type === 'text') {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } })
  } else {
    send('content_block_start', { index: 0, content_block: { ...block, input: {} } })
    send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
  }
  send('content_block_stop', { index: 0 })
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
  send('message_stop', {})
  res.end()
}

// ── The receiver ─────────────────────────────────────────────────────────────

const captured = { exporter: [], plugin: [], other: [] }

function readBody(req) {
  return new Promise(resolveBody => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
  })
}

const server = createServer(async (req, res) => {
  const body = await readBody(req)
  const path = (req.url ?? '').split('?')[0]
  if (req.method === 'POST' && path === '/v1/messages') {
    const parsed = JSON.parse(body)
    if (parsed.stream) return sse(res, parsed)
    const { id, block, stop, usage } = modelReply(parsed)
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_e2e_${messageId}` })
    return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: parsed.model, content: [block], stop_reason: stop, stop_sequence: null, usage }))
  }
  if (req.method === 'POST' && path === '/v1/logs') {
    captured.exporter.push({ auth: req.headers['authorization'], type: req.headers['content-type'], body })
  } else if (req.method === 'POST' && path === '/plugin/v1/logs') {
    captured.plugin.push({ auth: req.headers['authorization'], type: req.headers['content-type'], body })
  } else {
    captured.other.push(`${req.method} ${path}`)
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"partialSuccess":{}}')
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// ── The session ──────────────────────────────────────────────────────────────

const config = mkdtempSync(join(tmpdir(), 'mainwave-e2e-'))
const work = mkdtempSync(join(tmpdir(), 'mainwave-e2e-work-'))
const settings = JSON.stringify({ pluginConfigs: { 'mainwave@inline': { options: { devIngestKey: PLUGIN_KEY } }, mainwave: { options: { devIngestKey: PLUGIN_KEY } } } })

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_API_KEY: 'sk-ant-e2e-not-a-key',
  ANTHROPIC_BASE_URL: base,
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'none',
  // Traces on, and the beta that ties log rows to spans: so rows carry trace and span ids, and the comparison checks them.
  OTEL_TRACES_EXPORTER: 'otlp',
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_ENDPOINT: base,
  OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${EXPORTER_KEY}`,
  OTEL_LOGS_EXPORT_INTERVAL: '500',
  OTEL_RESOURCE_ATTRIBUTES: `mainwave.source=coding_agent.claude_code,service.name=claude-code,deployment.environment=e2e,organization.id=${ORG}`,
  OTEL_LOG_USER_PROMPTS: '1',
  OTEL_LOG_TOOL_DETAILS: '1',
  MW_E2E_RECEIVER: `${base}/plugin`,
}

const args = [
  '-p', 'Run `echo e2e` with Bash, then say ok.',
  '--plugin-dir', root,
  '--plugin-dir', join(here, 'redirect'),
  '--settings', settings,
  '--allowedTools', 'Bash(echo e2e)',
  '--model', 'claude-haiku-5-5',
  '--debug-file', join(config, 'debug.log'),
]

const run = await new Promise(r => {
  const child = spawn('claude', args, { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', d => (out += d))
  child.stderr.on('data', d => (out += d))
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.on('exit', code => (clearTimeout(timer), r({ code, out })))
})
// The exporter's last batch can land just after the process exits.
await new Promise(r => setTimeout(r, 1_500))
server.close()

// ── The comparison ───────────────────────────────────────────────────────────

function plain(v) {
  if (v === undefined || v === null) return v
  if ('stringValue' in v) return { t: 'string', v: v.stringValue }
  if ('boolValue' in v) return { t: 'bool', v: v.boolValue }
  // Raw, so a number and a numeric string differ, as they do on the wire.
  if ('intValue' in v) return { t: 'int', v: v.intValue }
  if ('doubleValue' in v) return { t: 'double', v: v.doubleValue }
  if ('arrayValue' in v) return { t: 'array', v: (v.arrayValue.values ?? []).map(plain) }
  return { t: 'other', v: JSON.stringify(v) }
}
const kvs = list => Object.fromEntries((list ?? []).map(({ key, value }) => [key, plain(value)]))

function recordsOf(posts) {
  const out = []
  for (const { body } of posts) {
    for (const rl of JSON.parse(body).resourceLogs ?? []) {
      const resource = kvs(rl.resource?.attributes)
      for (const sl of rl.scopeLogs ?? []) {
        for (const r of sl.logRecords ?? []) {
          const attributes = kvs(r.attributes)
          out.push({
            key: `${attributes['session.id']?.v}|${attributes['event.name']?.v}|${attributes['event.sequence']?.v}`,
            resource, scope: sl.scope ?? {}, attributes,
            time: String(r.timeUnixNano ?? ''), body: plain(r.body),
            traceId: r.traceId ?? '', spanId: r.spanId ?? '',
          })
        }
      }
    }
  }
  return out
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const problems = []
const exporter = recordsOf(captured.exporter)
const plugin = recordsOf(captured.plugin)

if (run.code !== 0) problems.push(`claude exited ${run.code}:\n${run.out.slice(-2000)}`)
if (exporter.length === 0) problems.push('the exporter sent no records')
if (plugin.length === 0) problems.push('the plugin sent no records')
for (const p of captured.exporter) if (p.auth !== `Bearer ${EXPORTER_KEY}`) problems.push('an exporter request without the exporter key')
for (const p of captured.plugin) {
  if (p.auth !== `Bearer ${PLUGIN_KEY}`) problems.push("a plugin request without the person's dev key")
  if (p.body.includes(PLUGIN_KEY) || p.body.includes(EXPORTER_KEY)) problems.push('a key inside a request body')
}

const byKey = list => {
  const m = new Map()
  for (const r of list) {
    if (m.has(r.key)) problems.push(`two records for ${r.key} on one path`)
    m.set(r.key, r)
  }
  return m
}
const ex = byKey(exporter)
const pl = byKey(plugin)
const onlyExporter = [...ex.keys()].filter(k => !pl.has(k))
const onlyPlugin = [...pl.keys()].filter(k => !ex.has(k))
for (const k of onlyPlugin) problems.push(`the plugin sent ${k}, which the exporter did not`)
// Rows Claude Code raises while it starts are a known gap, reported, not failed. Any other row the exporter sent alone is a failure.
const beforePlugin = onlyExporter.filter(k => STARTUP.has(ex.get(k).attributes['event.name']?.v))
for (const k of onlyExporter) if (!beforePlugin.includes(k)) problems.push(`the exporter sent ${k}, which the plugin did not`)

// The paths a real organization's session takes, so the comparison checks them and does not pass by having nothing to check.
const matched = [...ex.values()].filter(r => pl.has(r.key))
if (!matched.some(r => r.attributes['mainwave.mod.name']?.v === 'mainwave')) problems.push("no matched row carries the plugin's stamps")
if (!matched.some(r => /^[0-9a-f]{32}$/.test(r.traceId) && /^[0-9a-f]{16}$/.test(r.spanId))) problems.push('no matched row carries a trace and span id')
if (!matched.some(r => r.attributes['event.name']?.v === 'api_request')) problems.push('no api_request row was matched')

const fieldDiffs = new Map()
const noteDiff = (what, k) => fieldDiffs.set(what, [...(fieldDiffs.get(what) ?? []), k])
for (const [k, e] of ex) {
  const p = pl.get(k)
  if (p === undefined) continue
  for (const f of ['time', 'body', 'traceId', 'spanId']) if (!same(e[f], p[f])) noteDiff(`${f}: exporter ${JSON.stringify(e[f])}, plugin ${JSON.stringify(p[f])}`, k)
  if (!same(e.scope.name, p.scope.name)) noteDiff(`scope name: ${e.scope.name} vs ${p.scope.name}`, k)
  for (const a of new Set([...Object.keys(e.attributes), ...Object.keys(p.attributes)])) {
    if (a === ROUTE) continue
    if (!same(e.attributes[a], p.attributes[a])) noteDiff(`attribute ${a}: exporter ${JSON.stringify(e.attributes[a])}, plugin ${JSON.stringify(p.attributes[a])}`, k)
  }
  if (e.attributes[ROUTE] !== undefined && e.attributes[ROUTE]?.v !== 'exporter') noteDiff(`exporter route ${JSON.stringify(e.attributes[ROUTE])}`, k)
  if (p.attributes[ROUTE]?.v !== 'plugin') noteDiff(`plugin route ${JSON.stringify(p.attributes[ROUTE])}`, k)
  for (const a of new Set([...Object.keys(e.resource), ...Object.keys(p.resource)])) {
    if (HOST_ONLY.has(a) && p.resource[a] === undefined) continue
    if (!same(e.resource[a], p.resource[a])) noteDiff(`resource ${a}: exporter ${JSON.stringify(e.resource[a])}, plugin ${JSON.stringify(p.resource[a])}`, k)
  }
}
for (const [what, keys] of fieldDiffs) problems.push(`${what} (${keys.length} record${keys.length === 1 ? '' : 's'}, e.g. ${keys[0]})`)

const events = [...ex.values()].reduce((m, r) => m.set(r.attributes['event.name']?.v, (m.get(r.attributes['event.name']?.v) ?? 0) + 1), new Map())
console.log(`exporter: ${exporter.length} records in ${captured.exporter.length} requests; plugin: ${plugin.length} records in ${captured.plugin.length} requests`)
console.log(`events: ${[...events].map(([n, c]) => `${n} ${c}`).join(', ')}`)
console.log(`matched: ${[...ex.keys()].filter(k => pl.has(k)).length}; exporter only: ${onlyExporter.length}; plugin only: ${onlyPlugin.length}`)
if (beforePlugin.length) console.log(`known difference: ${beforePlugin.length} startup rows raised before any plugin loads (${[...new Set(beforePlugin.map(k => k.split('|')[1]))].join(', ')})`)
const hostOnly = [...HOST_ONLY].filter(k => exporter[0]?.resource[k] !== undefined)
if (hostOnly.length) console.log(`known difference: the copy's resource has no ${hostOnly.join(', ')}`)

if (problems.length) {
  // What the session itself said about the plugins, and what the plugin kept: enough to see why without --keep.
  const debug = join(config, 'debug.log')
  if (existsSync(debug)) {
    const lines = readFileSync(debug, 'utf8').split('\n').filter(l => /mainwave|plugin|hook|telemetry|http/i.test(l))
    console.error(`\ndebug log, plugin lines (${lines.length}):\n${lines.slice(-80).join('\n')}`)
  }
  const store = join(config, 'plugins', 'store')
  if (existsSync(store)) for (const f of readdirSync(store)) if (f.startsWith('mainwave')) console.error(`\nstore ${f}: ${readFileSync(join(store, f), 'utf8').slice(0, 1500)}`)
  if (captured.other.length) console.error(`\nother requests: ${captured.other.join(', ')}`)
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n- ${problems.join('\n- ')}`)
}
if (keep) {
  const out = join(config, 'e2e-captures.json')
  writeFileSync(out, JSON.stringify({ captured, run }, null, 2))
  console.log(`kept: ${out}`)
} else {
  rmSync(config, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}

if (problems.length) process.exit(1)
console.log('the copy matches the exporter')
