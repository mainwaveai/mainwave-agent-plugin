#!/usr/bin/env node
// End to end: one real `claude -p` session with the plugin loaded, its model answered by a local mock of the Anthropic API, and both
// paths of its telemetry received locally: Claude Code's own OTLP exporter (logs, traces and metrics), and the plugin's copy (sent to
// Mainwave's dev collector, which tests/e2e/redirect sends here instead). Nothing leaves the machine.
//
//   logs     every record is paired with its twin by session, event name and sequence, and compared field by field.
//   traces   every span is paired with its twin by what identifies it (an interaction or permission span by its id, a request by
//            its request id, a tool call and its run by the call's id), and compared field by field: ids, parents, times, attributes.
//   metrics  every series (a metric and its attributes) is summed on each path, as Mainwave reads metrics, and the sums compared;
//            each point's type, temporality and times are checked too.
//
// A difference the plugin cannot avoid is a known difference: reported with its count, never failed and never hidden. Any other
// difference fails.
//
// The mock model answers each request after a different delay (300 to 900 ms), so a request paired with the wrong step, or timed
// from the wrong start, lands outside the tolerance; and it refuses one request once as overloaded, so Claude Code retries it. The
// session runs twice: once with prompts and tool details logged (OTEL_LOG_USER_PROMPTS, OTEL_LOG_TOOL_DETAILS), once with neither,
// so both sides of those settings are compared.
//
//   node tests/e2e/compare.mjs            # exit 0 when the copy matches the exporter
//   node tests/e2e/compare.mjs --keep     # keep the captures and the session's config folder, and print where
//
// Needs `claude` and `git` on PATH. The session runs in a fresh CLAUDE_CONFIG_DIR with an API key, so no login and no
// organization's settings reach it.

import { execFileSync, spawn } from 'node:child_process'
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
/** An example organization, put on every record through the resource so the plugin's stamping path runs as in a real organization. */
const ORG = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
/** How far a rebuilt span's start or end may be from the exporter's: the plugin times spans from the hooks around them. */
const TIME_TOLERANCE_MS = 50
/** How far a metric point's start or end may be: the plugin's collections run on its own clock, from when it loads. */
const METRIC_TIME_TOLERANCE_MS = 250

// ── The mock model ───────────────────────────────────────────────────────────
// The main loop's prompt names a script of tool calls, one per request; the subagent's prompt names its own. Every other request
// (a title, a summary) gets a short text answer. Each response's usage is distinct, so each request can be told apart by it.

let work = ''
let messageId = 0
const textOf = c => (typeof c === 'string' ? c : (c ?? []).map(b => (b?.type === 'text' ? b.text : '')).join(' '))
function modelReply(req) {
  const id = `msg_e2e_${++messageId}`
  const usage = { input_tokens: 1200 + messageId, output_tokens: 20 + messageId, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }
  const first = textOf(req.messages?.[0]?.content)
  const tools = (req.tools ?? []).map(t => t?.name)
  const results = (req.messages ?? []).flatMap(m => (Array.isArray(m.content) ? m.content.filter(b => b?.type === 'tool_result') : []))
  const call = (name, input) => ({ type: 'tool_use', id: `toolu_e2e_${messageId}`, name, input })
  let script = []
  if (tools.includes('Bash') && first.includes('E2E_SUBTASK')) script = [call('Bash', { command: 'echo sub', description: 'Print sub' })]
  else if (tools.includes('Bash') && first.includes('E2E_MAINTASK')) {
    script = [
      call('Bash', { command: 'echo e2e', description: 'Print e2e' }),
      call('Write', { file_path: join(work, 'a.txt'), content: 'one\ntwo\n' }),
      call('Edit', { file_path: join(work, 'a.txt'), old_string: 'two', new_string: 'three' }),
      call('Bash', { command: 'git -c user.name=e2e -c user.email=e2e@example.com commit -q --allow-empty -m e2e', description: 'Commit' }),
      call('Bash', { command: 'touch refused.txt', description: 'Not allowed' }),
      call('Agent', { description: 'Sub run', prompt: 'E2E_SUBTASK: run echo sub', subagent_type: 'general-purpose' }),
    ]
  }
  const block = results.length < script.length ? script[results.length] : { type: 'text', text: 'ok' }
  return { id, block, stop: block.type === 'tool_use' ? 'tool_use' : 'end_turn', usage }
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

const SIGNALS = ['logs', 'traces', 'metrics']
let captured

function readBody(req) {
  return new Promise(resolveBody => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
  })
}

let overloaded = false
const server = createServer(async (req, res) => {
  const body = await readBody(req)
  const path = (req.url ?? '').split('?')[0]
  if (req.method === 'POST' && path === '/v1/messages') {
    const parsed = JSON.parse(body)
    // The main loop's second request is refused once as overloaded: Claude Code retries it, and logs only the attempt that answered.
    const results = (parsed.messages ?? []).flatMap(m => (Array.isArray(m.content) ? m.content.filter(b => b?.type === 'tool_result') : []))
    if (!overloaded && results.length === 1 && textOf(parsed.messages?.[0]?.content).includes('E2E_MAINTASK')) {
      overloaded = true
      res.writeHead(529, { 'content-type': 'application/json', 'request-id': 'req_e2e_overloaded' })
      return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
    }
    await new Promise(r => setTimeout(r, 300 + ((messageId + 1) * 397) % 600))
    if (parsed.stream) return sse(res, parsed)
    const { id, block, stop, usage } = modelReply(parsed)
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_e2e_${messageId}` })
    return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: parsed.model, content: [block], stop_reason: stop, stop_sequence: null, usage }))
  }
  const signal = SIGNALS.find(s => path === `/v1/${s}` || path === `/plugin/v1/${s}`)
  if (req.method === 'POST' && signal) {
    captured[path.startsWith('/plugin/') ? 'plugin' : 'exporter'][signal].push({ auth: req.headers['authorization'], type: req.headers['content-type'], body })
  } else {
    captured.other.push(`${req.method} ${path}`)
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"partialSuccess":{}}')
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// ── The session ──────────────────────────────────────────────────────────────

/** One session, its telemetry captured. `details` turns prompt and tool-detail logging on. */
async function session(details) {
  captured = { exporter: { logs: [], traces: [], metrics: [] }, plugin: { logs: [], traces: [], metrics: [] }, other: [] }
  messageId = 0
  overloaded = false
  const config = mkdtempSync(join(tmpdir(), 'mainwave-e2e-'))
  work = mkdtempSync(join(tmpdir(), 'mainwave-e2e-work-'))
  // A repository, so the session's git commit has somewhere to go. Its config is the command's own: no user or system config is read.
  const git = (...a) => execFileSync('git', a, { cwd: work, env: { PATH: process.env.PATH, HOME: work, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
  const settings = JSON.stringify({ pluginConfigs: { 'mainwave@inline': { options: { devIngestKey: PLUGIN_KEY } }, mainwave: { options: { devIngestKey: PLUGIN_KEY } } } })

  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: 'sk-ant-e2e-not-a-key',
    ANTHROPIC_BASE_URL: base,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    // All three signals, as Mainwave's org-wide setup turns them on, and the beta that gives Claude Code spans and ties rows to them.
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: base,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${EXPORTER_KEY}`,
    OTEL_LOGS_EXPORT_INTERVAL: '500',
    OTEL_TRACES_EXPORT_INTERVAL: '500',
    // The metric interval stays at its default (a minute), so each path collects once, as the session ends: one point per series.
    OTEL_RESOURCE_ATTRIBUTES: `mainwave.source=coding_agent.claude_code,service.name=claude-code,deployment.environment=e2e,organization.id=${ORG}`,
    ...(details ? { OTEL_LOG_USER_PROMPTS: '1', OTEL_LOG_TOOL_DETAILS: '1' } : {}),
    MW_E2E_RECEIVER: `${base}/plugin`,
  }

  const args = [
    '-p', 'E2E_MAINTASK: run the steps, then say ok.',
    '--plugin-dir', root,
    '--plugin-dir', join(here, 'redirect'),
    '--settings', settings,
    '--allowedTools', 'Bash(echo e2e),Bash(echo sub),Bash(git -c user.name=e2e -c user.email=e2e@example.com commit:*),Write,Edit,Agent',
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
  return { captured, run, config, work }
}

// ── Reading what arrived ─────────────────────────────────────────────────────

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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const ms = nanos => Number(BigInt(nanos) / 1000n) / 1000
const without = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.has(k)))

function logRecordsOf(posts) {
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

function spansOf(posts) {
  const out = []
  for (const { body } of posts) {
    for (const rs of JSON.parse(body).resourceSpans ?? []) {
      const resource = kvs(rs.resource?.attributes)
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) out.push({ ...s, resource, scope: ss.scope ?? {}, attrs: kvs(s.attributes), startMs: ms(s.startTimeUnixNano), endMs: ms(s.endTimeUnixNano) })
      }
    }
  }
  return out
}

function pointsOf(posts) {
  const out = []
  for (const { body } of posts) {
    for (const rm of JSON.parse(body).resourceMetrics ?? []) {
      const resource = kvs(rm.resource?.attributes)
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          const kind = m.sum ? 'sum' : m.gauge ? 'gauge' : m.histogram ? 'histogram' : 'other'
          const data = m.sum ?? m.gauge ?? m.histogram ?? {}
          for (const p of data.dataPoints ?? []) {
            out.push({
              name: m.name, description: m.description, unit: m.unit, kind, temporality: data.aggregationTemporality, monotonic: data.isMonotonic,
              resource, scope: sm.scope ?? {}, attrs: kvs(p.attributes), valueType: 'asDouble' in p ? 'double' : 'asInt' in p ? 'int' : 'none',
              value: Number(p.asDouble ?? p.asInt ?? 0), startMs: ms(p.startTimeUnixNano), timeMs: ms(p.timeUnixNano),
            })
          }
        }
      }
    }
  }
  return out
}

// ── The comparison ───────────────────────────────────────────────────────────

const problems = []

/** Compares one session's two paths, adding what differs to `problems`, and prints what it found. */
function compare(pass, details, { captured, run }) {
  const before = problems.length
  /** Known differences: what the plugin cannot reproduce, by what it is, with how often it was seen. */
  const known = new Map()
  const noteKnown = (what, n = 1) => known.set(what, (known.get(what) ?? 0) + n)
  const fieldDiffs = new Map()
  const noteDiff = (what, k) => fieldDiffs.set(what, [...(fieldDiffs.get(what) ?? []), k])

  if (run.code !== 0) problems.push(`claude exited ${run.code}:\n${run.out.slice(-2000)}`)
  for (const s of SIGNALS) {
    for (const p of captured.exporter[s]) if (p.auth !== `Bearer ${EXPORTER_KEY}`) problems.push(`an exporter ${s} request without the exporter key`)
    for (const p of captured.plugin[s]) {
      if (p.auth !== `Bearer ${PLUGIN_KEY}`) problems.push(`a plugin ${s} request without the person's dev key`)
      if (p.body.includes(PLUGIN_KEY) || p.body.includes(EXPORTER_KEY)) problems.push(`a key inside a plugin ${s} request body`)
    }
    if (captured.exporter[s].length === 0) problems.push(`the exporter sent no ${s}`)
    if (captured.plugin[s].length === 0) problems.push(`the plugin sent no ${s}`)
  }

  /** The resource of a plugin record against the exporter's: the same but for the host detectors' keys. */
  function compareResource(kind, e, p, k) {
    for (const a of new Set([...Object.keys(e), ...Object.keys(p)])) {
      if (HOST_ONLY.has(a) && p[a] === undefined) continue
      if (!same(e[a], p[a])) noteDiff(`${kind} resource ${a}: exporter ${JSON.stringify(e[a])}, plugin ${JSON.stringify(p[a])}`, k)
    }
  }

  // Logs.
  const exporterLogs = logRecordsOf(captured.exporter.logs)
  const pluginLogs = logRecordsOf(captured.plugin.logs)
  const byKey = (list, what) => {
    const m = new Map()
    for (const r of list) {
      if (m.has(r.key)) problems.push(`two ${what} for ${r.key} on one path`)
      m.set(r.key, r)
    }
    return m
  }
  const ex = byKey(exporterLogs, 'records')
  const pl = byKey(pluginLogs, 'records')
  const onlyExporter = [...ex.keys()].filter(k => !pl.has(k))
  const onlyPlugin = [...pl.keys()].filter(k => !ex.has(k))
  for (const k of onlyPlugin) problems.push(`the plugin sent ${k}, which the exporter did not`)
  // Rows Claude Code raises while it starts are a known gap, reported, not failed. Any other row the exporter sent alone is a failure.
  const beforePlugin = onlyExporter.filter(k => STARTUP.has(ex.get(k).attributes['event.name']?.v))
  for (const k of onlyExporter) if (!beforePlugin.includes(k)) problems.push(`the exporter sent ${k}, which the plugin did not`)
  if (beforePlugin.length) noteKnown(`logs: startup rows raised before any plugin loads (${[...new Set(beforePlugin.map(k => k.split('|')[1]))].join(', ')})`, beforePlugin.length)
  const matched = [...ex.values()].filter(r => pl.has(r.key))
  if (!matched.some(r => r.attributes['mainwave.mod.name']?.v === 'mainwave')) problems.push("no matched row carries the plugin's stamps")
  if (!matched.some(r => /^[0-9a-f]{32}$/.test(r.traceId) && /^[0-9a-f]{16}$/.test(r.spanId))) problems.push('no matched row carries a trace and span id')
  if (!matched.some(r => r.attributes['event.name']?.v === 'api_request')) problems.push('no api_request row was matched')
  for (const [k, e] of ex) {
    const p = pl.get(k)
    if (p === undefined) continue
    for (const f of ['time', 'body', 'traceId', 'spanId']) if (!same(e[f], p[f])) noteDiff(`log ${f}: exporter ${JSON.stringify(e[f])}, plugin ${JSON.stringify(p[f])}`, k)
    if (!same(e.scope.name, p.scope.name)) noteDiff(`log scope name: ${e.scope.name} vs ${p.scope.name}`, k)
    for (const a of new Set([...Object.keys(e.attributes), ...Object.keys(p.attributes)])) {
      if (a === ROUTE) continue
      if (!same(e.attributes[a], p.attributes[a])) noteDiff(`log attribute ${a}: exporter ${JSON.stringify(e.attributes[a])}, plugin ${JSON.stringify(p.attributes[a])}`, k)
    }
    if (e.attributes[ROUTE] !== undefined && e.attributes[ROUTE]?.v !== 'exporter') noteDiff(`exporter route ${JSON.stringify(e.attributes[ROUTE])}`, k)
    if (p.attributes[ROUTE]?.v !== 'plugin') noteDiff(`log plugin route ${JSON.stringify(p.attributes[ROUTE])}`, k)
    compareResource('log', e.resource, p.resource, k)
  }

  // Traces.
  const exporterSpans = spansOf(captured.exporter.traces)
  const pluginSpans = spansOf(captured.plugin.traces)
  /** What identifies a span across the two paths: the span id where the rows name it, else what the span is about. */
  function spanKey(s) {
    const a = s.attrs
    switch (s.name) {
      case 'claude_code.interaction':
      case 'claude_code.tool.blocked_on_user':
        return `${s.name}|${s.spanId}`
      case 'claude_code.llm_request':
        return `${s.name}|${a.request_id?.v}`
      case 'claude_code.tool':
      case 'claude_code.tool.execution':
        return `${s.name}|${a.tool_use_id?.v}`
      default:
        return `${s.name}|${s.spanId}`
    }
  }
  /** The span ids the plugin cannot know: no row carries them, so it makes its own. Their parents' ids follow. */
  const NEW_IDS = new Set(['claude_code.llm_request', 'claude_code.tool', 'claude_code.tool.execution'])
  /** Attributes whose values are times the plugin measures around the exporter's own: compared within the tolerance. */
  const TIMED = new Set(['duration_ms', 'interaction.duration_ms'])
  /** Attributes the plugin reads from a row's nearest counterpart: reported when they differ, as known. */
  const APPROXIMATE = new Map([
    ['first_content_ms', 'llm_request first_content_ms is the row\'s ttft_ms (Claude Code times the first content block itself)'],
  ])

  const exSpans = new Map()
  const plSpans = new Map()
  for (const [list, m, who] of [[exporterSpans, exSpans, 'exporter'], [pluginSpans, plSpans, 'plugin']]) {
    for (const s of list) {
      const k = spanKey(s)
      if (m.has(k)) problems.push(`two ${who} spans for ${k}`)
      m.set(k, s)
    }
  }
  const exById = new Map(exporterSpans.map(s => [s.spanId, s]))
  const plById = new Map(pluginSpans.map(s => [s.spanId, s]))
  for (const k of exSpans.keys()) if (!plSpans.has(k)) problems.push(`the exporter sent span ${k}, which the plugin did not`)
  for (const k of plSpans.keys()) if (!exSpans.has(k)) problems.push(`the plugin sent span ${k}, which the exporter did not`)
  for (const name of ['claude_code.interaction', 'claude_code.llm_request', 'claude_code.tool', 'claude_code.tool.blocked_on_user', 'claude_code.tool.execution']) {
    if (![...exSpans.keys()].some(k => k.startsWith(`${name}|`) && plSpans.has(k))) problems.push(`no ${name} span was matched`)
  }
  // The session ran with the settings it was meant to: the exporter's own spans show them, so the copy's are compared on that side.
  const commands = exporterSpans.filter(s => s.name === 'claude_code.tool' && s.attrs.tool_name?.v === 'Bash')
  const prompts = exporterSpans.filter(s => s.name === 'claude_code.interaction').map(s => s.attrs.user_prompt?.v)
  if (details && !commands.some(s => s.attrs.full_command)) problems.push('with tool details logged, no exporter Bash span carries its command')
  if (!details && commands.some(s => s.attrs.full_command)) problems.push('with tool details not logged, an exporter Bash span carries its command')
  if (!details && prompts.some(p => p !== '<REDACTED>')) problems.push('with prompts not logged, an exporter interaction carries its prompt')
  // The retried request is in the session: the exporter's span says so, by its attempt.
  if (!exporterSpans.some(s => s.name === 'claude_code.llm_request' && Number(s.attrs.attempt?.v) > 1)) problems.push('no retried request in the session')
  const worstTime = { span: 0, metric: 0 }
  for (const [k, e] of exSpans) {
    const p = plSpans.get(k)
    if (p === undefined) continue
    if (e.traceId !== p.traceId) noteDiff(`span traceId (${e.name})`, k)
    if (e.spanId !== p.spanId) {
      if (NEW_IDS.has(e.name) && !(e.name === 'claude_code.tool.execution' && e.attrs.tool_use_id && exporterSpans.some(c => c.parentSpanId === e.spanId && c.name !== 'claude_code.tool.blocked_on_user'))) noteKnown(`traces: ${e.name} span id is the plugin's own (no row carries it)`)
      else noteDiff(`span spanId (${e.name}): exporter ${e.spanId}, plugin ${p.spanId}`, k)
    }
    // A parent is right when it is the same span: the same id, or the plugin's twin of the exporter's parent.
    const eParent = e.parentSpanId ? exById.get(e.parentSpanId) : undefined
    const pParent = p.parentSpanId ? plById.get(p.parentSpanId) : undefined
    if (!e.parentSpanId !== !p.parentSpanId) noteDiff(`span parent present (${e.name}): exporter ${e.parentSpanId ?? '-'}, plugin ${p.parentSpanId ?? '-'}`, k)
    else if (e.parentSpanId && e.parentSpanId !== p.parentSpanId) {
      if (eParent && pParent && spanKey(eParent) === spanKey(pParent) && NEW_IDS.has(eParent.name)) noteKnown(`traces: ${e.name} parent is the plugin's own id for the same ${eParent.name}`)
      else noteDiff(`span parent (${e.name}): exporter ${eParent ? spanKey(eParent) : e.parentSpanId}, plugin ${pParent ? spanKey(pParent) : p.parentSpanId}`, k)
    }
    for (const f of ['kind', 'flags']) if (!same(e[f], p[f])) noteDiff(`span ${f} (${e.name}): exporter ${JSON.stringify(e[f])}, plugin ${JSON.stringify(p[f])}`, k)
    if (!same(e.status, p.status)) noteDiff(`span status (${e.name}): exporter ${JSON.stringify(e.status)}, plugin ${JSON.stringify(p.status)}`, k)
    if (!same(e.scope, p.scope)) noteDiff(`span scope: exporter ${JSON.stringify(e.scope)}, plugin ${JSON.stringify(p.scope)}`, k)
    // A request Claude Code retried: its row names only the attempt that answered, so the copy reports one attempt. That much is known;
    // any other difference in attempts or events is not.
    const retried = e.name === 'claude_code.llm_request' && Number(e.attrs.attempt?.v) > 1 && (e.events ?? []).length === Number(e.attrs.attempt.v)
      && p.attrs.attempt?.v === 1 && (p.events ?? []).length === 1
    if (retried) noteKnown('traces: a retried llm_request reports attempt 1 and one attempt event (its row names only the attempt that answered)')
    else if (!same((e.events ?? []).map(v => [v.name, kvs(v.attributes)]), (p.events ?? []).map(v => [v.name, kvs(v.attributes)]))) noteDiff(`span events (${e.name})`, k)
    if (!same(e.links ?? [], p.links ?? [])) noteDiff(`span links (${e.name})`, k)
    for (const [f, ef, pf] of [['start', e.startMs, p.startMs], ['end', e.endMs, p.endMs]]) {
      const d = Math.abs(ef - pf)
      worstTime.span = Math.max(worstTime.span, d)
      if (d > TIME_TOLERANCE_MS) noteDiff(`span ${f} (${e.name}) ${d.toFixed(1)} ms from the exporter's`, k)
    }
    // Every key, in order: Mainwave fingerprints a span by its whole set of attribute keys.
    const eKeys = Object.keys(e.attrs).filter(a => a !== ROUTE)
    const pKeys = Object.keys(p.attrs).filter(a => a !== ROUTE)
    if (!same(eKeys, pKeys)) noteDiff(`span attribute keys (${e.name}): exporter [${eKeys.join(', ')}], plugin [${pKeys.join(', ')}]`, k)
    for (const a of new Set([...eKeys, ...pKeys])) {
      if (same(e.attrs[a], p.attrs[a])) continue
      if (retried && a === 'attempt') continue
      if (TIMED.has(a) && e.attrs[a]?.t === p.attrs[a]?.t && Math.abs(Number(e.attrs[a].v) - Number(p.attrs[a].v)) <= TIME_TOLERANCE_MS) {
        noteKnown(`traces: ${e.name} ${a} timed by the plugin, within ${TIME_TOLERANCE_MS} ms`)
        continue
      }
      if (APPROXIMATE.has(a) && e.attrs[a]?.t === p.attrs[a]?.t) {
        noteKnown(`traces: ${APPROXIMATE.get(a)}`)
        continue
      }
      noteDiff(`span attribute ${a} (${e.name}): exporter ${JSON.stringify(e.attrs[a])}, plugin ${JSON.stringify(p.attrs[a])}`, k)
    }
    if (p.attrs[ROUTE]?.v !== 'plugin') noteDiff(`span plugin route ${JSON.stringify(p.attrs[ROUTE])}`, k)
    compareResource('span', e.resource, p.resource, k)
  }

  // Metrics.
  const exporterPoints = pointsOf(captured.exporter.metrics)
  const pluginPoints = pointsOf(captured.plugin.metrics)
  const seriesOf = p => `${p.name} ${JSON.stringify(Object.entries(without(p.attrs, new Set([ROUTE]))).sort())}`
  const sums = list => {
    const m = new Map()
    for (const p of list) {
      const k = seriesOf(p)
      const s = m.get(k) ?? { value: 0, points: [] }
      s.value += p.value
      s.points.push(p)
      m.set(k, s)
    }
    return m
  }
  const exSeries = sums(exporterPoints)
  const plSeries = sums(pluginPoints)
  for (const k of exSeries.keys()) if (!plSeries.has(k)) problems.push(`the exporter sent series ${k}, which the plugin did not`)
  for (const k of plSeries.keys()) if (!exSeries.has(k)) problems.push(`the plugin sent series ${k}, which the exporter did not`)
  for (const name of ['claude_code.cost.usage', 'claude_code.token.usage', 'claude_code.lines_of_code.count', 'claude_code.commit.count']) {
    if (![...exSeries.keys()].some(k => k.startsWith(`${name} `) && plSeries.has(k))) problems.push(`no ${name} series was matched`)
  }
  for (const [k, e] of exSeries) {
    const p = plSeries.get(k)
    if (p === undefined) continue
    const timed = k.startsWith('claude_code.active_time.total ')
    if (timed && Math.abs(e.value - p.value) * 1000 <= TIME_TOLERANCE_MS) {
      if (e.value !== p.value) noteKnown(`metrics: active_time.total is the turns' time as the plugin measures it, within ${TIME_TOLERANCE_MS} ms`)
    } else if (Math.abs(e.value - p.value) > 1e-9 * Math.max(1, Math.abs(e.value))) noteDiff(`metric sum: exporter ${e.value}, plugin ${p.value}`, k)
    else if (e.value !== p.value) noteKnown('metrics: a sum differs past the 15th digit (floating point order)')
    if (e.points.length !== p.points.length) noteDiff(`metric points: exporter ${e.points.length}, plugin ${p.points.length}`, k)
    const [ep, pp] = [e.points[0], p.points[0]]
    for (const f of ['description', 'unit', 'kind', 'temporality', 'monotonic', 'valueType']) if (!same(ep[f], pp[f])) noteDiff(`metric ${f}: exporter ${JSON.stringify(ep[f])}, plugin ${JSON.stringify(pp[f])}`, k)
    if (!same(ep.scope, pp.scope)) noteDiff(`metric scope: exporter ${JSON.stringify(ep.scope)}, plugin ${JSON.stringify(pp.scope)}`, k)
    if (pp.attrs[ROUTE]?.v !== 'plugin') noteDiff(`metric plugin route ${JSON.stringify(pp.attrs[ROUTE])}`, k)
    for (const [f, ef, pf] of [['start', ep.startMs, pp.startMs], ['time', ep.timeMs, pp.timeMs]]) {
      const d = Math.abs(ef - pf)
      worstTime.metric = Math.max(worstTime.metric, d)
      if (d > METRIC_TIME_TOLERANCE_MS) noteDiff(`metric ${f} ${d.toFixed(1)} ms from the exporter's`, k)
      else if (d > 0) noteKnown(`metrics: point ${f} taken by the plugin's own clock, within ${METRIC_TIME_TOLERANCE_MS} ms`)
    }
    compareResource('metric', ep.resource, pp.resource, k)
  }

  for (const [what, keys] of fieldDiffs) problems.push(`${what} (${keys.length} record${keys.length === 1 ? '' : 's'}, e.g. ${keys[0]})`)

  const count = list => [...list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())].map(([n, c]) => `${n} ${c}`).join(', ')
  console.log(`logs: exporter ${exporterLogs.length}, plugin ${pluginLogs.length}; matched ${matched.length}`)
  console.log(`  events: ${count([...ex.values()].map(r => r.attributes['event.name']?.v))}`)
  console.log(`traces: exporter ${exporterSpans.length}, plugin ${pluginSpans.length}; matched ${[...exSpans.keys()].filter(k => plSpans.has(k)).length}`)
  console.log(`  spans: ${count(exporterSpans.map(s => s.name.replace('claude_code.', '')))}`)
  console.log(`metrics: exporter ${exporterPoints.length} points in ${exSeries.size} series, plugin ${pluginPoints.length} in ${plSeries.size}`)
  console.log(`  series: ${count([...exSeries.keys()].map(k => k.split(' ')[0].replace('claude_code.', '')))}`)
  console.log(`worst time difference: spans ${worstTime.span.toFixed(1)} ms, metric points ${worstTime.metric.toFixed(1)} ms (tolerances ${TIME_TOLERANCE_MS} and ${METRIC_TIME_TOLERANCE_MS} ms)`)
  const hostOnly = [...HOST_ONLY].filter(k => exporterLogs[0]?.resource[k] !== undefined)
  if (hostOnly.length) noteKnown(`all signals: the copy's resource has no ${hostOnly.join(', ')}`)
  if (known.size) console.log(`known differences:\n${[...known].map(([w, n]) => `  - ${w} (${n})`).join('\n')}`)
  for (let i = before; i < problems.length; i++) problems[i] = `${pass}: ${problems[i]}`
}

const passes = [['prompts and tool details logged', true], ['prompts and tool details not logged', false]]
const results = []
for (const [pass, details] of passes) {
  console.log(`\n${pass}:`)
  const result = await session(details)
  results.push(result)
  compare(pass, details, result)
}
server.close()

if (problems.length) {
  // What each session itself said about the plugins, and what the plugin kept: enough to see why without --keep.
  for (const { config, captured } of results) {
    const debug = join(config, 'debug.log')
    if (existsSync(debug)) {
      const lines = readFileSync(debug, 'utf8').split('\n').filter(l => /mainwave|plugin|hook|telemetry|http/i.test(l))
      console.error(`\ndebug log, plugin lines (${lines.length}):\n${lines.slice(-80).join('\n')}`)
    }
    const store = join(config, 'plugins', 'store')
    if (existsSync(store)) for (const f of readdirSync(store)) if (f.startsWith('mainwave')) console.error(`\nstore ${f}: ${readFileSync(join(store, f), 'utf8').slice(0, 1500)}`)
    if (captured.other.length) console.error(`\nother requests: ${captured.other.join(', ')}`)
  }
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n- ${problems.join('\n- ')}`)
}
for (const { captured, run, config, work } of results) {
  if (keep) {
    const out = join(config, 'e2e-captures.json')
    writeFileSync(out, JSON.stringify({ captured, run }, null, 2))
    console.log(`kept: ${out}`)
  } else {
    rmSync(config, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
}

if (problems.length) process.exit(1)
console.log('the copy matches the exporter')
