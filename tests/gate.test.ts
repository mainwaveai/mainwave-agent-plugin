// The data-point gate, the catalog it reads and the always-on protections, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { CATALOG, DEFAULTS, ownerOf } from '../hooks/catalog.ts'
import { allows, gateAttributes, gateEvent, gatePoint, gateRow, gateSpan, optInOf, resolveGate } from '../hooks/gate.ts'
import type { BuiltSpan } from '../hooks/otlp.ts'
import { contentLimit, CONTENT_MAX_LENGTH, cut, redact } from '../hooks/protect.ts'

const SWITCHED_OFF = { OTEL_LOG_TOOL_DETAILS: '0', OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_USER_PROMPTS: '0', OTEL_METRICS_INCLUDE_REPOSITORY: '0' }

describe('the catalog', () => {
  test('twenty-four data points: four required, nine metadata, four identifiers and seven content, each ID once', () => {
    expect(CATALOG.length).toBe(24)
    expect(new Set(CATALOG.map(d => d.id)).size).toBe(24)
    expect(CATALOG.filter(d => d.required).map(d => d.id)).toEqual(['session.identity', 'session.links', 'session.client', 'usage'])
    const switchable = CATALOG.filter(d => !d.required)
    expect(switchable.filter(d => d.class === 'metadata').length).toBe(9)
    expect(switchable.filter(d => d.class === 'identifiers').length).toBe(4)
    expect(switchable.filter(d => d.class === 'content').length).toBe(7)
  })

  test('MCP server addresses add detail to MCP names, and skill text to skill names', () => {
    expect(CATALOG.find(d => d.id === 'mcp.url')?.needs).toBe('tool.mcp')
    expect(CATALOG.find(d => d.id === 'skill.text')?.needs).toBe('skill.name')
  })

  test('every switchable data point has a default, and only it', () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual(CATALOG.filter(d => !d.required).map(d => d.id).sort())
  })

  test("Claude Code's attribute names belong to their data points", () => {
    expect(ownerOf('claude_code.tool', 'full_command')?.id).toBe('bash.command')
    expect(ownerOf('claude_code.tool', 'file_path')?.id).toBe('file.path')
    expect(ownerOf('claude_code.tool', 'skill_name')?.id).toBe('skill.name')
    expect(ownerOf('claude_code.tool', 'subagent_type')?.id).toBe('agent.type')
    expect(ownerOf('api_request', 'vcs.repository.url.full')?.id).toBe('repo')
    expect(ownerOf('user_prompt', 'prompt')).toEqual({ id: 'prompt.text', redact: true })
    // The same key elsewhere is another data point's, or a required one's.
    expect(ownerOf('api_error', 'error')).toBeUndefined()
    expect(ownerOf('claude_code.llm_request', 'success')).toBeUndefined()
    expect(ownerOf('api_request', 'model')).toBeUndefined()
  })
})

describe('resolveGate', () => {
  test("with nothing set, each data point Claude Code emits with the org-wide setup's captures on is on; thinking is off", () => {
    const g = resolveGate({})
    for (const id of ['tool.mcp', 'skill.name', 'agent.type', 'repo', 'file.path', 'bash.command', 'tool.input', 'tool.result', 'prompt.text', 'response.text'] as const) {
      expect([id, g.settings.get(id)]).toEqual([id, 'on'])
    }
    // Claude Code exports none of these.
    expect(g.settings.get('response.thinking')).toBe('off')
    expect(g.settings.get('mcp.url')).toBe('off')
    expect(g.settings.get('skill.text')).toBe('off')
    expect(g.settings.get('usage')).toBe('required')
  })

  test('a switch set to 0 turns the data points it governs to follow Claude Code, and leaves the rest on', () => {
    const g = resolveGate({ OTEL_LOG_TOOL_DETAILS: '0', OTEL_LOG_USER_PROMPTS: 'false' })
    expect(g.settings.get('bash.command')).toBe('claude')
    expect(g.settings.get('file.path')).toBe('claude')
    expect(g.settings.get('prompt.text')).toBe('claude')
    // Responses follow prompts when their own switch is unset, as in Claude Code.
    expect(g.settings.get('response.text')).toBe('claude')
    expect(g.settings.get('tool.result')).toBe('on')
    expect(g.settings.get('bash.class')).toBe('on')
    expect(resolveGate({ OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_ASSISTANT_RESPONSES: '1' }).settings.get('response.text')).toBe('on')
  })

  test('a switch set to 1, or to anything but a false value, keeps the default', () => {
    expect(resolveGate({ OTEL_LOG_TOOL_DETAILS: '1' }).settings.get('bash.command')).toBe('on')
    expect(resolveGate({ OTEL_LOG_TOOL_DETAILS: '' }).settings.get('bash.command')).toBe('on')
  })

  test('an explicit setting wins over the default and the switch; a required data point stays required', () => {
    const g = resolveGate({ OTEL_LOG_TOOL_DETAILS: '0' }, { 'bash.command': 'on', 'tool.call': 'off', 'response.thinking': 'on', usage: 'off' })
    expect(g.settings.get('bash.command')).toBe('on')
    expect(g.settings.get('tool.call')).toBe('off')
    expect(g.settings.get('response.thinking')).toBe('on')
    expect(g.settings.get('usage')).toBe('required')
  })
})

describe("the person's opt-in", () => {
  test('turns on each data point listed that is off by default, and says which', () => {
    const g = resolveGate({}, {}, undefined, ['response.thinking', 'mcp.url'])
    expect(g.settings.get('response.thinking')).toBe('on')
    expect(g.settings.get('mcp.url')).toBe('on')
    expect(g.settings.get('skill.text')).toBe('off')
    // In catalog order, whatever order the list is in.
    expect(g.optedIn).toEqual(['mcp.url', 'response.thinking'])
    expect(resolveGate({}).optedIn).toEqual([])
  })

  test('only adds: a data point on by default stays as it is, and nothing listed or not turns anything off', () => {
    const everything = CATALOG.map(d => d.id)
    const g = resolveGate({}, {}, undefined, ['tool.input', 'prompt.text'])
    const plain = resolveGate({})
    for (const d of CATALOG) expect([d.id, g.settings.get(d.id)]).toEqual([d.id, plain.settings.get(d.id)])
    expect(g.optedIn).toEqual([])
    const all = resolveGate({}, {}, undefined, everything)
    for (const d of CATALOG) expect([d.id, all.settings.get(d.id)]).toEqual([d.id, d.required ? 'required' : 'on'])
    expect(all.optedIn).toEqual(['mcp.url', 'skill.text', 'response.thinking'])
  })

  test('an explicit setting wins: off stays off, claude stays claude, and an explicit on is not an opt-in', () => {
    const g = resolveGate({}, { 'response.thinking': 'off', 'skill.text': 'claude', 'mcp.url': 'on' }, undefined, ['response.thinking', 'skill.text', 'mcp.url'])
    expect(g.settings.get('response.thinking')).toBe('off')
    expect(g.settings.get('skill.text')).toBe('claude')
    expect(g.settings.get('mcp.url')).toBe('on')
    expect(g.optedIn).toEqual([])
  })

  test("thinking follows the responses' switch for the opt-in: a session that turned responses off gets none, unless set explicitly", () => {
    const asked = ['response.thinking'] as const
    expect(resolveGate({ OTEL_LOG_ASSISTANT_RESPONSES: '0' }, {}, undefined, asked).settings.get('response.thinking')).toBe('off')
    // Responses follow prompts when their own switch is unset, as in Claude Code.
    expect(resolveGate({ OTEL_LOG_USER_PROMPTS: '0' }, {}, undefined, asked).settings.get('response.thinking')).toBe('off')
    expect(resolveGate({ OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_ASSISTANT_RESPONSES: '1' }, {}, undefined, asked).settings.get('response.thinking')).toBe('on')
    expect(resolveGate({ OTEL_LOG_TOOL_DETAILS: '0' }, {}, undefined, asked).settings.get('response.thinking')).toBe('on')
    expect(resolveGate({ OTEL_LOG_ASSISTANT_RESPONSES: '0' }, { 'response.thinking': 'on' }).settings.get('response.thinking')).toBe('on')
    expect(resolveGate({ OTEL_LOG_ASSISTANT_RESPONSES: '0' }, {}, undefined, asked).optedIn).toEqual([])
  })

  test('the stamp names only what the opt-in lets go somewhere: not one the data point it adds detail to keeps back', () => {
    const all = ['mcp.url', 'skill.text', 'response.thinking'] as const
    expect(resolveGate({ OTEL_LOG_TOOL_DETAILS: '0' }, {}, undefined, all).optedIn).toEqual(['response.thinking'])
    expect(resolveGate({}, { 'tool.mcp': 'off' }, undefined, all).optedIn).toEqual(['skill.text', 'response.thinking'])
    expect(resolveGate({}, { 'skill.name': 'claude' }, undefined, all).optedIn).toEqual(['mcp.url', 'response.thinking'])
  })

  test('a switch the session sets to 0 keeps what it governs as Claude Code sends it, opt-in or not', () => {
    const g = resolveGate({ OTEL_LOG_TOOL_DETAILS: '0' }, {}, undefined, ['bash.command', 'mcp.url', 'skill.text'])
    expect(g.settings.get('bash.command')).toBe('claude')
    // What they add detail to follows Claude Code, so they go nowhere the plugin alone would send them.
    expect(allows(g, 'mcp.url', false)).toBe(false)
    expect(allows(g, 'skill.text', false)).toBe(false)
  })

  test('a data point opted in to still goes only where the one it adds detail to goes', () => {
    expect(allows(resolveGate({}, {}, undefined, ['mcp.url']), 'mcp.url', false)).toBe(true)
    expect(allows(resolveGate({}, { 'tool.mcp': 'off' }, undefined, ['mcp.url']), 'mcp.url', false)).toBe(false)
    expect(allows(resolveGate({}, { 'skill.name': 'off' }, undefined, ['skill.text']), 'skill.text', false)).toBe(false)
    // And tool input, which holds others, only where they all go.
    expect(allows(resolveGate({}, { 'web.url': 'off' }, undefined, ['tool.input']), 'tool.input', false)).toBe(false)
  })

  const values: [string, unknown, string[]][] = [
    ['a list', ['response.thinking', 'mcp.url'], ['mcp.url', 'response.thinking']],
    ['a string, commas and spaces', ' skill.text, mcp.url  response.thinking ', ['mcp.url', 'skill.text', 'response.thinking']],
    ['twice', ['mcp.url', 'mcp.url'], ['mcp.url']],
    ['an unknown ID', ['mcp.url', 'mcp.urls', 'everything', '*'], ['mcp.url']],
    ['a required data point', ['usage', 'session.identity', 'skill.text'], ['skill.text']],
    ['one on by default, kept and harmless', ['tool.input'], ['tool.input']],
    ['items of another type', [1, null, { id: 'mcp.url' }, ['mcp.url'], 'skill.text'], ['skill.text']],
    ['a number', 42, []],
    ['true', true, []],
    ['an object', { 'mcp.url': true }, []],
    ['null', null, []],
    ['unset', undefined, []],
    ['empty', '', []],
  ]
  for (const [name, raw, want] of values) test(`optInOf: ${name}`, () => expect(optInOf(raw)).toEqual(want))

  test('every record the plugin sends carries the data points opted in to, and only while there are any', () => {
    const optedIn = resolveGate({}, {}, undefined, ['response.thinking', 'mcp.url'])
    const prompt = { event: 'user_prompt', loggedAt: '2026-11-12T00:00:00.000Z', attributes: { 'organization.id': 'o', prompt: 'go', 'mainwave.telemetry.route': 'plugin' } }
    const stamped = gateRow(optedIn, prompt)!.attributes
    expect(stamped['mainwave.telemetry.opt_in']).toBe('mcp.url,response.thinking')
    expect(Object.keys(stamped).at(-1)).toBe('mainwave.telemetry.opt_in')
    // Gated again as it is sent, under a gate with no opt-in: the stamp goes with what it said.
    expect(gateRow(resolveGate({}), { ...prompt, attributes: stamped })!.attributes['mainwave.telemetry.opt_in']).toBeUndefined()
    // Gated again under the same: one stamp, unchanged.
    expect(gateRow(optedIn, { ...prompt, attributes: stamped })!.attributes).toEqual(stamped)
    const span: BuiltSpan = { name: 'claude_code.llm_request', traceId: 't'.repeat(32), spanId: 's'.repeat(16), startMs: 0, endMs: 1, attributes: { 'response.thinking': 'Commit first.' } }
    expect(gateSpan(optedIn, span).attributes).toEqual({ 'response.thinking': 'Commit first.', 'mainwave.telemetry.opt_in': 'mcp.url,response.thinking' })
    expect(gateSpan(resolveGate({}), span).attributes).toEqual({})
    // Not on a metric point: its attributes name its series.
    const point = { name: 'claude_code.token.usage', startMs: 0, timeMs: 1, value: 1, attributes: { type: 'input' } }
    expect(gatePoint(optedIn, point)!.attributes).toEqual({ type: 'input' })
  })
})

describe('allows', () => {
  test('on goes everywhere, off nowhere, claude where Claude Code sends it', () => {
    const g = resolveGate({}, { 'bash.command': 'on', 'file.path': 'off', 'skill.name': 'claude' })
    expect([allows(g, 'bash.command', false), allows(g, 'bash.command', true)]).toEqual([true, true])
    expect([allows(g, 'file.path', false), allows(g, 'file.path', true)]).toEqual([false, false])
    expect([allows(g, 'skill.name', false), allows(g, 'skill.name', true)]).toEqual([false, true])
    expect(allows(g, 'session.identity', false)).toBe(true)
  })

  test('tool input goes only where the commands, file paths and web addresses it holds all go', () => {
    expect(allows(resolveGate({}), 'tool.input', false)).toBe(true)
    expect(allows(resolveGate({}, { 'web.url': 'off' }), 'tool.input', false)).toBe(false)
    expect(allows(resolveGate({}, { 'bash.command': 'claude' }), 'tool.input', false)).toBe(false)
    expect(allows(resolveGate({}, { 'bash.command': 'claude' }), 'tool.input', true)).toBe(true)
  })

  test('a data point that adds detail to another goes only where that one goes', () => {
    expect(allows(resolveGate({}, { 'mcp.url': 'on' }), 'mcp.url', false)).toBe(true)
    expect(allows(resolveGate({}, { 'mcp.url': 'on', 'tool.mcp': 'off' }), 'mcp.url', false)).toBe(false)
    expect(allows(resolveGate({ OTEL_LOG_TOOL_DETAILS: '0' }, { 'skill.text': 'on' }), 'skill.text', false)).toBe(false)
    expect(allows(resolveGate({}, { 'skill.text': 'on' }), 'skill.text', false)).toBe(true)
  })
})

describe('gateAttributes on a row', () => {
  const row = {
    'organization.id': 'o', 'vcs.repository.url.full': 'https://github.com/acme/api', 'event.name': 'tool_result', tool_name: 'Bash', tool_use_id: 'toolu_1',
    tool_parameters: '{"bash_command":"git","full_command":"git push","description":"Push","git_branch":"main"}', tool_input: '{"command":"git push"}',
  }

  test('with the defaults the row goes as Claude Code wrote it, byte for byte', () => {
    const out = gateAttributes(resolveGate({}), 'tool_result', row)
    expect(out).toEqual(row)
    expect(out['tool_parameters']).toBe(row.tool_parameters)
  })

  test("a data point that is off leaves the row, and Claude Code's tool_parameters keeps the keys of the rest, in order", () => {
    const out = gateAttributes(resolveGate({}, { repo: 'off' }), 'tool_result', row)
    expect(out['vcs.repository.url.full']).toBeUndefined()
    expect(out['tool_parameters']).toBe('{"bash_command":"git","full_command":"git push","description":"Push"}')
    expect(Object.keys(out)).toEqual(['organization.id', 'event.name', 'tool_name', 'tool_use_id', 'tool_parameters', 'tool_input'])
    // Tool input holds the command, and the description is tool input: with commands off, none of it is left.
    const none = gateAttributes(resolveGate({}, { 'bash.command': 'off' }), 'tool_result', row)
    expect(none['tool_parameters']).toBe('{"git_branch":"main"}')
    expect(none['tool_input']).toBeUndefined()
  })

  test('withheld text reads <REDACTED>, as Claude Code writes it', () => {
    const out = gateAttributes(resolveGate({}, { 'prompt.text': 'off' }), 'user_prompt', { prompt: 'secret plan', prompt_text: 'secret plan', prompt_length: '11' })
    expect(out).toEqual({ prompt: '<REDACTED>', prompt_text: '<REDACTED>', prompt_length: '11' })
  })

  test("what the plugin read fills what Claude Code withheld, where its data point is on; under claude it does not", () => {
    const withheld = { tool_name: 'mcp_tool', tool_use_id: 'toolu_1', success: 'true' }
    const fill = { parameters: { bash_command: 'git', full_command: 'git push', mcp_server_name: 'remote-devices', mcp_tool_name: 'device_bash' }, attributes: { tool_input: '{"command":"git push"}' } }
    const on = gateAttributes(resolveGate({}), 'tool_result', withheld, fill)
    expect(on['tool_parameters']).toBe('{"bash_command":"git","full_command":"git push","mcp_server_name":"remote-devices","mcp_tool_name":"device_bash"}')
    expect(on['tool_input']).toBe('{"command":"git push"}')
    const asClaude = gateAttributes(resolveGate(SWITCHED_OFF), 'tool_result', withheld, fill)
    expect(asClaude).toEqual(withheld)
    const filled = gateAttributes(resolveGate({}), 'user_prompt', { prompt: '<REDACTED>', prompt_length: '2' }, { attributes: { prompt: 'go' } })
    expect(filled['prompt']).toBe('go')
  })

  test("with MCP names off, an MCP tool's name reads mcp_tool", () => {
    const span = { tool_name: 'mcp__remote-devices__device_bash', 'gen_ai.tool.name': 'device_bash', 'anthropic.mcp.server.name': 'remote-devices' }
    expect(gateAttributes(resolveGate({}, { 'tool.mcp': 'off' }), 'claude_code.tool', span)).toEqual({ tool_name: 'mcp_tool', 'gen_ai.tool.name': 'mcp_tool' })
    const playwright = { tool_name: 'mcp__playwright__browser_click', tool_name_safe: 'mcp__playwright__browser_click' }
    expect(gateAttributes(resolveGate({}, { 'tool.mcp': 'off' }), 'claude_code.tool', playwright)).toEqual({ tool_name: 'mcp_tool', tool_name_safe: 'mcp_other' })
    expect(gateAttributes(resolveGate({}, { 'tool.mcp': 'off' }), 'claude_code.tool', { tool_name: 'Bash', 'gen_ai.tool.name': 'Bash' })).toEqual({ tool_name: 'Bash', 'gen_ai.tool.name': 'Bash' })
  })

  test('a secret is replaced in identifiers and content, whatever the gate, and the record counts it; elsewhere it is left alone', () => {
    const out = gateAttributes(resolveGate({}), 'claude_code.tool', { full_command: 'curl -H "Authorization: Bearer abc123" https://example.com', model: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(out['full_command']).toBe('curl -H "Authorization: Bearer [REDACTED:authorization]" https://example.com')
    expect(out['model']).toBe('sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(out['mainwave.redaction.count']).toBe(1)
    // Once more through the gate, as it is sent: nothing more to replace, and the count stands.
    expect(gateAttributes(resolveGate({}), 'claude_code.tool', out)).toEqual(out)
  })

  test('a value past the limit is cut, with Claude Code\'s marker and the original length beside it', () => {
    const g = resolveGate({}, {}, 2048)
    const out = gateAttributes(g, 'claude_code.tool', { full_command: 'x'.repeat(3000) })
    expect((out['full_command'] as string).length).toBe(2048)
    expect((out['full_command'] as string).endsWith('\n[TRUNCATED - Content exceeds 2KB limit]')).toBe(true)
    expect(out['full_command_truncated']).toBe(true)
    expect(out['full_command_original_length']).toBe(3000)
  })
})

describe('a record an earlier load captured', () => {
  test("is held, where a data point follows Claude Code, to what is on: this load cannot tell the plugin's reading from Claude Code's", () => {
    const row = { event: 'user_prompt', loggedAt: '2026-11-12T00:00:00.000Z', attributes: { prompt: 'hello', prompt_length: '5', 'vcs.repository.name': 'api' } }
    const g = resolveGate({ OTEL_LOG_USER_PROMPTS: '0' })
    expect(gateRow(g, row)!.attributes['prompt']).toBe('hello')
    expect(gateRow(g, row, true)!.attributes).toEqual({ prompt: '<REDACTED>', prompt_length: '5', 'vcs.repository.name': 'api' })
  })
})

describe("the plugin's own rows", () => {
  const server = { event: 'mcp_server_configured', loggedAt: '2026-11-12T00:00:00.000Z', attributes: { 'organization.id': 'o', server_name: 'linear', server_scope: 'user', transport_type: 'http', server_url: 'https://mcp.example.com/mcp' } }
  const skill = (attributes: Record<string, string | boolean>) => ({ event: 'skill_prompt', loggedAt: '2026-11-12T00:00:00.000Z', attributes: { 'organization.id': 'o', 'skill.name': 'review', 'skill.text_id': 'abc', ...attributes } })

  test('go only while their data point is on: none is sent by default, Claude Code exporting neither', () => {
    expect(gateRow(resolveGate({}), server)).toBeNull()
    expect(gateRow(resolveGate({}, { 'mcp.url': 'on' }), server)?.attributes['server_url']).toBe('https://mcp.example.com/mcp')
    expect(gateRow(resolveGate({}, { 'mcp.url': 'on', 'tool.mcp': 'off' }), server)).toBeNull()
    expect(gateRow(resolveGate({}, { 'mcp.url': 'claude' }), server)).toBeNull()
    expect(gateRow(resolveGate({}), skill({ 'skill.text': 'Review it.' }))).toBeNull()
  })

  test("a skill's text with arguments filled in goes only where prompts do; held back, the row says so", () => {
    const g = resolveGate({}, { 'skill.text': 'on', 'prompt.text': 'off' })
    expect(gateRow(g, skill({ 'skill.text': 'Review it.', 'skill.has_arguments': false }))?.attributes['skill.text']).toBe('Review it.')
    const held = gateRow(g, skill({ 'skill.text': 'Review PR 12.', 'skill.has_arguments': true }))!.attributes
    expect(held['skill.text']).toBeUndefined()
    expect(held['skill.text_held_back']).toBe(true)
    expect(gateRow(resolveGate({}, { 'skill.text': 'on' }), skill({ 'skill.text': 'Review PR 12.', 'skill.has_arguments': true }))?.attributes['skill.text']).toBe('Review PR 12.')
  })

  test('their addresses and text go through the protections', () => {
    const g = resolveGate({}, { 'mcp.url': 'on', 'skill.text': 'on' })
    const local = { ...server, attributes: { ...server.attributes, transport_type: 'stdio', server_url: `npx server --token=${'s'.repeat(24)}` } }
    expect(gateRow(g, local)?.attributes['server_url']).toBe('npx server --token=[REDACTED:assigned_secret]')
    expect(gateRow(g, skill({ 'skill.text': `Use ghp_${'a'.repeat(36)}.` }))?.attributes['skill.text']).toBe('Use [REDACTED:github_token].')
  })

  test("Claude Code's MCP connection row: its server's name and scope are MCP names", () => {
    expect(ownerOf('mcp_server_connection', 'server_name')?.id).toBe('tool.mcp')
    expect(ownerOf('mcp_server_configured', 'server_url')?.id).toBe('mcp.url')
    expect(ownerOf('skill_prompt', 'skill.text')?.id).toBe('skill.text')
  })
})

describe('gateSpan, gateEvent and gatePoint', () => {
  const span: BuiltSpan = {
    traceId: 't', spanId: 's', name: 'claude_code.tool.execution', startMs: 0, endMs: 1,
    attributes: { success: false, 'error.type': 'tool_error', error: 'Exit code 1\nls: x: No such file', error_class: 'ShellError' },
    status: { code: 2, message: 'Exit code 1\nls: x: No such file' },
  }

  test("with tool results off, a failed run keeps only its error's class, as Claude Code's does", () => {
    const out = gateSpan(resolveGate({}, { 'tool.result': 'off' }), span)
    expect(out.attributes['error']).toBe('ShellError')
    expect(out.status).toEqual({ code: 2, message: 'ShellError' })
    expect(gateSpan(resolveGate({}), span)).toEqual(span)
    // It can repeat the command or the path the call was given: with tool input off, the class alone too.
    expect(gateSpan(resolveGate({}, { 'file.path': 'off' }), span).attributes['error']).toBe('ShellError')
  })

  test("a tool's output event goes only with tool results on, and its path and command only with theirs", () => {
    const event = { name: 'tool.output', timeMs: 1, attributes: { bash_command: 'echo hi', output: 'hi' } }
    expect(gateEvent(resolveGate({}, { 'tool.result': 'off' }), event)).toBeNull()
    expect(gateEvent(resolveGate({}, { 'bash.command': 'off' }), event)?.event.attributes).toEqual({ output: 'hi' })
    expect(gateEvent(resolveGate({}), { ...event, attributes: { output: 'token=abc' } })).toEqual({ event: { ...event, attributes: { output: 'token=[REDACTED:assigned_secret]' } }, count: 1 })
  })

  test('commit and pull request counts go only with command outcomes on; a metric loses the attributes of a data point off', () => {
    const point = { name: 'claude_code.commit.count', startMs: 0, timeMs: 1, value: 1, attributes: { 'vcs.repository.name': 'api' } }
    expect(gatePoint(resolveGate({}, { 'bash.outcome': 'off' }), point)).toBeNull()
    expect(gatePoint(resolveGate({}, { repo: 'off' }), point)?.attributes).toEqual({})
  })
})

describe("a shell command's outcome stamps", () => {
  const stamped = {
    tool_name: 'Bash', 'mainwave.command.counted': 1, 'mainwave.command.commits': 1, 'mainwave.command.pushes': 1, 'mainwave.command.push_ref': 'feat/x',
    'mainwave.command.branches_opened': 1, 'mainwave.command.branch_opened': 'feat/x',
  }
  const stamps = (a: Record<string, unknown>) => Object.keys(a).filter(k => k.startsWith('mainwave.command.'))

  test('belong to command outcomes, and their refs to the repository, on the tool span alone', () => {
    expect(ownerOf('claude_code.tool', 'mainwave.command.commits')?.id).toBe('bash.outcome')
    expect(ownerOf('claude_code.tool', 'mainwave.command.counted')?.id).toBe('bash.outcome')
    expect(ownerOf('claude_code.tool', 'mainwave.command.push_ref')?.id).toBe('repo')
    expect(ownerOf('claude_code.tool.execution', 'mainwave.command.commits')).toBeUndefined()
  })

  test('go with the defaults; the refs only where the repository goes too', () => {
    expect(gateAttributes(resolveGate({}), 'claude_code.tool', stamped)).toEqual(stamped)
    expect(stamps(gateAttributes(resolveGate({}, { repo: 'off' }), 'claude_code.tool', stamped))).toEqual(['mainwave.command.counted', 'mainwave.command.commits', 'mainwave.command.pushes', 'mainwave.command.branches_opened'])
  })

  test('none goes with command outcomes off, the refs included, though the repository is on', () => {
    expect(stamps(gateAttributes(resolveGate({}, { 'bash.outcome': 'off' }), 'claude_code.tool', stamped))).toEqual([])
  })

  test('none goes as Claude Code sends it: Claude Code sends none of them', () => {
    expect(stamps(gateAttributes(resolveGate({}, { 'bash.outcome': 'claude', repo: 'claude' }), 'claude_code.tool', stamped))).toEqual([])
    expect(stamps(gateAttributes(resolveGate({}, { repo: 'claude' }), 'claude_code.tool', stamped))).toEqual(['mainwave.command.counted', 'mainwave.command.commits', 'mainwave.command.pushes', 'mainwave.command.branches_opened'])
  })

  test('a ref goes through the protections, and one the limit would cut is left off, not cut', () => {
    const secret = `ghp_${'a'.repeat(36)}`
    const out = gateAttributes(resolveGate({}), 'claude_code.tool', { ...stamped, 'mainwave.command.push_ref': secret })
    expect(out['mainwave.command.push_ref']).toBe('[REDACTED:github_token]')
    expect(out['mainwave.redaction.count']).toBe(1)
    const short = gateAttributes(resolveGate({}, {}, 4), 'claude_code.tool', stamped)
    expect(stamps(short)).toEqual(['mainwave.command.counted', 'mainwave.command.commits', 'mainwave.command.pushes', 'mainwave.command.branches_opened'])
    expect(Object.keys(short).filter(k => k.endsWith('_truncated'))).toEqual([])
  })
})

describe('protections', () => {
  test("Mainwave's secret rules and the plugin's own", () => {
    const cases: [string, string][] = [
      ['key AKIAABCDEFGHIJKLMNOP here', 'key [REDACTED:aws_access_key] here'],
      [`gh ghp_${'a'.repeat(36)}`, 'gh [REDACTED:github_token]'],
      ['sk-ant-api03-abcdefghijklmnopqrstuv', '[REDACTED:anthropic_api_key]'],
      ['xoxb-1234567890-abcdef', '[REDACTED:slack_token]'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop', '[REDACTED:jwt]'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', '[REDACTED:private_key]'],
      ['git clone https://ana:hunter2@example.com/r.git', 'git clone https://ana:[REDACTED:url_password]@example.com/r.git'],
      ['export DB_PASSWORD=hunter2 && run', 'export DB_PASSWORD=[REDACTED:assigned_secret] && run'],
      ['{"api_key":"abc","n":1}', '{"api_key":"[REDACTED:assigned_secret]","n":1}'],
      ['https://example.com/?access_token=abc&x=1', 'https://example.com/?access_token=[REDACTED:assigned_secret]&x=1'],
      ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [REDACTED:authorization]'],
      ['nothing to see', 'nothing to see'],
      ['{"max_tokens":4096} at src/token.ts:42', '{"max_tokens":4096} at src/token.ts:42'],
      ['-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\u2026[3000 chars]', '[REDACTED:private_key]\u2026[3000 chars]'],
    ]
    for (const [input, want] of cases) expect([input, redact(input).text]).toEqual([input, want])
    expect(redact('token=abc and GITHUB_TOKEN=def').count).toBe(2)
  })

  test('a long value with nothing to replace is read in linear time, cut before the rules run', () => {
    const g = resolveGate({})
    for (const filler of ['a.a.'.repeat(50_000), 'a-b_'.repeat(50_000), 'token'.repeat(40_000), 'https://x'.repeat(20_000)]) {
      const started = Date.now()
      gateAttributes(g, 'user_prompt', { prompt: filler, prompt_text: filler })
      expect([filler.slice(0, 8), Date.now() - started < 1_000]).toEqual([filler.slice(0, 8), true])
    }
  })

  test("the limit is Claude Code's, lowered by the settings Claude Code reads", () => {
    expect(contentLimit({})).toBe(CONTENT_MAX_LENGTH)
    expect(CONTENT_MAX_LENGTH).toBe(61_440)
    expect(contentLimit({ CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '100000' })).toBe(100_000)
    expect(contentLimit({ CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: '100000', OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: '500' })).toBe(500)
    expect(contentLimit({ OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: 'nope' })).toBe(CONTENT_MAX_LENGTH)
  })

  test('cut keeps a value within its limit and says so', () => {
    expect(cut('abc', 10)).toEqual({ text: 'abc', truncated: false })
    expect(cut('a'.repeat(70_000), CONTENT_MAX_LENGTH).text.endsWith('[TRUNCATED - Content exceeds 60KB limit]')).toBe(true)
    expect(cut('abcdef', 4)).toEqual({ text: 'abcd', truncated: true })
  })
})
