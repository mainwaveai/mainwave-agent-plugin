// End to end: the data points the plugin sends, as a Cowork session runs. Cowork exports no spans and withholds tool details and
// prompts from its rows; its shell commands run through the `remote-devices` MCP server's `device_bash`. The engine beneath is played
// by rig.ts and the kit's mocks; every request the plugin makes is read back whole. Explicit settings per data point reach the plugin
// as organization settings will: kept in its store, under `dataPoints`. The person's opt-in reaches it from their settings layers.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import type { Overrides } from '../hooks/gate.ts'
import { boot, contractViolations, EMAIL, LOGGED_AT, memoryStore, network, optInOption, ORG, STAMPED, type Layers, type Post } from './rig.ts'

const keyless = { options: {} }
const START = 1_800_000_000_000
const COMMON = { 'organization.id': ORG, 'user.email': EMAIL, 'user.id': 'device-1', 'session.id': 's-1', 'anthropic.provider': 'firstParty', 'cowork.surface': 'desktop' }
const USAGE = { input_tokens: 1201, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const DEVICE_BASH = 'mcp__remote-devices__device_bash'
const COMMAND = 'git commit -m "fix login" && git push'
const TOKEN = `ghp_${'a'.repeat(36)}`

function world(on: On, env: Record<string, string> = {}, overrides?: Overrides, merged?: Record<string, unknown>, layers: Layers = {}) {
  const clock = mock.clock(on, { now: START })
  const store = memoryStore(on, overrides ? { dataPoints: overrides } : {})
  const posts = network(on)
  // A read of the merged settings names no source. The layers object is read as each read comes, so a test can change it mid-session.
  if (merged) Object.assign(layers, { undefined: merged })
  const rig = boot(on, { entrypoint: 'remote_cowork', env, layers })
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
  return { clock, posts, store, rig }
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
async function session($: Engine, on: On, opts: { env?: Record<string, string>; overrides?: Overrides; layers?: Layers } = {}) {
  const { posts } = world(on, opts.env, opts.overrides, undefined, opts.layers)
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
      mcpServers: { linear: { type: 'http', url: 'https://ana:hun@ter2@mcp.example.com/mcp?team=acme#x', headers: { Authorization: 'Bearer abc' } } },
      projects: { [ROOT]: { enabledMcpjsonServers: ['docs', 'linear'], mcpServers: { db: { command: 'npx', args: ['db-mcp', '--api-key', 'sk_live_abc123'], env: { DB_PASSWORD: 'pw' } } } } },
    },
    [`${ROOT}/.mcp.json`]: { mcpServers: { docs: { type: 'sse', url: 'https://docs.example.com/sse' }, linear: { url: 'https://other.example.com' }, declined: { url: 'https://declined.example.com' } } },
  }

  /** The engine beneath, with Claude's settings files in place; a slash command expands its skill as it runs, as Claude Code's do. */
  function engine($: Engine, on: On, overrides?: Overrides, files: Record<string, unknown> = FILES, merged?: Record<string, unknown>, layers?: Layers, env: Record<string, string> = {}) {
    const { posts } = world(on, { HOME, ...env }, overrides, merged, layers)
    const reads: string[] = []
    on('fs.read', (_$, e) => {
      const path = (e as { path: string }).path
      reads.push(path)
      if (!(path in files)) throw new Error('ENOENT')
      return { value: JSON.stringify(files[path]) } as never
    })
    on('session.root', () => ({ value: ROOT }) as never)
    on('skill.prompt', (_$, e) => ({ text: (e as { text: string }).text }) as never)
    // `/fix 12 login` expands positionally: the text holds the words, never the arguments as typed.
    on('command.run', async (_$, e) => {
      const { command, args } = e as { command: string; args: string }
      const [n, area] = args.split(' ')
      await $.skill.prompt({ skill: command, text: `Fix PR ${n}, in the ${area} flow.`, source: 'userSettings', frontmatter: {} } as never)
      return {} as never
    })
    return { posts, reads }
  }

  /** A whole session that runs two skills, a slash command with arguments, a claude.ai connector and a configured server. */
  async function run($: Engine, on: On, overrides?: Overrides, files?: Record<string, unknown>, merged?: Record<string, unknown>, layers?: Layers, env?: Record<string, string>) {
    const { posts, reads } = engine($, on, overrides, files, merged, layers, env)
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)
    await turn($)
    for (let i = 0; i < 2; i++) await $.skill.prompt({ skill: 'review', text: 'Review the diff for correctness bugs.', source: 'userSettings', frontmatter: {} } as never)
    await $.command.run({ command: 'fix', args: '12 login' } as never)
    await $.tool.call({ tool: 'mcp__claude_ai_Gmail__create_draft', to: 'x', tool_use_id: 'toolu_2' } as never)
    await row($, 'tool_result', { tool_name: 'mcp_tool', tool_use_id: 'toolu_2', success: 'true', mcp_server_scope: 'claudeai' })
    await $.tool.call({ tool: 'mcp__linear__list_issues', tool_use_id: 'toolu_3' } as never)
    await row($, 'tool_result', { tool_name: 'mcp_tool', tool_use_id: 'toolu_3', success: 'true', mcp_server_scope: 'project' })
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    return { posts, reads }
  }

  const ofEvent = (posts: readonly Post[], ev: string) => rowsOf(posts).filter(r => r['event.name'] === ev)
  const pick = (r: Record<string, unknown>) => ({ server_name: r['server_name'], server_scope: r['server_scope'], transport_type: r['transport_type'], server_url: r['server_url'] })

  test('off by default: no row, and no settings file read', keyless, async ($, on) => {
    const { posts, reads } = await run($, on)
    expect(ofEvent(posts, 'mcp_server_configured')).toEqual([])
    expect(ofEvent(posts, 'skill_prompt')).toEqual([])
    expect(reads).toEqual([])
  })

  test("on: each server once, the nearest setting first, approved, its address without credentials, query or secret flags; a called one's name and scope", keyless, async ($, on) => {
    const { posts } = await run($, on, { 'mcp.url': 'on' })
    const servers = ofEvent(posts, 'mcp_server_configured')
    expect(servers.map(pick)).toEqual([
      { server_name: 'db', server_scope: 'local', transport_type: 'stdio', server_url: 'npx db-mcp --api-key [REDACTED:assigned_secret]' },
      { server_name: 'docs', server_scope: 'project', transport_type: 'sse', server_url: 'https://docs.example.com/sse' },
      { server_name: 'linear', server_scope: 'project', transport_type: 'http', server_url: 'https://other.example.com' },
      { server_name: 'remote-devices', server_scope: 'unknown', transport_type: undefined, server_url: undefined },
      { server_name: 'claude_ai_Gmail', server_scope: 'claudeai', transport_type: undefined, server_url: undefined },
    ])
    // Routed as the session's other rows are, and nothing else in the files read is sent.
    expect(servers[0]).toEqual(expect.objectContaining({ 'organization.id': ORG, 'user.email': EMAIL, 'mainwave.telemetry.route': 'plugin' }))
    // The plugin's own rows carry its full stamp, each key in its contracted shape.
    for (const r of servers) {
      expect(STAMPED.filter(k => !(k in r))).toEqual([])
      expect(contractViolations(r)).toEqual([])
    }
    const all = posts.map(p => p.body).join('\n')
    for (const secret of ['hun@ter2', 'ter2', 'Bearer abc', 'DB_PASSWORD', 'oauthAccount', 'team=acme', 'sk_live', 'declined']) expect(all).not.toContain(secret)
  })

  test("a managed file has exclusive control; a server the organization denies goes nowhere; a plugin's servers, where it is enabled", keyless, async ($, on) => {
    const managed = { ...FILES, '/etc/claude-code/managed-mcp.json': { mcpServers: { corp: { url: 'https://corp.example.com/mcp' }, banned: { url: 'https://banned.example.com' } } } }
    const { posts } = await run($, on, { 'mcp.url': 'on' }, managed, { deniedMcpServers: [{ serverName: 'banned' }] })
    expect(ofEvent(posts, 'mcp_server_configured').map(r => r['server_name'])).toEqual(['corp', 'remote-devices', 'claude_ai_Gmail', 'linear'])
  })

  test("a plugin's servers, where it is enabled, named as Claude Code names them", keyless, async ($, on) => {
    const files = {
      [`${HOME}/.claude/plugins/installed_plugins.json`]: { version: 2, plugins: { 'tools@market': [{ installPath: '/p/tools' }], 'off@market': [{ installPath: '/p/off' }] } },
      '/p/tools/.claude-plugin/plugin.json': { name: 'tools', mcpServers: './servers.json' },
      '/p/tools/servers.json': { mcpServers: { search: { url: 'https://search.example.com/mcp' } } },
      '/p/off/.mcp.json': { mcpServers: { hidden: { url: 'https://hidden.example.com' } } },
    }
    const { posts } = await run($, on, { 'mcp.url': 'on' }, files, { enabledPlugins: { 'tools@market': true, 'off@market': false } })
    expect(ofEvent(posts, 'mcp_server_configured').map(pick)[0]).toEqual({ server_name: 'plugin:tools:search', server_scope: 'plugin', transport_type: 'http', server_url: 'https://search.example.com/mcp' })
    expect(posts.map(p => p.body).join('\n')).not.toContain('hidden')
  })

  test("on: a skill's text once per session, later runs by its ID; a text holding the person's arguments only where prompts go", keyless, async ($, on) => {
    const skills = ofEvent((await run($, on, { 'skill.text': 'on', 'prompt.text': 'off' })).posts, 'skill_prompt')
    expect(skills).toHaveLength(3)
    const [first, again, fix] = skills
    expect(first).toEqual(expect.objectContaining({ 'skill.name': 'review', 'skill.source': 'userSettings', 'skill.text': 'Review the diff for correctness bugs.', 'skill.has_arguments': false }))
    expect(again!['skill.text']).toBeUndefined()
    expect(again!['skill.text_id']).toBe(first!['skill.text_id'])
    // Expanded inside its command, positionally: held back all the same.
    expect(fix).toEqual(expect.objectContaining({ 'skill.name': 'fix', 'skill.has_arguments': true, 'skill.text_held_back': true }))
    expect(fix!['skill.text']).toBeUndefined()
  })

  test("a run given arguments at its prompt, expanded later and outside its command, positionally: its text held back all the same", keyless, async ($, on) => {
    const { posts } = engine($, on, { 'skill.text': 'on', 'prompt.text': 'off' })
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)
    await turn($)
    await $.prompt.submit({ text: '/fix 12 login' } as never)
    // The turn before it ends first; the skill expands after.
    await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 40, isAborted: false, reason: 'answer' } as never)
    await $.skill.prompt({ skill: 'fix', text: 'Fix PR 12, in the login flow.', source: 'userSettings', frontmatter: {} } as never)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    const fix = ofEvent(posts, 'skill_prompt')[0]!
    expect(fix['skill.has_arguments']).toBe(true)
    expect(fix['skill.text']).toBeUndefined()
    expect(posts.map(p => p.body).join('\n')).not.toContain('login flow')
  })

  test("runs before the session's identity is known: the text rides on the first alone", keyless, async ($, on) => {
    const { posts } = engine($, on, { 'skill.text': 'on' })
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)
    for (let i = 0; i < 3; i++) await $.skill.prompt({ skill: 'review', text: 'Review it.', source: 'userSettings', frontmatter: {} } as never)
    await turn($)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(ofEvent(posts, 'skill_prompt').map(r => r['skill.text'])).toEqual(['Review it.', undefined, undefined])
  })

  test('a /clear starts a new session: its servers and skill texts are sent again, under its own id', keyless, async ($, on) => {
    const { posts } = engine($, on, { 'mcp.url': 'on', 'skill.text': 'on' })
    await $.session.start({ cwd: ROOT, surface: null, isInteractive: false } as never)
    await turn($)
    await $.skill.prompt({ skill: 'review', text: 'Review it.', source: 'userSettings', frontmatter: {} } as never)
    await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } } as never)
    await $.skill.prompt({ skill: 'review', text: 'Review it.', source: 'userSettings', frontmatter: {} } as never)
    await $.telemetry.log({ to: 'collector', event: 'user_prompt', loggedAt: LOGGED_AT, attributes: { ...COMMON, 'session.id': 's-2', 'event.name': 'user_prompt', 'event.sequence': 1, prompt_length: '2' } } as never)
    await $.session.end({ reason: 'other', sessionId: 's-2', resume: { id: 's-2' } } as never)
    const bySession = (ev: string, id: string) => ofEvent(posts, ev).filter(r => r['session.id'] === id)
    expect(bySession('mcp_server_configured', 's-2').map(r => r['server_name'])).toEqual(['db', 'docs', 'linear'])
    expect(bySession('skill_prompt', 's-1').map(r => r['skill.text'])).toEqual(['Review it.'])
    expect(bySession('skill_prompt', 's-2').map(r => r['skill.text'])).toEqual(['Review it.'])
  })

  test("opted in to by the person: the servers and skill texts are sent, each row saying it was their opt-in", keyless, async ($, on) => {
    const { posts } = await run($, on, undefined, undefined, undefined, { user: optInOption(['mcp.url', 'skill.text']) })
    const servers = ofEvent(posts, 'mcp_server_configured')
    expect(servers.map(r => r['server_name'])).toEqual(['db', 'docs', 'linear', 'remote-devices', 'claude_ai_Gmail'])
    expect(servers.every(r => r['mainwave.telemetry.opt_in'] === 'mcp.url,skill.text')).toBe(true)
    expect(ofEvent(posts, 'skill_prompt')[0]!['skill.text']).toBe('Review the diff for correctness bugs.')
  })

  test('opted in to, under a session that sets MCP and skill names to 0: nothing the plugin alone would send', keyless, async ($, on) => {
    const { posts, reads } = await run($, on, undefined, undefined, undefined, { user: optInOption(['mcp.url', 'skill.text']) }, { OTEL_LOG_TOOL_DETAILS: '0' })
    expect(ofEvent(posts, 'mcp_server_configured')).toEqual([])
    expect(ofEvent(posts, 'skill_prompt')).toEqual([])
    expect(reads).toEqual([])
  })

  test('opted in to, where the organization set MCP names off: no server is sent', keyless, async ($, on) => {
    const { posts, reads } = await run($, on, { 'tool.mcp': 'off' }, undefined, undefined, { user: optInOption(['mcp.url']) })
    expect(ofEvent(posts, 'mcp_server_configured')).toEqual([])
    expect(reads).toEqual([])
  })
})

describe("the person's opt-in, in their own user settings", () => {
  const thinkingOf = (posts: readonly Post[]) => spansOf(posts).find(s => s.name === 'claude_code.llm_request')!.attrs['response.thinking']

  test("turns on thinking, off by default; every row and span of the copy says so, no metric and none of the exporter's rows", keyless, async ($, on) => {
    const { posts, rig } = world(on, {}, undefined, undefined, { user: optInOption(['response.thinking']) })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(thinkingOf(posts)).toBe('Commit first.')
    const rows = rowsOf(posts)
    const spans = spansOf(posts)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of [...rows, ...spans.map(s => s.attrs)]) {
      expect(r['mainwave.telemetry.opt_in']).toBe('response.thinking')
      expect(contractViolations(r)).toEqual([])
    }
    expect(posts.filter(p => p.url.endsWith('/v1/metrics')).map(p => p.body).join('')).not.toContain('opt_in')
    expect(rig.rows.length).toBeGreaterThan(0)
    for (const r of rig.rows) expect(r.attributes['mainwave.telemetry.opt_in']).toBeUndefined()
  })

  test('under any of the plugin ids, as a list or a string', keyless, async ($, on) => {
    expect(thinkingOf(await session($, on, { layers: { user: optInOption('response.thinking', 'mainwave') } }))).toBe('Commit first.')
  })

  test('only adds: one on by default, an unknown ID, a required one and a value of the wrong type change nothing, and turn nothing off', keyless, async ($, on) => {
    const posts = await session($, on, { layers: { user: optInOption(['prompt.text', 'tool.input', 'everything', 'usage', 7]) } })
    const all = posts.map(p => p.body).join('\n')
    expect(all).toContain('ship it')
    expect(all).toContain('commit -m')
    expect(all).not.toContain('mainwave.telemetry.opt_in')
    expect(thinkingOf(posts)).toBeUndefined()
  })

  for (const [name, value] of [['a number', 42], ['true', true], ['an object', { 'response.thinking': true }], ['null', null]] as const) {
    test(`a value of the wrong type (${name}) is ignored, and the plugin goes on as without it`, keyless, async ($, on) => {
      const posts = await session($, on, { layers: { user: optInOption(value) } })
      expect(rowsOf(posts).find(r => r['event.name'] === 'user_prompt')!['prompt']).toBe('ship it')
      expect(thinkingOf(posts)).toBeUndefined()
    })
  }

  test("user settings that can't be read opt in to nothing, and the plugin goes on", keyless, async ($, on) => {
    const posts = await session($, on, { layers: { user: 'reject' } })
    expect(rowsOf(posts).find(r => r['event.name'] === 'user_prompt')!['prompt']).toBe('ship it')
    expect(thinkingOf(posts)).toBeUndefined()
  })

  test("an organization's explicit off stays off", keyless, async ($, on) => {
    const posts = await session($, on, { overrides: { 'response.thinking': 'off' }, layers: { user: optInOption(['response.thinking']) } })
    expect(thinkingOf(posts)).toBeUndefined()
    expect(posts.map(p => p.body).join('\n')).not.toContain('mainwave.telemetry.opt_in')
  })

  test("a repository's settings, the local project's, --settings and managed settings opt in to nothing", keyless, async ($, on) => {
    const opt = optInOption(['response.thinking'])
    const posts = await session($, on, { layers: { project: opt, local: opt, flag: opt, policy: opt, undefined: opt } as Layers })
    expect(thinkingOf(posts)).toBeUndefined()
    expect(posts.map(p => p.body).join('\n')).not.toContain('mainwave.telemetry.opt_in')
  })

  test('taken off the list after a record was queued: it goes without it, as the list is read again before each send', keyless, async ($, on) => {
    const layers: Layers = { user: optInOption(['response.thinking']) }
    const { posts } = world(on, {}, undefined, undefined, layers)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($)
    layers.user = {}
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(thinkingOf(posts)).toBeUndefined()
    expect(posts.map(p => p.body).join('\n')).not.toContain('Commit first.')
    expect(posts.map(p => p.body).join('\n')).not.toContain('mainwave.telemetry.opt_in')
  })
})
