#!/usr/bin/env node
// End to end: one real `claude -p` session with the plugin loaded, its model answered by a local mock of the Anthropic API, and both
// paths of its telemetry received locally: Claude Code's own OTLP exporter (logs, traces and metrics), and the plugin's copy. With the
// env block, the person's own settings name this receiver as the plugin's collector (`collectorUrl`); without it, the copy goes to
// Mainwave's production collector, its default, which the test-only hooks in tests/e2e/redirect.ts send here instead, on a path of
// its own, so the pass proves where the copy was meant to go. Nothing leaves the machine.
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
// A third pass runs the same session without Mainwave's env block: no telemetry settings at all, so Claude Code's exporter sends
// nothing and no row names a span, and the plugin sends to production's collector, keyless (no settings, its default). There is
// nothing to compare with. In every pass the receiver plays keyless ingest for the plugin's requests: it refuses a request with an
// Authorization header (401), or one whose records, spans or data points do not each carry one `organization.id` and one
// `user.email`, the same pair across the request (400). Each pass fails on any refusal, and on a request that went anywhere but where
// it was meant to: the receiver the settings name with the env block, production's collector without it. This pass also checks that the spans make one trace per interaction: the interaction a root, the main loop's requests and calls its
// children, each call's decision and run the call's, and a subagent's requests and calls under its Agent call's run. The session runs
// on an API key, so its rows name an organization and an email only through OTEL_RESOURCE_ATTRIBUTES, which stands in for what an
// account's login puts on them. It also checks the plugin's defaults: with no settings at all, the copy carries required and metadata
// data points (a command's class, a subagent's type, a failed call's error class) and no identifier or content: no command, file
// path, tool input or output, repository, prompt or response.
//
// The plugin asks Mainwave for its organization's data collection settings once the rows name the organization and email, on the API
// beside the collector the copy goes to. In the keyless pass that is production's API, which the test-only hooks send here too, and
// the receiver answers as Mainwave's settings API would, with settings that turn a metadata data point off (`file.kind`) and add a
// redaction pack; with the env block it is the receiver the person's settings name, which answers as the route off, so the explicit
// settings below stand. The keyless pass checks the request carried the organization and email alone, that the answer was kept in the store with
// its organization, and that the copy went without the data point turned off. (The pass sends no content, so the pack is checked as
// kept, not as run: the unit tests run it.)
//
// The mock model answers each request after a different delay (300 to 900 ms), so a request paired with the wrong step, or timed
// from the wrong start, lands outside the tolerance; and it refuses one request once as overloaded, so Claude Code retries it. The
// session runs twice: once with Mainwave's org-wide setup captures on (OTEL_LOG_TOOL_DETAILS, OTEL_LOG_TOOL_CONTENT,
// OTEL_LOG_USER_PROMPTS, OTEL_METRICS_INCLUDE_REPOSITORY), once with each set to 0, as the setup writes a capture an admin turns off,
// so both sides of those settings are compared. Both run with explicit settings in the plugin's store that turn on the identifiers
// and content those captures govern (on, then as Claude Code sends them), as an organization's settings would: off by default, they
// would otherwise leave nothing of them to compare. The first runs in auto mode, so auto mode's classifier judges the command no rule
// allows, and the mock blocks it. Claude Code logs no row for the classifier's requests, so the plugin cannot see them: the
// exporter's spans of a request it logged no row for are a known difference, and so is its count of them in cost.usage and
// token.usage, where it counts them (the tokens checked against those spans'); the pass fails if the classifier asked nothing.
//
//   node tests/e2e/compare.mjs            # exit 0 when the copy matches the exporter and the keyless pass is coherent
//   node tests/e2e/compare.mjs --keep     # keep the captures and the session's config folder, and print where
//
// Needs `claude` and `git` on PATH. The session runs in a fresh CLAUDE_CONFIG_DIR with an API key, so no login and no
// organization's settings reach it but the explicit settings above.

import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const keep = process.argv.includes('--keep')

const EXPORTER_KEY = 'exporter_e2e_key_0001'
/** Resource keys only the OpenTelemetry SDK's host detectors add; a plugin has nothing to read them from. */
const HOST_ONLY = new Set(['os.type', 'os.version', 'host.arch'])
/** Attribute keys that differ by design between the two paths. */
const ROUTE = 'mainwave.telemetry.route'
/** What a shell command did, which the plugin stamps on the command's tool span for Mainwave and Claude Code never sends. */
const COMMAND_STAMP = 'mainwave.command.'
/** The Claude Code version the sessions run on, as `claude --version` prints it. */
const CLAUDE_VERSION = execFileSync('claude', ['--version']).toString().trim().split(/\s+/)[0]
const atLeast = (version, floor) => {
  const [a, b] = [version, floor].map(v => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return true
}
/**
 * Rows Claude Code raises while it starts, before any plugin's hooks are registered, which no plugin sees. Up to 2.1.325 its
 * `plugin_loaded` rows were among them; from 2.1.326 Claude Code hands them to the plugins once they are loaded, so the copy must
 * have them.
 */
const STARTUP = new Set(['managed_settings_resolved', ...(atLeast(CLAUDE_VERSION, '2.1.326') ? [] : ['plugin_loaded'])])
/** The classifiers whose model requests Claude Code logs no row for, which the README lists as a gap. */
const CLASSIFIERS = new Set(['auto_mode', 'agent_classifier'])
/** The plugin's markers (hooks/markers.ts): spans of its own, of which Claude Code sends none. */
const MARKER_SPANS = new Set(['vcs.commit.created', 'vcs.change.opened', 'work.item.created', 'work.item.updated', 'mainwave.subscription.snapshot', 'mainwave.claude_code.stop_failure'])
/** The captures Mainwave's org-wide setup sets in the env block. */
const CAPTURES = ['OTEL_LOG_TOOL_DETAILS', 'OTEL_LOG_TOOL_CONTENT', 'OTEL_LOG_USER_PROMPTS', 'OTEL_METRICS_INCLUDE_REPOSITORY']
/**
 * The identifiers and content Claude Code sends with those captures on, all off by default. With the env block, the session runs
 * with explicit settings that turn them on, as an organization's settings would, so the copy carries what the exporter does.
 */
const CAPTURED_DATA_POINTS = ['repo', 'file.path', 'web.url', 'bash.command', 'tool.input', 'tool.result', 'prompt.text', 'response.text']
/**
 * Where Claude Code keeps a plugin's store in a config folder: `plugins/store/<name>_<marketplace>-<first 12 hex of the plugin id's
 * SHA-256>.json`, one JSON object of its keys. The plugin, loaded from a folder, is `mainwave@inline`.
 */
const storeFile = (config, id = 'mainwave@inline') => join(config, 'plugins', 'store', `${id.replace('@', '_')}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}.json`)
/** An example organization, put on every record through the resource so the plugin's stamping path runs as in a real organization. */
const ORG = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
/** An example person in it, put on every record, as a login would: keyless ingest routes by the pair. */
const EMAIL = 'e2e@example.com'
/** Where the plugin asks for its organization's settings, on Mainwave's API or the receiver the person's settings name. */
const SETTINGS_PATH = '/api/plugin/data-collection-settings'
/** What the receiver answers the keyless pass's request for settings with, as Mainwave's settings API would. */
const SETTINGS = { revision: 5, catalog_version: 1, data_points: { 'file.kind': 'off' }, in_force: { 'file.kind': 'off' }, redaction_packs: ['secrets', 'pii.contact'], default_data_points: [], redaction_packs_default: false }
/**
 * How far a rebuilt span's start or end may be from the exporter's: the plugin times spans from the hooks around them, and on a cold,
 * slow machine the session's first model request can start a hundred milliseconds before Claude Code's span does (its setup runs
 * between the two). The mock's delays differ by 200 ms or more from one request to the next, so a request timed from the wrong step
 * still lands outside it.
 */
const TIME_TOLERANCE_MS = 150
/** How far a metric point's start or end may be: the plugin's collections run on its own clock, from when it loads. */
const METRIC_TIME_TOLERANCE_MS = 250
/** How far the session count's start may be: Claude Code counts the session before any plugin loads, the plugin once it has. */
const SESSION_COUNT_TOLERANCE_MS = 2_000

// ── The mock model ───────────────────────────────────────────────────────────
// The main loop's prompt names a script of tool calls, one per request; the subagent's prompt names its own. Auto mode's classifier
// blocks the command meant to be refused and allows anything else it is asked about (such as the Agent call). Every other request
// (a title, a summary) gets a short text answer. Each response's usage is distinct, so each request can be told apart by it.

/** The command meant to be refused. If it ever runs, it is a GET to a closed loopback port, its output dropped, within 2 seconds. */
const REFUSED = 'curl -s -m 2 -o /dev/null http://127.0.0.1:9/'
let work = ''
let messageId = 0
/** What the mock's classifier was asked in the session: how many requests, and how many of them about the refused command. */
let classified = { asked: 0, refused: 0 }
const textOf = c => (typeof c === 'string' ? c : (c ?? []).map(b => (b?.type === 'text' ? b.text : '')).join(' '))
/** Auto mode's classifier: a request outside the conversation (not streamed) whose instructions ask for a severity or a block. */
const isClassifier = req => !req.stream && /<severity>|<block>/.test(textOf(req.system))
/** What the classifier is asked about: the last line of the transcript it is shown, in one message or across several. */
const classifiedAction = req => {
  const all = (req.messages ?? []).map(m => textOf(m.content)).join('\n')
  return all.split('<transcript>').at(-1).split('</transcript>')[0].trim().split('\n').at(-1) ?? ''
}
function modelReply(req) {
  const id = `msg_e2e_${++messageId}`
  const usage = { input_tokens: 1200 + messageId, output_tokens: 20 + messageId, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }
  // The classifier's answer, alone, in the form its instructions ask for: a severity against its thresholds, or a yes or no to
  // blocking. A bare allow settles the first stage; a block goes on to the second, which blocks again.
  if (isClassifier(req)) {
    classified.asked++
    const refuse = classifiedAction(req).includes(REFUSED)
    if (refuse) classified.refused++
    const text = textOf(req.system).includes('<severity>') ? `<severity>${refuse ? 100 : 0}</severity>` : `<block>${refuse ? 'yes' : 'no'}</block>`
    return { id, block: { type: 'text', text }, stop: 'end_turn', usage }
  }
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
      // Not quiet: git prints the commit's line, which the plugin's commit marker reads (markers.ts).
      call('Bash', { command: 'git -c user.name=e2e -c user.email=e2e@example.com commit --allow-empty -m e2e', description: 'Commit' }),
      // Allowed, and fails: a run that ends in an error.
      call('Bash', { command: 'ls e2e-missing-file', description: 'Fails' }),
      // No rule allows it, and unlike a file command in the working folder, auto mode doesn't let it through without asking: its
      // classifier judges it.
      call('Bash', { command: REFUSED, description: 'Not allowed' }),
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

/** The collector's shape for an `idempotency-key` header. The plugin sends one on every request. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Keyless ingest's answer to a request of the plugin's in the keyless pass: 401 for any Authorization header, 400 for a missing or
 * malformed `idempotency-key` header (the plugin always sends one; the collector itself accepts none), 400 for an item without
 * exactly one `organization.id` and one `user.email`, or for two pairs in one request, else 200.
 */
function keylessAnswer(headers, body) {
  if (headers['authorization'] !== undefined) return { status: 401, error: 'an Authorization header' }
  if (!IDEMPOTENCY_KEY.test(headers['idempotency-key'] ?? '')) return { status: 400, error: 'no idempotency-key header of the collector\'s shape' }
  const doc = JSON.parse(body)
  const items = [
    ...(doc.resourceLogs ?? []).flatMap(rl => rl.scopeLogs.flatMap(sl => sl.logRecords)),
    ...(doc.resourceSpans ?? []).flatMap(rs => rs.scopeSpans.flatMap(ss => ss.spans)),
    ...(doc.resourceMetrics ?? []).flatMap(rm => rm.scopeMetrics.flatMap(sm => sm.metrics.flatMap(m => (m.sum ?? m.gauge ?? m.histogram ?? {}).dataPoints ?? []))),
  ]
  let pair
  for (const item of items) {
    const org = (item.attributes ?? []).filter(a => a.key === 'organization.id')
    const email = (item.attributes ?? []).filter(a => a.key === 'user.email')
    if (org.length !== 1 || email.length !== 1) return { status: 400, error: 'an item without one organization.id and one user.email' }
    const p = `${org[0].value.stringValue} ${email[0].value.stringValue}`
    if (pair !== undefined && pair !== p) return { status: 400, error: 'two organizations or emails in one request' }
    pair = p
  }
  return { status: 200 }
}

let overloaded = false
/**
 * The test-only plugin that sends the plugin's requests to production's collector to the receiver (under `/prod`), built in a
 * temporary folder: its manifest lives only there, as this repository holds one plugin (scripts/check-layout.sh).
 */
function redirectPlugin() {
  const dir = mkdtempSync(join(tmpdir(), 'mainwave-e2e-redirect-'))
  mkdirSync(join(dir, '.claude-plugin'))
  mkdirSync(join(dir, 'hooks'))
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'mainwave-e2e-redirect',
    version: '0.0.0',
    description: "Test only: sends the mainwave plugin's requests to Mainwave's production collector to the local receiver the end-to-end comparison runs.",
  }))
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.ts'] }))
  copyFileSync(join(here, 'redirect.ts'), join(dir, 'hooks', 'register.ts'))
  return dir
}
const redirect = redirectPlugin()
// Removed however the run ends: a session that throws, or an interrupt, leaves nothing behind.
process.on('exit', () => rmSync(redirect, { recursive: true, force: true }))
process.on('SIGINT', () => process.exit(130))

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
  // The settings API is asked beside the collector the copy goes to: production's without the env block, which answers the settings
  // the keyless pass checks; the receiver the person's settings name with it, which answers as the route off, so the explicit settings
  // in the store stand and the copy is compared with the exporter's as they say.
  if (req.method === 'POST' && path === `/prod${SETTINGS_PATH}`) {
    captured.settings.push({ headers: req.headers, body })
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(SETTINGS))
  }
  if (req.method === 'POST' && path === `/plugin${SETTINGS_PATH}`) {
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end('{"detail":"Not Found"}')
  }
  // The plugin's requests come under `/plugin` (the collector its settings name) or `/prod` (production's, through redirect.ts).
  const signal = SIGNALS.find(s => path === `/v1/${s}` || path === `/plugin/v1/${s}` || path === `/prod/v1/${s}`)
  if (req.method === 'POST' && signal) {
    const via = path.split('/')[1]
    const who = via === 'plugin' || via === 'prod' ? 'plugin' : 'exporter'
    const answer = who === 'plugin' ? keylessAnswer(req.headers, body) : { status: 200 }
    captured[who][signal].push({ via, auth: req.headers['authorization'], type: req.headers['content-type'], idempotencyKey: req.headers['idempotency-key'], body, status: answer.status, error: answer.error })
    if (answer.status !== 200) {
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: answer.error }))
    }
  } else {
    captured.other.push(`${req.method} ${path}`)
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"partialSuccess":{}}')
})

await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// ── The session ──────────────────────────────────────────────────────────────

/**
 * One session, its telemetry captured. `details` turns prompt and tool-detail logging on; `envBlock` false runs it without Mainwave's
 * env block, the plugin sending keyless; `auto` runs it in auto mode.
 */
async function session(details, envBlock, auto) {
  captured = { exporter: { logs: [], traces: [], metrics: [] }, plugin: { logs: [], traces: [], metrics: [] }, settings: [], other: [] }
  messageId = 0
  classified = { asked: 0, refused: 0 }
  overloaded = false
  const config = mkdtempSync(join(tmpdir(), 'mainwave-e2e-'))
  work = mkdtempSync(join(tmpdir(), 'mainwave-e2e-work-'))
  // A repository, so the session's git commit has somewhere to go. Its config is the command's own: no user or system config is read.
  const git = (...a) => execFileSync('git', a, { cwd: work, env: { PATH: process.env.PATH, HOME: work, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
  // With the env block, the person's own settings (the config folder's settings.json) name the receiver as the plugin's collector, under
  // both ids a folder's plugin may have. Without it, the plugin's defaults: no settings at all.
  if (envBlock) {
    const options = { collectorUrl: `${base}/plugin` }
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'mainwave@inline': { options }, mainwave: { options } } }))
  }
  // With it, settings that turn on the identifiers and content the captures turn on in Claude Code: on with the captures on; as Claude
  // Code sends them with each set to 0, where the exporter is the reference for what a switch at 0 leaves.
  if (envBlock) {
    mkdirSync(dirname(storeFile(config)), { recursive: true })
    writeFileSync(storeFile(config), JSON.stringify({ dataPoints: Object.fromEntries(CAPTURED_DATA_POINTS.map(id => [id, details ? 'on' : 'claude'])) }))
  }

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
    MW_E2E_RECEIVER: `${base}/prod`,
  }
  // Without the env block: no telemetry settings at all. The organization and email reach the rows as a login would put them there.
  if (!envBlock) Object.assign(env, { OTEL_RESOURCE_ATTRIBUTES: `organization.id=${ORG},user.email=${EMAIL}` })
  else Object.assign(env, {
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
    OTEL_RESOURCE_ATTRIBUTES: `mainwave.source=coding_agent.claude_code,service.name=claude-code,deployment.environment=e2e,organization.id=${ORG},user.email=${EMAIL}`,
    // Mainwave's org-wide setup's captures, all on (its default), or all turned off: it writes `0` for a capture an admin turns off.
    ...Object.fromEntries(CAPTURES.map(k => [k, details ? '1' : '0'])),
  })

  const args = [
    '-p', 'E2E_MAINTASK: run the steps, then say ok.',
    '--plugin-dir', root,
    '--plugin-dir', redirect,
    '--allowedTools', 'Bash(echo e2e),Bash(echo sub),Bash(git -c user.name=e2e -c user.email=e2e@example.com commit:*),Bash(ls e2e-missing-file),Write,Edit,Agent',
    '--model', 'claude-haiku-5-5',
    ...(auto ? ['--permission-mode', 'auto'] : []),
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
function compare(pass, details, auto, { captured, run, work }) {
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
      if (p.via !== 'plugin') problems.push(`a plugin ${s} request to ${p.via === 'prod' ? "production's collector" : p.via}, not the collector the person's settings name`)
      if (p.status !== 200) problems.push(`keyless ingest refused a plugin ${s} request (${p.status}): ${p.error}`)
      if (p.body.includes(EXPORTER_KEY)) problems.push(`the exporter's key inside a plugin ${s} request body`)
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
  if (!matched.some(r => r.attributes['mainwave.plugin.name']?.v === 'mainwave')) problems.push("no matched row carries the plugin's stamps")
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
  // The plugin's markers have no counterpart: they are checked apart, below.
  const pluginSpans = spansOf(captured.plugin.traces).filter(s => !MARKER_SPANS.has(s.name))
  const markerSpans = spansOf(captured.plugin.traces).filter(s => MARKER_SPANS.has(s.name))
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
  // A classifier's request Claude Code logs no row for leaves the plugin nothing to rebuild it from: the gap the README lists. Any
  // other request without a row is a gap it does not list.
  const logged = new Set(exporterLogs.filter(r => ['api_request', 'api_error'].includes(r.attributes['event.name']?.v)).map(r => r.attributes.request_id?.v))
  const unloggedClassifier = s => s.name === 'claude_code.llm_request' && !logged.has(s.attrs.request_id?.v) && CLASSIFIERS.has(s.attrs.query_source_safe?.v)
  for (const [k, s] of exSpans) {
    if (plSpans.has(k)) continue
    if (unloggedClassifier(s)) noteKnown(`traces: llm_request of a classifier's request Claude Code logs no row for (query_source_safe ${s.attrs.query_source_safe?.v})`)
    else problems.push(`the exporter sent span ${k}, which the plugin did not`)
  }
  // The refused command was refused, on every pass; in auto mode, by the classifier, which the mock saw asked about it.
  if (!exporterLogs.some(r => r.attributes['event.name']?.v === 'tool_decision' && r.attributes.tool_name?.v === 'Bash' && r.attributes.decision?.v === 'reject')) problems.push('no Bash call was refused')
  if (auto && (classified.asked === 0 || classified.refused === 0)) problems.push(`auto mode's classifier was asked ${classified.asked} times, ${classified.refused} of them about the refused command`)
  // Asked at all, logged or not: should Claude Code start logging its rows, its spans are compared as any other request's.
  if (auto && !exporterSpans.some(s => s.name === 'claude_code.llm_request' && s.attrs.query_source_safe?.v === 'auto_mode')) problems.push("no request of auto mode's classifier in the session")
  for (const k of plSpans.keys()) if (!exSpans.has(k)) problems.push(`the plugin sent span ${k}, which the exporter did not`)
  for (const name of ['claude_code.interaction', 'claude_code.llm_request', 'claude_code.tool', 'claude_code.tool.blocked_on_user', 'claude_code.tool.execution']) {
    if (![...exSpans.keys()].some(k => k.startsWith(`${name}|`) && plSpans.has(k))) problems.push(`no ${name} span was matched`)
  }
  // The session ran with the settings it was meant to: the exporter's own spans show them, so the copy's are compared on that side.
  const commands = exporterSpans.filter(s => s.name === 'claude_code.tool' && s.attrs.tool_name?.v === 'Bash')
  const prompts = exporterSpans.filter(s => s.name === 'claude_code.interaction').map(s => s.attrs.user_prompt?.v)
  if (details && !commands.some(s => s.attrs.full_command)) problems.push('with tool details logged, no exporter Bash span carries its command')
  if (!details && commands.some(s => s.attrs.full_command)) problems.push('with tool details not logged, an exporter Bash span carries its command')
  // The markers. The session made one commit and nothing else a marker is about (its account is an API key's: no plan). With the
  // repository on (captures on), that commit goes as one marker, named as the repository's HEAD names it, under hook.git, naming the
  // call that made it; with the repository as Claude Code sends it (it sends none on a marker), none goes.
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, env: { PATH: process.env.PATH, HOME: work, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString().trim()
  const commitMarkers = markerSpans.filter(s => s.name === 'vcs.commit.created')
  const otherMarkers = markerSpans.filter(s => s.name !== 'vcs.commit.created')
  if (otherMarkers.length > 0) problems.push(`markers for work the session did not do: ${otherMarkers.map(s => s.name).join(', ')}`)
  if (details) {
    const commitCall = exporterSpans.find(s => s.name === 'claude_code.tool' && /\bcommit\b/.test(String(s.attrs.full_command?.v ?? '')))?.attrs.tool_use_id?.v
    if (commitMarkers.length !== 1) problems.push(`with the repository on, ${commitMarkers.length} commit markers for the session's one commit`)
    for (const c of commitMarkers) {
      if (c.attrs['vcs.commit.sha']?.v !== head) problems.push(`the commit marker names ${c.attrs['vcs.commit.sha']?.v}, not the repository's HEAD`)
      if (c.attrs['vcs.commit.parent_count']?.v !== 1) problems.push('the commit marker does not count its one parent')
      if (c.resource['mainwave.source']?.v !== 'hook.git' || c.resource['service.name']?.v !== 'mainwave.git-hook') problems.push("the commit marker's resource is not hook.git's")
      if (c.attrs['gen_ai.tool.call.id']?.v !== commitCall) problems.push('the commit marker does not name the call that made it')
      if (c.attrs[ROUTE]?.v !== 'plugin') problems.push('the commit marker has no plugin route')
      if (exporterSpans.some(s => s.traceId === c.traceId)) problems.push("the commit marker shares a trace with the session's spans")
    }
    noteKnown("traces: the plugin's commit marker (vcs.commit.created), which Claude Code sends none of", commitMarkers.length)
  } else if (commitMarkers.length > 0) problems.push('with the repository as Claude Code sends it, a commit marker went')
  if (!details && prompts.some(p => p !== '<REDACTED>')) problems.push('with prompts not logged, an exporter interaction carries its prompt')
  // The failed run is in the session: the exporter's span says so.
  if (!exporterSpans.some(s => s.name === 'claude_code.tool.execution' && s.attrs.success?.v === false)) problems.push('no failed tool run in the session')
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
    // Every key, in order: Mainwave fingerprints a span by its whole set of attribute keys. A tool span's command stamps are the
    // plugin's own, by design: known, and on that span alone.
    const stampsOn = e.name === 'claude_code.tool' && Object.keys(p.attrs).some(a => a.startsWith(COMMAND_STAMP))
    if (stampsOn) noteKnown("traces: a shell command's tool span carries the plugin's own outcome stamps (mainwave.command.*), which Claude Code sends none of")
    const eKeys = Object.keys(e.attrs).filter(a => a !== ROUTE)
    const pKeys = Object.keys(p.attrs).filter(a => a !== ROUTE && !(e.name === 'claude_code.tool' && a.startsWith(COMMAND_STAMP)))
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
  // Where the account is billed for auto mode's classifier (as it is through the mock, a gateway to Claude Code), the exporter
  // counts its requests in cost.usage and token.usage, query_source auxiliary, from 2.1.326; Claude Code logs no row for them, so the
  // plugin has nothing to count. What the exporter counts past the plugin in such a series is a known difference only if it is the
  // classifier's, model by model: either every token type's excess is exactly the tokens the exporter's spans of those requests
  // carry, and the cost excess is above 0 (the spans carry no cost), or the exporter counted none of them (as before 2.1.326), and
  // every excess is 0. Anything else fails.
  const TOKEN_ATTR = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_tokens', cacheCreation: 'cache_creation_tokens' }
  const autoModeUnlogged = exporterSpans.filter(s => unloggedClassifier(s) && s.attrs.query_source_safe?.v === 'auto_mode')
  const classifierTokens = new Map()
  for (const s of autoModeUnlogged) {
    for (const [type, attr] of Object.entries(TOKEN_ATTR)) {
      const k = `${type}|${s.attrs.model?.v}`
      classifierTokens.set(k, (classifierTokens.get(k) ?? 0) + Number(s.attrs[attr]?.v ?? 0))
    }
  }
  const classifierModels = new Set(autoModeUnlogged.map(s => s.attrs.model?.v))
  const classifierGroup = point => {
    if (!['claude_code.cost.usage', 'claude_code.token.usage'].includes(point.name) || point.attrs.query_source?.v !== 'auxiliary') return undefined
    if (!classifierModels.has(point.attrs.model?.v)) return undefined
    return `${point.name}|${point.attrs.type?.v ?? ''}|${point.attrs.model?.v}`
  }
  /** By metric, token type and model: what the exporter counted past the plugin in the classifier's series. */
  const classifierExcess = new Map()
  const classifierScale = new Map()
  for (const [k, e] of exSeries) {
    const group = classifierGroup(e.points[0])
    if (group === undefined) continue
    classifierExcess.set(group, (classifierExcess.get(group) ?? 0) + e.value - (plSeries.get(k)?.value ?? 0))
    classifierScale.set(group, Math.max(classifierScale.get(group) ?? 1, Math.abs(e.value)))
  }
  const excessOf = (name, type, model) => classifierExcess.get(`${name}|${type}|${model}`) ?? 0
  let counted = 0
  for (const model of classifierModels) {
    const tokens = Object.keys(TOKEN_ATTR).map(type => [type, excessOf('claude_code.token.usage', type, model), classifierTokens.get(`${type}|${model}`) ?? 0])
    const cost = excessOf('claude_code.cost.usage', '', model)
    const costTolerance = 1e-9 * (classifierScale.get(`claude_code.cost.usage||${model}`) ?? 1)
    const none = tokens.every(([, excess]) => excess === 0) && Math.abs(cost) <= costTolerance
    const all = tokens.every(([, excess, want]) => excess === want) && tokens.some(([, , want]) => want > 0) && cost > costTolerance
    if (all) counted += autoModeUnlogged.filter(s => s.attrs.model?.v === model).length
    else if (!none) problems.push(`metrics: the exporter counted past the plugin, for ${model} (query_source auxiliary), tokens ${tokens.map(([t, e]) => `${t} ${e}`).join(', ')} and cost ${cost}, where the requests of auto mode's classifier Claude Code logs no row for carry tokens ${tokens.map(([t, , w]) => `${t} ${w}`).join(', ')}, and a cost above 0`)
  }
  if (counted) noteKnown("metrics: cost.usage and token.usage of auto mode's classifier's requests, which Claude Code logs no row for (query_source auxiliary)", counted)
  const isClassifierSeries = k => classifierGroup(exSeries.get(k).points[0]) !== undefined
  for (const k of exSeries.keys()) if (!plSeries.has(k) && !isClassifierSeries(k)) problems.push(`the exporter sent series ${k}, which the plugin did not`)
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
    } else if (isClassifierSeries(k)) {
      // Its sum is held to the classifier's share above.
    } else if (Math.abs(e.value - p.value) > 1e-9 * Math.max(1, Math.abs(e.value))) noteDiff(`metric sum: exporter ${e.value}, plugin ${p.value}`, k)
    else if (e.value !== p.value) noteKnown('metrics: a sum differs past the 15th digit (floating point order)')
    if (e.points.length !== p.points.length && !isClassifierSeries(k)) noteDiff(`metric points: exporter ${e.points.length}, plugin ${p.points.length}`, k)
    const [ep, pp] = [e.points[0], p.points[0]]
    for (const f of ['description', 'unit', 'kind', 'temporality', 'monotonic', 'valueType']) if (!same(ep[f], pp[f])) noteDiff(`metric ${f}: exporter ${JSON.stringify(ep[f])}, plugin ${JSON.stringify(pp[f])}`, k)
    if (!same(ep.scope, pp.scope)) noteDiff(`metric scope: exporter ${JSON.stringify(ep.scope)}, plugin ${JSON.stringify(pp.scope)}`, k)
    if (pp.attrs[ROUTE]?.v !== 'plugin') noteDiff(`metric plugin route ${JSON.stringify(pp.attrs[ROUTE])}`, k)
    for (const [f, ef, pf] of [['start', ep.startMs, pp.startMs], ['time', ep.timeMs, pp.timeMs]]) {
      const d = Math.abs(ef - pf)
      if (f === 'start' && k.startsWith('claude_code.session.count ') && d <= SESSION_COUNT_TOLERANCE_MS) {
        noteKnown(`metrics: session.count counted when the plugin starts, ${d.toFixed(0)} ms after Claude Code counts it (within ${SESSION_COUNT_TOLERANCE_MS} ms)`)
        continue
      }
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

/**
 * The keyless pass: the exporter sent nothing, keyless ingest refused nothing, every signal arrived, and the spans make one coherent
 * trace per interaction, with as many spans of each kind as the exporter sent of the same session.
 */
function checkKeyless(pass, { captured, run, config }, reference) {
  const before = problems.length
  if (run.code !== 0) problems.push(`claude exited ${run.code}:\n${run.out.slice(-2000)}`)
  for (const s of SIGNALS) {
    if (captured.exporter[s].length > 0) problems.push(`with no env block the exporter sent ${s}`)
    if (captured.plugin[s].length === 0) problems.push(`the plugin sent no ${s}`)
    for (const p of captured.plugin[s]) if (p.status !== 200) problems.push(`keyless ingest refused a ${s} request (${p.status}): ${p.error}`)
    for (const p of captured.plugin[s]) if (p.via !== 'prod') problems.push(`with no settings, a plugin ${s} request went to ${p.via}, not production's collector`)
  }
  const rows = logRecordsOf(captured.plugin.logs)
  if (!rows.some(r => r.attributes['event.name']?.v === 'api_request')) problems.push('no api_request row was sent')

  const spans = spansOf(captured.plugin.traces)
  // With no settings the repository is off, so no commit marker goes; and the session's account is an API key's, so no plan.
  for (const s of spans) if (MARKER_SPANS.has(s.name)) problems.push(`with no settings, a ${s.name} marker went`)
  // Each row carries the ids of the span it ran in, as the exporter's rows do: by event, the kinds of span its rows name are the
  // ones the exporter's rows named in the same session with the env block, and a row's trace is that span's.
  const pointed = (list, spanList) => {
    const byId = new Map(spanList.map(s => [s.spanId, s]))
    const out = new Map()
    for (const r of list) {
      const ev = r.attributes['event.name']?.v
      const span = r.spanId ? byId.get(r.spanId) : undefined
      if (span && span.traceId !== r.traceId) problems.push(`a ${ev} row in a trace other than its span's`)
      const kind = !r.spanId ? 'none' : span ? span.name.replace('claude_code.', '') : 'a span never sent'
      out.set(ev, new Set([...(out.get(ev) ?? []), kind]))
    }
    return out
  }
  const wantRows = pointed(logRecordsOf(reference.exporter.logs).filter(r => !STARTUP.has(r.attributes['event.name']?.v)), spansOf(reference.exporter.traces))
  // A startup row reaches the plugin or not as the race with its loading goes: where one does, it names no span, as no interaction ran yet.
  const gotRows = pointed(rows.filter(r => !STARTUP.has(r.attributes['event.name']?.v)), spans)
  for (const [ev, k] of pointed(rows.filter(r => STARTUP.has(r.attributes['event.name']?.v)), spans)) {
    if ([...k].some(kind => kind !== 'none')) problems.push(`logs: a ${ev} row, raised as the session starts, names ${[...k].join(' and ')}`)
  }
  const kinds = m => [...m].map(([ev, k]) => `${ev}: ${[...k].sort().join(' and ')}`).sort()
  for (const ev of new Set([...wantRows.keys(), ...gotRows.keys()])) {
    const [w, g] = [[...(wantRows.get(ev) ?? [])].sort().join(' and '), [...(gotRows.get(ev) ?? [])].sort().join(' and ')]
    if (w !== g) problems.push(`logs: ${ev} rows name ${g || 'nothing'}, where the exporter's named ${w || 'nothing'}`)
  }
  console.log(`  rows name: ${kinds(gotRows).join('; ')}`)
  const byId = new Map(spans.map(s => [s.spanId, s]))
  const name = s => s.name.replace('claude_code.', '')
  const parentOf = s => (s.parentSpanId ? byId.get(s.parentSpanId) : undefined)
  const bad = new Map()
  const note = (what, s) => bad.set(what, [...(bad.get(what) ?? []), `${name(s)} ${s.attrs.request_id?.v ?? s.attrs.tool_use_id?.v ?? s.spanId}`])
  const callOf = new Map(spans.filter(s => s.name === 'claude_code.tool').map(s => [s.attrs.tool_use_id?.v, s]))
  // The Agent call that started each subagent: the call whose run its first request names, if anything names it.
  for (const s of spans) {
    const parent = parentOf(s)
    if (s.parentSpanId && !parent) note('a parent that was never sent', s)
    if (parent && parent.traceId !== s.traceId) note("a trace other than its parent's", s)
    switch (s.name) {
      case 'claude_code.interaction':
        if (s.parentSpanId) note('an interaction that is not a root', s)
        break
      case 'claude_code.llm_request': {
        const agent = s.attrs.agent_id?.v
        if (s.attrs['llm_request.context']?.v === 'standalone') {
          if (s.parentSpanId) note('a standalone request with a parent', s)
        } else if (agent === undefined ? parent?.name !== 'claude_code.interaction' : parent?.name !== 'claude_code.tool.execution' || callOf.get(parent.attrs.tool_use_id?.v)?.attrs.tool_name?.v !== 'Agent') {
          note(agent === undefined ? 'a main-loop request not under an interaction' : "a subagent's request not under an Agent call's run", s)
        }
        break
      }
      case 'claude_code.tool': {
        const agent = s.attrs.agent_id?.v
        const ok = agent === undefined ? parent?.name === 'claude_code.interaction' : parent?.name === 'claude_code.tool.execution' && callOf.get(parent.attrs.tool_use_id?.v)?.attrs.tool_name?.v === 'Agent'
        if (!ok) note(agent === undefined ? 'a main-loop call not under an interaction' : "a subagent's call not under an Agent call's run", s)
        break
      }
      case 'claude_code.tool.blocked_on_user':
      case 'claude_code.tool.execution':
        if (parent?.name !== 'claude_code.tool') note('a decision or run not under its call', s)
        break
    }
  }
  for (const [what, list] of bad) problems.push(`traces: ${what} (${list.length}, e.g. ${list[0]})`)
  if (!spans.some(s => s.name === 'claude_code.llm_request' && s.attrs.agent_id !== undefined)) problems.push("no subagent's request was sent")
  if (!spans.some(s => s.name === 'claude_code.tool' && s.attrs.agent_id !== undefined)) problems.push("no subagent's call was sent")
  const interactions = spans.filter(s => s.name === 'claude_code.interaction')
  if (new Set(interactions.map(s => s.traceId)).size !== interactions.length) problems.push('two interactions share a trace')
  const count = list => list.reduce((m, s) => m.set(name(s), (m.get(name(s)) ?? 0) + 1), new Map())
  const want = count(spansOf(reference.exporter.traces))
  const got = count(spans)
  for (const k of new Set([...want.keys(), ...got.keys()])) if (want.get(k) !== got.get(k)) problems.push(`traces: ${got.get(k) ?? 0} ${k} spans, where the exporter sent ${want.get(k) ?? 0} of the same session`)

  const points = pointsOf(captured.plugin.metrics)
  for (const m of ['claude_code.cost.usage', 'claude_code.token.usage', 'claude_code.lines_of_code.count', 'claude_code.commit.count']) {
    if (!points.some(p => p.name === m)) problems.push(`no ${m} point was sent`)
  }

  // With no settings, the plugin's defaults: required and metadata data points, and no identifier or content. Each kind of value is
  // looked for at least once, and each the defaults leave out looked for nowhere.
  const redacted = v => v === undefined || v === '<REDACTED>'
  const tool = n => spans.filter(s => s.name === 'claude_code.tool' && s.attrs.tool_name?.v === n)
  const rowsOf = ev => rows.filter(r => r.attributes['event.name']?.v === ev)
  const expectations = [
    ['a Bash call with its class', tool('Bash').some(s => s.attrs.bash_argv0?.v === 'echo')],
    ['an Agent call with its subagent type', tool('Agent').some(s => s.attrs.subagent_type?.v === 'general-purpose')],
    ['a Write call', tool('Write').length > 0],
    ["a failed call's run with its error class", spans.some(s => s.name === 'claude_code.tool.execution' && s.attrs.success?.v === false && s.attrs.error_class !== undefined)],
    ['an interaction', interactions.length > 0],
    ['a user_prompt row', rowsOf('user_prompt').length > 0],
    ['an assistant_response row', rowsOf('assistant_response').length > 0],
    ['a tool_result row', rowsOf('tool_result').length > 0],
  ]
  for (const [what, ok] of expectations) if (!ok) problems.push(`defaults: no ${what} was sent`)

  // The organization's settings: asked for with the organization and email alone, kept in the store with the organization, and applied to the
  // copy, the records captured before the answer included.
  if (captured.settings.length === 0) problems.push('settings: the plugin never asked for its organization\'s settings')
  for (const { headers, body } of captured.settings) {
    let asked
    try {
      asked = JSON.parse(body)
    } catch {
      asked = body
    }
    if (JSON.stringify(asked) !== JSON.stringify({ claude_org_id: ORG, email: EMAIL })) problems.push(`settings: asked with ${JSON.stringify(asked)}, not the organization and email alone`)
    if (headers['authorization'] !== undefined) problems.push('settings: asked with an Authorization header')
  }
  let kept = {}
  try {
    kept = JSON.parse(readFileSync(storeFile(config), 'utf8'))
  } catch {
    problems.push('settings: the plugin kept no store')
  }
  const keptWant = { dataCollectionSettings: { organizationId: ORG, revision: SETTINGS.revision, dataPoints: SETTINGS.data_points, redactionPacks: SETTINGS.redaction_packs } }
  for (const [k, v] of Object.entries(keptWant)) if (JSON.stringify(kept[k]) !== JSON.stringify(v)) problems.push(`settings: the store keeps ${k} as ${JSON.stringify(kept[k])}, not ${JSON.stringify(v)}`)
  const decisions = points.filter(p => p.name === 'claude_code.code_edit_tool.decision')
  if (decisions.length === 0) problems.push('settings: no code_edit_tool.decision point was sent')
  if (decisions.some(p => p.attrs.language !== undefined)) problems.push('settings: a code_edit_tool.decision point carries the language the settings turned off')
  console.log(`  settings: asked ${captured.settings.length} time${captured.settings.length === 1 ? '' : 's'}; ${decisions.length} code_edit_tool.decision points, none with a language`)
  const withheld = [
    ['a command', spans.some(s => s.attrs.full_command !== undefined || s.attrs.bash_command !== undefined)],
    ['a file path', spans.some(s => s.attrs.file_path !== undefined)],
    ['a tool output', spans.some(s => (s.events ?? []).some(e => e.name === 'tool.output'))],
    ["a failed call's error text", spans.some(s => /e2e-missing-file/.test(String(s.attrs.error?.v ?? '')))],
    ['a prompt', spans.some(s => !redacted(s.attrs.user_prompt?.v)) || rowsOf('user_prompt').some(r => !redacted(r.attributes.prompt?.v) || !redacted(r.attributes.prompt_text?.v))],
    ['a response', rowsOf('assistant_response').some(r => !redacted(r.attributes.response?.v))],
    ['tool input', rows.some(r => r.attributes.tool_input !== undefined) || rows.some(r => /full_command|file_path|"description"/.test(String(r.attributes.tool_parameters?.v ?? '')))],
    ['a repository', [...rows.map(r => r.attributes), ...spans.map(s => s.attrs)].some(a => Object.keys(a).some(k => k.startsWith('vcs.')) || /git_commit_id|git_branch/.test(String(a.tool_parameters?.v ?? '')))],
    // What Claude Code never sends: no row of the plugin's own for MCP server addresses or skill text.
    ...['mcp_server_configured', 'skill_prompt'].map(ev => [`${ev} rows`, rowsOf(ev).length > 0]),
  ]
  for (const [what, sent] of withheld) if (sent) problems.push(`defaults: ${what} was sent`)
  // Nor anywhere in a request: the session's prompt, command and output, as text.
  const raw = JSON.stringify(captured.plugin)
  for (const text of ['E2E_MAINTASK', 'echo e2e', 'e2e-missing-file']) if (raw.includes(text)) problems.push(`defaults: "${text}" is in a request`)
  const requests = captured.plugin.logs.length + captured.plugin.traces.length + captured.plugin.metrics.length
  console.log(`keyless: ${requests} requests, none refused; ${rows.length} rows, ${spans.length} spans in ${new Set(spans.map(s => s.traceId)).size} traces (${interactions.length} interactions), ${points.length} metric points`)
  console.log(`  spans: ${[...got].map(([n, c]) => `${n} ${c}`).join(', ')}`)
  for (let i = before; i < problems.length; i++) problems[i] = `${pass}: ${problems[i]}`
}

// The keyless pass is held to the second, which runs as it does: not in auto mode.
const passes = [['captures on, auto mode', true, true, true], ['captures set to 0', false, true, false], ['no env block, sent keyless', false, false, false]]
const results = []
for (const [pass, details, envBlock, auto] of passes) {
  console.log(`\n${pass}:`)
  const result = await session(details, envBlock, auto)
  results.push(result)
  if (envBlock) compare(pass, details, auto, result)
  else checkKeyless(pass, result, results[1].captured)
  // With the env block the rows name no email (only the organization, through OTEL_RESOURCE_ATTRIBUTES), so the plugin asks nothing
  // and the settings written in its store stand.
  if (envBlock && result.captured.settings.length > 0) problems.push(`${pass}: the plugin asked for settings with no email to ask with`)
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
console.log('the copy matches the exporter, and without the env block it goes keyless in coherent traces')
