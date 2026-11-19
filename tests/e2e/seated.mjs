#!/usr/bin/env node
// End to end, with Claude Code's security default seated: one real `claude -p` session with the plugin loaded from this folder, as a
// plugin a person installs is (the `user` tier), its model answered by a local mock of the Anthropic API. The default is seated
// outermost for Team and Enterprise organizations, wherever managed settings are, and in remote Cowork; it skips every `classic.*`
// hook of a plugin in the `user` tier, and some native ones (`telemetry.log` on the collector stream, `skill.prompt`). The markers
// must come from hooks it lets through: this checks, on the Claude Code installed, that the plugin's tool call, prompt and turn hooks
// ran and that none of them was reported skipped.
//
// The session makes a commit (a tool call), then a second prompt whose turn ends on a rate limit (a turn's failure). It reads the
// session's debug log: the default must say it is seated, the plugin must load in the `user` tier with no classic hook, each of those
// hooks must have run, and no line may say that one of them was skipped.
//
// The default is seated only where this machine has managed settings, which only an administrator can write: on Linux,
// /etc/claude-code/managed-settings.json. They apply to every session on the machine, so this runs only where MW_E2E_SEATED=1 says
// the caller wrote them for it (CI writes them on its throwaway runner, runs this, and removes them), and without that does nothing.
// Locally, run it in a container:
//
//   docker run --rm -v "$PWD:/plugin:ro" -w /tmp node:22 sh -c 'npm i -g @anthropic-ai/claude-code >/dev/null &&
//     apt-get -qq update >/dev/null && apt-get -qq install -y git >/dev/null && mkdir -p /etc/claude-code &&
//     echo "{\"cleanupPeriodDays\": 30}" > /etc/claude-code/managed-settings.json && MW_E2E_SEATED=1 node /plugin/tests/e2e/seated.mjs'
//
// Needs `claude` and `git` on PATH. Nothing leaves the machine: the model is mocked, and the plugin's copy goes to a local receiver.

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

if (process.env.MW_E2E_SEATED !== '1') {
  console.log('seated: skipped. It needs managed settings on this machine, which seat the security default; see the top of this file')
  process.exit(0)
}

/** The hooks the markers come from: each must run, and none be skipped. */
const MARKER_HOOKS = ['tool.call', 'prompt.submit', 'turn.start', 'turn.step', 'turn.complete']
/** The hooks the default is known to skip for a plugin in the `user` tier: reported, not failed. */
const KNOWN_SKIPPED = ['telemetry.log', 'skill.prompt']

// ── The mock model ───────────────────────────────────────────────────────────
// The first prompt commits, then answers; the second is refused as rate limited, so its turn ends on an API error. Every other
// request (a title, a summary) gets a short text answer.

const COMMIT = 'git -c user.name=e2e -c user.email=e2e@example.com commit --allow-empty -m e2e'
const textOf = c => (typeof c === 'string' ? c : (c ?? []).map(b => (b?.type === 'text' ? b.text : '')).join(' '))
let n = 0

const server = createServer((req, res) => {
  let body = ''
  req.on('data', d => (body += d))
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages')) {
      // The plugin's copy and its settings request: taken and dropped.
      res.writeHead(req.url.includes('data-collection-settings') ? 404 : 200, { 'content-type': 'application/json' })
      return res.end('{}')
    }
    const r = JSON.parse(body || '{}')
    const messages = r.messages ?? []
    const all = messages.map(m => textOf(m.content)).join(' ')
    const results = messages.flatMap(m => (Array.isArray(m.content) ? m.content.filter(b => b?.type === 'tool_result') : [])).length
    const id = `msg_e2e_${++n}`
    const usage = { input_tokens: 100 + n, output_tokens: 5 }
    if (r.stream && all.includes('E2E_FAIL')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0', 'request-id': `req_e2e_${n}` })
      return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited in test' } }))
    }
    const tool = r.stream && all.includes('E2E_COMMIT') && results === 0 && (r.tools ?? []).some(t => t?.name === 'Bash')
    const block = tool ? { type: 'tool_use', id: `toolu_e2e_${n}`, name: 'Bash', input: { command: COMMIT, description: 'Commit' } } : { type: 'text', text: 'ok' }
    if (!r.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: r.model, content: [block], stop_reason: 'end_turn', usage }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': `req_e2e_${n}` })
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
    send('message_start', { message: { id, type: 'message', role: 'assistant', model: r.model, content: [], stop_reason: null, stop_sequence: null, usage } })
    send('content_block_start', { index: 0, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } })
    send('content_block_delta', { index: 0, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    send('content_block_stop', { index: 0 })
    send('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    send('message_stop', {})
    res.end()
  })
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// ── The session ──────────────────────────────────────────────────────────────

const config = mkdtempSync(join(tmpdir(), 'mainwave-e2e-seated-'))
const work = mkdtempSync(join(tmpdir(), 'mainwave-e2e-seated-work-'))
const git = (...a) => execFileSync('git', a, { cwd: work, env: { PATH: process.env.PATH, HOME: work, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } })
git('init', '-q', '-b', 'main')
git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '--allow-empty', '-m', 'init')
// The copy goes to the receiver, not to production.
const options = { collectorUrl: `${base}/plugin` }
writeFileSync(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: { 'mainwave@inline': { options }, mainwave: { options } } }))

const debug = join(config, 'debug.log')
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
  CLAUDE_CODE_MAX_RETRIES: '0',
}
const args = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--plugin-dir', root,
  '--allowedTools', `Bash(${COMMIT})`,
  '--model', 'claude-haiku-5-5',
  '--debug-file', debug,
]
const run = await new Promise(r => {
  const child = spawn('claude', args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  const say = text => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`)
  const results = () => out.split('"type":"result"').length - 1
  child.stdout.on('data', d => {
    out += d
    // The second prompt once the first has its result; stdin closed once the second has its own.
    if (results() === 1 && !out.includes('E2E_FAIL_SENT')) (out += 'E2E_FAIL_SENT'), say('E2E_FAIL: say ok.')
    else if (results() >= 2) child.stdin.end()
  })
  child.stderr.on('data', d => (out += d))
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.on('exit', code => (clearTimeout(timer), r({ code, out })))
  say('E2E_COMMIT: commit, then say ok.')
})
server.close()

// ── What the debug log says ──────────────────────────────────────────────────

const log = readFileSync(debug, 'utf8').split('\n')
const problems = []
const seat = log.find(l => /cc-plugin-sec-default@builtin (seated|not seated)/.test(l))
if (!seat || !/seated outermost/.test(seat)) problems.push(`the security default is not seated: ${seat?.replace(/^\S+ \[\w+\] /, '') ?? 'no line says'}`)
const loaded = log.find(l => /hooks module mainwave@inline loaded/.test(l))
if (!loaded) problems.push('the plugin did not load')
else {
  if (!/tier user\b/.test(loaded)) problems.push(`the plugin did not load in the user tier: ${loaded}`)
  if (/classic\./.test(loaded)) problems.push(`the plugin hooks a classic event, which the default skips: ${loaded}`)
}
// The engine's line (`mainwave: <hook> bypassed by cc-plugin-sec-default`) and the one it shows the person (`its <hook> hook was skipped`).
const skipped = new Set(log.flatMap(l => [...l.matchAll(/mainwave\b.*?(?:: (\S+) bypassed by|its (\S+) hook was skipped)/g)].map(m => (m[1] ?? m[2]).replace(/\{.*$/, ''))))
for (const h of MARKER_HOOKS) {
  if (skipped.has(h)) problems.push(`its ${h} hook was skipped`)
  else if (!log.some(l => new RegExp(`hooks module mainwave@inline ${h.replace('.', '\\.')}( stream)? settled`).test(l))) problems.push(`its ${h} hook never ran`)
}
const unknown = [...skipped].filter(h => !MARKER_HOOKS.includes(h) && !KNOWN_SKIPPED.some(k => h.startsWith(k)))
if (unknown.length) console.log(`  also skipped: ${unknown.join(', ')}`)
// The second prompt's turn ends on the rate limit, so `claude -p` exits 1: each prompt must have had its result all the same.
if (run.out.split('"type":"result"').length - 1 < 2) problems.push(`the session did not answer both prompts (exit ${run.code})`)
if (!/"is_error":true/.test(run.out)) problems.push('the second prompt did not end on an API error')

console.log(`seated: ${seat?.replace(/^\S+ \[\w+\] /, '') ?? 'no seat line'}`)
console.log(`  skipped, as the default does: ${[...skipped].filter(h => KNOWN_SKIPPED.some(k => h.startsWith(k))).join(', ') || 'none'}`)
if (problems.length) {
  console.error(`seated: FAILED\n  ${problems.join('\n  ')}`)
  console.error(`debug log: ${debug}`)
  process.exit(1)
}
console.log(`  ran, none skipped: ${MARKER_HOOKS.join(', ')}`)
