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
