// End to end: the data points the plugin sends, as a Cowork session runs. Cowork exports no spans and withholds tool details and
// prompts from its rows; its shell commands run through the `remote-devices` MCP server's `device_bash`. The engine beneath is played
// by rig.ts and the kit's mocks; every request the plugin makes is read back whole. Explicit settings per data point reach the plugin
// as organization settings will: kept in its store, under `dataPoints`.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import type { Overrides } from '../hooks/gate.ts'
import { boot, EMAIL, LOGGED_AT, memoryStore, network, ORG, type Post } from './rig.ts'

const keyless = { options: {} }
const START = 1_800_000_000_000
const COMMON = { 'organization.id': ORG, 'user.email': EMAIL, 'user.id': 'device-1', 'session.id': 's-1', 'anthropic.provider': 'firstParty', 'cowork.surface': 'desktop' }
const USAGE = { input_tokens: 1201, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const DEVICE_BASH = 'mcp__remote-devices__device_bash'
const COMMAND = 'git commit -m "fix login" && git push'
const TOKEN = `ghp_${'a'.repeat(36)}`

function world(on: On, env: Record<string, string> = {}, overrides?: Overrides) {
  const clock = mock.clock(on, { now: START })
  const store = memoryStore(on, overrides ? { dataPoints: overrides } : {})
  const posts = network(on)
  boot(on, { entrypoint: 'remote_cowork', env })
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: 'ok' }) as never)
  on('prompt.submit', (_$, e) => ({ text: (e as { text: string }).text }) as never)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'thinking', index: 0, text: 'Commit first.' } as never
    yield { kind: 'text', index: 1, text: 'Done.' } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
    return { turnId: e.turnId, index: e.index, answer: 'Done.', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
  })
  on('tool.call', () => ({ result: [{ type: 'text', text: `[main 1a2b3c] fix login ${TOKEN}` }] }) as never)
  return { clock, posts, store }
}

/** A Cowork row: no span, and what its export withholds left out. */
async function row($: Engine, event: string, attributes: Record<string, unknown>) {
  await $.telemetry.log({ to: 'collector', event, loggedAt: LOGGED_AT, attributes: { ...COMMON, 'event.name': event, 'event.sequence': 1, ...attributes } } as never)
}

/** One Cowork turn: a prompt, a request, a device_bash call that commits and pushes, and the turn's end. */
async function turn($: Engine) {
  await $.prompt.submit({ text: 'ship it' } as never)
  await row($, 'user_prompt', { prompt: '<REDACTED>', prompt_text: '<REDACTED>', prompt_length: '7' })
  await $.turn.start({ turnId: 't1', text: 'ship it' } as never)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1 } as never)
  while (!(await stream.next()).done) {
    // Read to its end, as the engine does.
  }
  await row($, 'api_request', {
    model: 'claude-haiku-5-5', input_tokens: 1201, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.25,
    duration_ms: 10, ttft_ms: 4, request_id: 'req_1', query_source: 'sdk', 'mcp_server.name': 'remote-devices', 'mcp_tool.name': 'device_bash',
  })
  await row($, 'assistant_response', { response: '<REDACTED>', response_length: 5, request_id: 'req_1' })
  await $.tool.call({ tool: DEVICE_BASH, command: COMMAND, description: 'Ship', tool_use_id: 'toolu_1' } as never)
  await row($, 'tool_decision', { decision: 'accept', source: 'config', tool_name: 'mcp_tool', tool_use_id: 'toolu_1' })
  await row($, 'tool_result', { tool_name: 'mcp_tool', tool_use_id: 'toolu_1', success: 'true', tool_input_size_bytes: '60' })
  await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 40, isAborted: false, reason: 'answer' } as never)
}

const kvs = (l: { key: string; value: Record<string, unknown> }[] = []) => Object.fromEntries(l.map(a => [a.key, Object.values(a.value)[0]]))
const bodies = (posts: readonly Post[], path: string) => posts.filter(p => p.url.endsWith(path)).map(p => JSON.parse(p.body))
const rowsOf = (posts: readonly Post[]) => bodies(posts, '/v1/logs').flatMap(b => b.resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords))).map((r: any) => kvs(r.attributes))
const spansOf = (posts: readonly Post[]) => bodies(posts, '/v1/traces').flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans))).map((s: any) => ({ name: s.name as string, attrs: kvs(s.attributes), events: (s.events ?? []).map((e: any) => ({ name: e.name, attrs: kvs(e.attributes) })) }))
const metricNames = (posts: readonly Post[]) => bodies(posts, '/v1/metrics').flatMap(b => b.resourceMetrics.flatMap((r: any) => r.scopeMetrics.flatMap((s: any) => s.metrics.map((m: any) => m.name))))

/** A whole session: its start, one turn, its end. Answers every request the plugin made. */
async function session($: Engine, on: On, opts: { env?: Record<string, string>; overrides?: Overrides } = {}) {
  const { posts } = world(on, opts.env, opts.overrides)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
  await turn($)
  await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
  return posts
}

describe('with no settings, as Claude Code with the org-wide setup captures on', () => {
  test("a device_bash call's span carries its command, its class, its MCP names and its output, and counts its commit", keyless, async ($, on) => {
    const posts = await session($, on)
    const tool = spansOf(posts).find(s => s.name === 'claude_code.tool')!
    expect(tool.attrs).toEqual(expect.objectContaining({
      tool_name: DEVICE_BASH, 'gen_ai.tool.name': 'device_bash', 'anthropic.mcp.server.name': 'remote-devices',
      full_command: COMMAND, bash_command_class: 'vcs', bash_argv0: 'git',
    }))
    // The output is the call's text, its token replaced.
    expect(tool.events).toEqual([{ name: 'tool.output', attrs: { output: '[main 1a2b3c] fix login [REDACTED:github_token]' } }])
    expect(tool.attrs['mainwave.redaction.count']).toBe(1)
    expect(metricNames(posts)).toContain('claude_code.commit.count')
  })

  test("Cowork's rows carry what its export withheld: the prompt, the response, the call's parameters and input", keyless, async ($, on) => {
    const rows = rowsOf(await session($, on))
    const by = (ev: string) => rows.find(r => r['event.name'] === ev)!
    expect(by('user_prompt')).toEqual(expect.objectContaining({ prompt: 'ship it', prompt_text: 'ship it' }))
    expect(by('assistant_response')['response']).toBe('Done.')
    expect(JSON.parse(by('tool_result')['tool_parameters'] as string)).toEqual({ bash_command: 'git', full_command: COMMAND, mcp_server_name: 'remote-devices', mcp_tool_name: 'device_bash' })
    expect(JSON.parse(by('tool_result')['tool_input'] as string)).toEqual({ command: COMMAND, description: 'Ship' })
    expect(JSON.parse(by('tool_decision')['tool_parameters'] as string)['full_command']).toBe(COMMAND)
    expect(by('tool_decision')['tool_input']).toBeUndefined()
  })

  test('the interaction carries its prompt, and no request its thinking: Claude Code never exports thinking', keyless, async ($, on) => {
    const spans = spansOf(await session($, on))
    expect(spans.find(s => s.name === 'claude_code.interaction')!.attrs['user_prompt']).toBe('ship it')
    expect(spans.find(s => s.name === 'claude_code.llm_request')!.attrs['response.thinking']).toBeUndefined()
  })
})

describe('a switch the session sets to 0', () => {
  test('keeps what it governs as Claude Code sends it: no command, no prompt, no output, but the MCP names Claude Code always sends on spans', keyless, async ($, on) => {
    const posts = await session($, on, { env: { OTEL_LOG_TOOL_DETAILS: '0', OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_USER_PROMPTS: '0' } })
    const all = posts.map(p => p.body).join('\n')
    expect(all).not.toContain('commit -m')
    expect(all).not.toContain('ship it')
    expect(all).not.toContain('Done.')
    expect(all).not.toContain('1a2b3c')
    const tool = spansOf(posts).find(s => s.name === 'claude_code.tool')!
    expect(tool.attrs['anthropic.mcp.server.name']).toBe('remote-devices')
    expect(tool.attrs['full_command']).toBeUndefined()
    expect(tool.events).toEqual([])
    expect(rowsOf(posts).find(r => r['event.name'] === 'tool_result')!['tool_parameters']).toBeUndefined()
  })
})

describe('an explicit setting', () => {
  test('off: the data point appears in no request the plugin sends, rows, spans or metrics', keyless, async ($, on) => {
    const posts = await session($, on, { overrides: { 'bash.command': 'off', 'tool.mcp': 'off', 'bash.outcome': 'off' } })
    const all = posts.map(p => p.body).join('\n')
    expect(all).not.toContain('commit -m')
    expect(all).not.toContain('remote-devices')
    expect(all).not.toContain('device_bash')
    expect(metricNames(posts)).not.toContain('claude_code.commit.count')
    // What is left on: the command's class.
    expect(spansOf(posts).find(s => s.name === 'claude_code.tool')!.attrs).toEqual(expect.objectContaining({ tool_name: 'mcp_tool', bash_argv0: 'git' }))
  })

  test("on: thinking, which Claude Code never exports, rides on the request's span", keyless, async ($, on) => {
    const spans = spansOf(await session($, on, { overrides: { 'response.thinking': 'on' } }))
    expect(spans.find(s => s.name === 'claude_code.llm_request')!.attrs['response.thinking']).toBe('Commit first.')
  })

  test('turned off after a record was queued: it goes without it, as the gate is read again as it is sent', keyless, async ($, on) => {
    // The records were queued under the defaults, prompt and command included.
    // Nothing is answered until the session's end, so every record waits in the queue.
    const { posts, store } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($)
    store.data.set('dataPoints', { 'prompt.text': 'off', 'bash.command': 'off' })
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    const all = posts.map(p => p.body).join('\n')
    expect(all).not.toContain('ship it')
    expect(all).not.toContain('commit -m')
    expect(rowsOf(posts).find(r => r['event.name'] === 'user_prompt')!['prompt']).toBe('<REDACTED>')
  })
})

describe("the MCP servers set up, and each skill's text: data points no Claude Code row carries", () => {
  const HOME = '/home/ana'
  const ROOT = '/home/ana/acme/api'
  const FILES: Record<string, unknown> = {
    [`${HOME}/.claude.json`]: {
      oauthAccount: { emailAddress: EMAIL },
      mcpServers: { linear: { type: 'http', url: 'https://ana:hunter2@mcp.example.com/mcp?team=acme#x', headers: { Authorization: 'Bearer abc' } } },
      projects: { [ROOT]: { mcpServers: { db: { command: 'npx', args: ['db-mcp', `--token=${'s'.repeat(24)}`], env: { DB_PASSWORD: 'pw' } } } } },
    },
    [`${ROOT}/.mcp.json`]: { mcpServers: { docs: { type: 'sse', url: 'https://docs.example.com/sse' }, linear: { url: 'https://other.example.com' } } },
  }

  /** A whole session that runs two skills and calls a claude.ai connector, with Claude's settings files in place. */
  async function run($: Engine, on: On, overrides?: Overrides) {
    const { posts } = world(on, { HOME }, overrides)
    const reads: string[] = []
    on('fs.read', (_$, e) => {
      const path = (e as { path: string }).path
      reads.push(path)
      if (!(path in FILES)) throw new Error('ENOENT')
      return { value: JSON.stringify(FILES[path]) } as never
    })
    on('session.root', () => ({ value: ROOT }) as never)
    on('skill.prompt', (_$, e) => ({ text: (e as { text: string }).text }) as never)
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)
    await turn($)
    for (let i = 0; i < 2; i++) await $.skill.prompt({ skill: 'review', text: 'Review the diff for correctness bugs.', source: 'userSettings', frontmatter: {} } as never)
    await $.prompt.submit({ text: '/fix PR 12' } as never)
    await $.skill.prompt({ skill: 'fix', text: 'Fix what PR 12 broke.', source: 'userSettings', frontmatter: {} } as never)
    await $.tool.call({ tool: 'mcp__claude_ai_Gmail__create_draft', to: 'x', tool_use_id: 'toolu_2' } as never)
    await row($, 'tool_result', { tool_name: 'mcp_tool', tool_use_id: 'toolu_2', success: 'true', mcp_server_scope: 'claudeai' })
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    return { posts, reads }
  }

  test('off by default: no row, and no settings file read', keyless, async ($, on) => {
    const { posts, reads } = await run($, on)
    const events = rowsOf(posts).map(r => r['event.name'])
    expect(events).not.toContain('mcp_server_configured')
    expect(events).not.toContain('skill_prompt')
    expect(reads).toEqual([])
  })

  test("on: each server once, the nearest setting first, its address without credentials or query; a called one's name and scope", keyless, async ($, on) => {
    const { posts } = await run($, on, { 'mcp.url': 'on' })
    const servers = rowsOf(posts).filter(r => r['event.name'] === 'mcp_server_configured')
    const pick = (r: Record<string, unknown>) => ({ server_name: r['server_name'], server_scope: r['server_scope'], transport_type: r['transport_type'], server_url: r['server_url'] })
    expect(servers.map(pick)).toEqual([
      { server_name: 'db', server_scope: 'local', transport_type: 'stdio', server_url: 'npx db-mcp --token=[REDACTED:assigned_secret]' },
      { server_name: 'docs', server_scope: 'project', transport_type: 'sse', server_url: 'https://docs.example.com/sse' },
      { server_name: 'linear', server_scope: 'project', transport_type: 'http', server_url: 'https://other.example.com' },
      { server_name: 'remote-devices', server_scope: 'unknown', transport_type: undefined, server_url: undefined },
      { server_name: 'claude_ai_Gmail', server_scope: 'claudeai', transport_type: undefined, server_url: undefined },
    ])
    // Routed as the session's other rows are, and nothing else in the files read is sent.
    expect(servers[0]).toEqual(expect.objectContaining({ 'organization.id': ORG, 'user.email': EMAIL, 'mainwave.telemetry.route': 'plugin' }))
    const all = posts.map(p => p.body).join('\n')
    for (const secret of ['hunter2', 'Bearer abc', 'DB_PASSWORD', 'oauthAccount', 'team=acme']) expect(all).not.toContain(secret)
  })

  test("on: a skill's text once per session, later runs by its ID; a text holding the person's arguments only where prompts go", keyless, async ($, on) => {
    const rows = (await run($, on, { 'skill.text': 'on', 'prompt.text': 'off' })).posts
    const skills = rowsOf(rows).filter(r => r['event.name'] === 'skill_prompt')
    expect(skills).toHaveLength(3)
    const [first, again, fix] = skills
    expect(first).toEqual(expect.objectContaining({ 'skill.name': 'review', 'skill.source': 'userSettings', 'skill.text': 'Review the diff for correctness bugs.', 'skill.has_arguments': false }))
    expect(again!['skill.text']).toBeUndefined()
    expect(again!['skill.text_id']).toBe(first!['skill.text_id'])
    expect(fix).toEqual(expect.objectContaining({ 'skill.name': 'fix', 'skill.has_arguments': true, 'skill.text_held_back': true }))
    expect(fix!['skill.text']).toBeUndefined()
  })
})
