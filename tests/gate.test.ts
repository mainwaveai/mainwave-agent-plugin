// The data-point gate, the catalog it reads and the always-on protections, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { CATALOG, DEFAULTS, ownerOf, type DataPointId } from '../hooks/catalog.ts'
import { allows, combinePacks, gateAttributes, gateEvent, gateMarker, gatePoint, gateRow, gateSpan, optInOf, packsOf, resolveGate, resolveRedaction, type Overrides } from '../hooks/gate.ts'
import type { BuiltSpan } from '../hooks/otlp.ts'
import { contentLimit, CONTENT_MAX_LENGTH, cut, redact } from '../hooks/protect.ts'
import { CAPTURES_ON } from './rig.ts'

const SWITCHED_OFF = { OTEL_LOG_TOOL_DETAILS: '0', OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_USER_PROMPTS: '0', OTEL_METRICS_INCLUDE_REPOSITORY: '0' }

describe('the catalog', () => {
  test('twenty-seven data points: four required, ten metadata, five identifiers and eight content, each ID once', () => {
    expect(CATALOG.length).toBe(27)
    expect(new Set(CATALOG.map(d => d.id)).size).toBe(27)
    expect(CATALOG.filter(d => d.required).map(d => d.id)).toEqual(['session.identity', 'session.links', 'session.client', 'usage'])
    const switchable = CATALOG.filter(d => !d.required)
    expect(switchable.filter(d => d.class === 'metadata').length).toBe(10)
    expect(switchable.filter(d => d.class === 'identifiers').length).toBe(5)
    expect(switchable.filter(d => d.class === 'content').length).toBe(8)
  })

  test('MCP server addresses add detail to MCP names, skill text to skill names, and pull request titles to the repository', () => {
    expect(CATALOG.find(d => d.id === 'mcp.url')?.needs).toBe('tool.mcp')
    expect(CATALOG.find(d => d.id === 'skill.text')?.needs).toBe('skill.name')
    expect(CATALOG.find(d => d.id === 'change.title')?.needs).toBe('repo')
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
  test('with nothing set, required and metadata data points are on; identifiers and content are off', () => {
    const g = resolveGate({})
    for (const d of CATALOG) expect([d.id, g.settings.get(d.id)]).toEqual([d.id, d.required ? 'required' : d.class === 'metadata' ? 'on' : 'off'])
    // So none of them goes anywhere, not even where Claude Code would send it.
    for (const id of ['repo', 'file.path', 'bash.command', 'tool.input', 'tool.result', 'prompt.text', 'response.text'] as const) expect([id, allows(g, id, true)]).toEqual([id, false])
  })

  test("Claude Code's switches turned on turn nothing on", () => {
    const g = resolveGate({ OTEL_LOG_TOOL_DETAILS: '1', OTEL_LOG_TOOL_CONTENT: '1', OTEL_LOG_USER_PROMPTS: '1', OTEL_LOG_ASSISTANT_RESPONSES: '1', OTEL_METRICS_INCLUDE_REPOSITORY: '1' })
    for (const d of CATALOG) expect([d.id, g.settings.get(d.id)]).toEqual([d.id, resolveGate({}).settings.get(d.id)])
  })

  test('a switch set to 0 turns the metadata it governs to follow Claude Code; what is off stays off', () => {
    const g = resolveGate(SWITCHED_OFF)
    for (const id of ['tool.mcp', 'skill.name', 'agent.type', 'web.domain'] as const) expect([id, g.settings.get(id)]).toEqual([id, 'claude'])
    for (const id of ['repo', 'file.path', 'bash.command', 'tool.input', 'tool.result', 'prompt.text', 'response.text'] as const) expect([id, g.settings.get(id)]).toEqual([id, 'off'])
    // Metadata no switch governs stays on.
    expect(g.settings.get('bash.class')).toBe('on')
    expect(g.settings.get('tool.call')).toBe('on')
    expect(resolveGate({ OTEL_LOG_TOOL_DETAILS: 'false' }).settings.get('skill.name')).toBe('claude')
    expect(resolveGate({ OTEL_LOG_TOOL_DETAILS: '' }).settings.get('skill.name')).toBe('on')
  })

  test('an explicit setting wins over the default and the switch; a required data point stays required', () => {
    const g = resolveGate({ OTEL_LOG_TOOL_DETAILS: '0' }, { 'bash.command': 'on', 'tool.call': 'off', 'response.thinking': 'on', usage: 'off' })
    expect(g.settings.get('bash.command')).toBe('on')
    expect(g.settings.get('tool.call')).toBe('off')
    expect(g.settings.get('response.thinking')).toBe('on')
    expect(g.settings.get('usage')).toBe('required')
  })
})

describe("what is in force for the organization (Mainwave's in_force)", () => {
  const ALL_ON = Object.fromEntries(CATALOG.filter(d => !d.required).map(d => [d.id, 'on'])) as Overrides
  const gate = (env: Parameters<typeof resolveGate>[0], explicit: Overrides, inForce: Overrides, optIn: DataPointId[] = []) => resolveGate(env, explicit, undefined, optIn, undefined, inForce)

  test("stands in for the plugin's defaults where it names a data point; one it doesn't name keeps the plugin's", () => {
    const g = gate({}, {}, { repo: 'on', 'prompt.text': 'on', 'tool.call': 'off' })
    expect(g.settings.get('repo')).toBe('on')
    expect(g.settings.get('prompt.text')).toBe('on')
    expect(g.settings.get('tool.call')).toBe('off')
    expect(g.settings.get('response.text')).toBe('off')
    expect(g.settings.get('skill.name')).toBe('on')
    expect(gate({}, {}, ALL_ON).settings.get('work.item')).toBe('on')
  })

  test('an explicit setting wins over it', () => {
    const g = gate({}, { repo: 'off', 'tool.call': 'claude' }, ALL_ON)
    expect(g.settings.get('repo')).toBe('off')
    expect(g.settings.get('tool.call')).toBe('claude')
  })

  test("a switch at 0 keeps what it governs that is on in force as Claude Code sends it; an explicit on wins over the switch", () => {
    const g = gate({ OTEL_METRICS_INCLUDE_REPOSITORY: '0', OTEL_LOG_TOOL_DETAILS: '0' }, { 'file.path': 'on' }, ALL_ON)
    expect(g.settings.get('repo')).toBe('claude')
    expect(g.settings.get('bash.command')).toBe('claude')
    expect(g.settings.get('file.path')).toBe('on')
    // Not governed by either: as in force.
    expect(g.settings.get('work.item')).toBe('on')
    expect(g.settings.get('tool.result')).toBe('on')
  })

  test("the opt-in raises a data point off in force only where the plugin's default is off too, so the stamp names only what it may", () => {
    const g = gate({}, {}, { 'prompt.text': 'off', 'tool.call': 'off' }, ['prompt.text', 'tool.call'])
    expect(g.settings.get('prompt.text')).toBe('on')
    expect(g.settings.get('tool.call')).toBe('off')
    expect(g.optedIn).toEqual(['prompt.text'])
    // On in force: nothing to raise, and nothing stamped.
    expect(gate({}, {}, ALL_ON, ['prompt.text']).optedIn).toEqual([])
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

  test('turns on identifiers and content, all off by default', () => {
    const g = resolveGate({}, {}, undefined, ['prompt.text', 'repo', 'tool.result'])
    expect(g.settings.get('repo')).toBe('on')
    expect(g.settings.get('tool.result')).toBe('on')
    expect(g.settings.get('prompt.text')).toBe('on')
    expect(g.settings.get('response.text')).toBe('off')
    expect(g.optedIn).toEqual(['repo', 'tool.result', 'prompt.text'])
  })

  test('only adds: a data point on by default stays as it is, and nothing listed or not turns anything off', () => {
    const everything = CATALOG.map(d => d.id)
    const g = resolveGate({}, {}, undefined, ['tool.call', 'skill.name'])
    const plain = resolveGate({})
    for (const d of CATALOG) expect([d.id, g.settings.get(d.id)]).toEqual([d.id, plain.settings.get(d.id)])
    expect(g.optedIn).toEqual([])
    const all = resolveGate({}, {}, undefined, everything)
    for (const d of CATALOG) expect([d.id, all.settings.get(d.id)]).toEqual([d.id, d.required ? 'required' : 'on'])
    expect(all.optedIn).toEqual(['repo', 'file.path', 'web.url', 'work.item', 'mcp.url', 'bash.command', 'change.title', 'tool.input', 'tool.result', 'skill.text', 'prompt.text', 'response.text', 'response.thinking'])
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

  test('a switch the session sets to 0 keeps the opt-in from what it governs', () => {
    const g = resolveGate({ OTEL_LOG_TOOL_DETAILS: '0' }, {}, undefined, ['bash.command', 'mcp.url', 'skill.text'])
    expect(g.settings.get('bash.command')).toBe('off')
    expect(g.optedIn).toEqual([])
    const asked = ['repo', 'tool.result', 'prompt.text', 'response.text'] as const
    const each = resolveGate({ OTEL_METRICS_INCLUDE_REPOSITORY: '0', OTEL_LOG_TOOL_CONTENT: 'no', OTEL_LOG_USER_PROMPTS: 'off' }, {}, undefined, asked)
    for (const id of asked) expect([id, each.settings.get(id)]).toEqual([id, 'off'])
    // Responses have a switch of their own, which wins over prompts'.
    expect(resolveGate({ OTEL_LOG_USER_PROMPTS: '0', OTEL_LOG_ASSISTANT_RESPONSES: '1' }, {}, undefined, asked).settings.get('response.text')).toBe('on')
    // What they add detail to follows Claude Code, so they go nowhere the plugin alone would send them.
    expect(allows(g, 'mcp.url', false)).toBe(false)
    expect(allows(g, 'skill.text', false)).toBe(false)
  })

  test('a data point opted in to still goes only where the one it adds detail to goes', () => {
    expect(allows(resolveGate({}, {}, undefined, ['mcp.url']), 'mcp.url', false)).toBe(true)
    expect(allows(resolveGate({}, { 'tool.mcp': 'off' }, undefined, ['mcp.url']), 'mcp.url', false)).toBe(false)
    expect(allows(resolveGate({}, { 'skill.name': 'off' }, undefined, ['skill.text']), 'skill.text', false)).toBe(false)
    // And tool input, which holds others, only where they all go: opted in to alone, nowhere, the others being off by default.
    expect(allows(resolveGate({}, {}, undefined, ['tool.input']), 'tool.input', false)).toBe(false)
    expect(resolveGate({}, {}, undefined, ['tool.input']).optedIn).toEqual([])
    const holds = ['tool.input', 'bash.command', 'file.path', 'web.url'] as const
    expect(allows(resolveGate({}, {}, undefined, holds), 'tool.input', false)).toBe(true)
    expect(allows(resolveGate({}, { 'web.url': 'off' }, undefined, holds), 'tool.input', false)).toBe(false)
  })

  const values: [string, unknown, string[]][] = [
    ['a list', ['response.thinking', 'mcp.url'], ['mcp.url', 'response.thinking']],
    ['a string, commas and spaces', ' skill.text, mcp.url  response.thinking ', ['mcp.url', 'skill.text', 'response.thinking']],
    ['twice', ['mcp.url', 'mcp.url'], ['mcp.url']],
    ['an unknown ID', ['mcp.url', 'mcp.urls', 'everything', '*'], ['mcp.url']],
    ['a required data point', ['usage', 'session.identity', 'skill.text'], ['skill.text']],
    ['one on by default, kept and harmless', ['tool.call'], ['tool.call']],
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
    const g = resolveGate({}, { ...CAPTURES_ON, 'bash.command': 'on', 'file.path': 'off', 'skill.name': 'claude' })
    expect([allows(g, 'bash.command', false), allows(g, 'bash.command', true)]).toEqual([true, true])
    expect([allows(g, 'file.path', false), allows(g, 'file.path', true)]).toEqual([false, false])
    expect([allows(g, 'skill.name', false), allows(g, 'skill.name', true)]).toEqual([false, true])
    expect(allows(g, 'session.identity', false)).toBe(true)
  })

  test('tool input goes only where the commands, file paths and web addresses it holds all go', () => {
    expect(allows(resolveGate({}, CAPTURES_ON), 'tool.input', false)).toBe(true)
    expect(allows(resolveGate({}, { ...CAPTURES_ON, 'web.url': 'off' }), 'tool.input', false)).toBe(false)
    expect(allows(resolveGate({}, { ...CAPTURES_ON, 'bash.command': 'claude' }), 'tool.input', false)).toBe(false)
    expect(allows(resolveGate({}, { ...CAPTURES_ON, 'bash.command': 'claude' }), 'tool.input', true)).toBe(true)
  })

  test('a data point that adds detail to another goes only where that one goes', () => {
    expect(allows(resolveGate({}, { ...CAPTURES_ON, 'mcp.url': 'on' }), 'mcp.url', false)).toBe(true)
    expect(allows(resolveGate({}, { ...CAPTURES_ON, 'mcp.url': 'on', 'tool.mcp': 'off' }), 'mcp.url', false)).toBe(false)
    expect(allows(resolveGate({ OTEL_LOG_TOOL_DETAILS: '0' }, { 'skill.text': 'on' }), 'skill.text', false)).toBe(false)
    expect(allows(resolveGate({}, { ...CAPTURES_ON, 'skill.text': 'on' }), 'skill.text', false)).toBe(true)
  })
})

describe('gateAttributes on a row', () => {
  const row = {
    'organization.id': 'o', 'vcs.repository.url.full': 'https://github.com/acme/api', 'event.name': 'tool_result', tool_name: 'Bash', tool_use_id: 'toolu_1',
    tool_parameters: '{"bash_command":"git","full_command":"git push","description":"Push","git_branch":"main"}', tool_input: '{"command":"git push"}',
  }

  test('with no settings the row keeps its metadata alone: no repository, command, description or input', () => {
    expect(gateAttributes(resolveGate({}), 'tool_result', row)).toEqual({ 'organization.id': 'o', 'event.name': 'tool_result', tool_name: 'Bash', tool_use_id: 'toolu_1' })
  })

  test('with everything on the row goes as Claude Code wrote it, byte for byte', () => {
    const out = gateAttributes(resolveGate({}, CAPTURES_ON), 'tool_result', row)
    expect(out).toEqual(row)
    expect(out['tool_parameters']).toBe(row.tool_parameters)
  })

  test("a data point that is off leaves the row, and Claude Code's tool_parameters keeps the keys of the rest, in order", () => {
    const out = gateAttributes(resolveGate({}, { ...CAPTURES_ON, repo: 'off' }), 'tool_result', row)
    expect(out['vcs.repository.url.full']).toBeUndefined()
    expect(out['tool_parameters']).toBe('{"bash_command":"git","full_command":"git push","description":"Push"}')
    expect(Object.keys(out)).toEqual(['organization.id', 'event.name', 'tool_name', 'tool_use_id', 'tool_parameters', 'tool_input'])
    // Tool input holds the command, and the description is tool input: with commands off, none of it is left.
    const none = gateAttributes(resolveGate({}, { ...CAPTURES_ON, 'bash.command': 'off' }), 'tool_result', row)
    expect(none['tool_parameters']).toBe('{"git_branch":"main"}')
    expect(none['tool_input']).toBeUndefined()
  })

  test('withheld text reads <REDACTED>, as Claude Code writes it', () => {
    const out = gateAttributes(resolveGate({}, { ...CAPTURES_ON, 'prompt.text': 'off' }), 'user_prompt', { prompt: 'secret plan', prompt_text: 'secret plan', prompt_length: '11' })
    expect(out).toEqual({ prompt: '<REDACTED>', prompt_text: '<REDACTED>', prompt_length: '11' })
  })

  test("what the plugin read fills what Claude Code withheld, where its data point is on; under claude it does not", () => {
    const withheld = { tool_name: 'mcp_tool', tool_use_id: 'toolu_1', success: 'true' }
    const fill = { parameters: { bash_command: 'git', full_command: 'git push', mcp_server_name: 'remote-devices', mcp_tool_name: 'device_bash' }, attributes: { tool_input: '{"command":"git push"}' } }
    const on = gateAttributes(resolveGate({}, CAPTURES_ON), 'tool_result', withheld, fill)
    expect(on['tool_parameters']).toBe('{"bash_command":"git","full_command":"git push","mcp_server_name":"remote-devices","mcp_tool_name":"device_bash"}')
    expect(on['tool_input']).toBe('{"command":"git push"}')
    const asClaude = gateAttributes(resolveGate(SWITCHED_OFF), 'tool_result', withheld, fill)
    expect(asClaude).toEqual(withheld)
    const filled = gateAttributes(resolveGate({}, CAPTURES_ON), 'user_prompt', { prompt: '<REDACTED>', prompt_length: '2' }, { attributes: { prompt: 'go' } })
    expect(filled['prompt']).toBe('go')
  })

  test("with MCP names off, an MCP tool's name reads mcp_tool", () => {
    const span = { tool_name: 'mcp__remote-devices__device_bash', 'gen_ai.tool.name': 'device_bash', 'anthropic.mcp.server.name': 'remote-devices' }
    expect(gateAttributes(resolveGate({}, { ...CAPTURES_ON, 'tool.mcp': 'off' }), 'claude_code.tool', span)).toEqual({ tool_name: 'mcp_tool', 'gen_ai.tool.name': 'mcp_tool' })
    const playwright = { tool_name: 'mcp__playwright__browser_click', tool_name_safe: 'mcp__playwright__browser_click' }
    expect(gateAttributes(resolveGate({}, { ...CAPTURES_ON, 'tool.mcp': 'off' }), 'claude_code.tool', playwright)).toEqual({ tool_name: 'mcp_tool', tool_name_safe: 'mcp_other' })
    expect(gateAttributes(resolveGate({}, { ...CAPTURES_ON, 'tool.mcp': 'off' }), 'claude_code.tool', { tool_name: 'Bash', 'gen_ai.tool.name': 'Bash' })).toEqual({ tool_name: 'Bash', 'gen_ai.tool.name': 'Bash' })
  })

  test('a secret is replaced in identifiers and content, whatever the gate, and the record counts it; elsewhere it is left alone', () => {
    const out = gateAttributes(resolveGate({}, CAPTURES_ON), 'claude_code.tool', { full_command: 'curl -H "Authorization: Bearer abc123" https://example.com', model: 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(out['full_command']).toBe('curl -H "Authorization: Bearer [REDACTED:authorization]" https://example.com')
    expect(out['model']).toBe('sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(out['mainwave.redaction.count']).toBe(1)
    // Once more through the gate, as it is sent: nothing more to replace, and the count stands.
    expect(gateAttributes(resolveGate({}, CAPTURES_ON), 'claude_code.tool', out)).toEqual(out)
  })

  test('a value past the limit is cut, with Claude Code\'s marker and the original length beside it', () => {
    const g = resolveGate({}, CAPTURES_ON, 2048)
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
    const g = resolveGate({}, { ...CAPTURES_ON, 'prompt.text': 'claude' })
    expect(gateRow(g, row)!.attributes['prompt']).toBe('hello')
    expect(gateRow(g, row, true)!.attributes).toEqual({ prompt: '<REDACTED>', prompt_length: '5', 'vcs.repository.name': 'api' })
  })
})

describe("the plugin's own rows", () => {
  const server = { event: 'mcp_server_configured', loggedAt: '2026-11-12T00:00:00.000Z', attributes: { 'organization.id': 'o', server_name: 'linear', server_scope: 'user', transport_type: 'http', server_url: 'https://mcp.example.com/mcp' } }
  const skill = (attributes: Record<string, string | boolean>) => ({ event: 'skill_prompt', loggedAt: '2026-11-12T00:00:00.000Z', attributes: { 'organization.id': 'o', 'skill.name': 'review', 'skill.text_id': 'abc', ...attributes } })

  test('go only while their data point is on: none is sent by default, Claude Code exporting neither', () => {
    expect(gateRow(resolveGate({}, CAPTURES_ON), server)).toBeNull()
    expect(gateRow(resolveGate({}, { ...CAPTURES_ON, 'mcp.url': 'on' }), server)?.attributes['server_url']).toBe('https://mcp.example.com/mcp')
    expect(gateRow(resolveGate({}, { ...CAPTURES_ON, 'mcp.url': 'on', 'tool.mcp': 'off' }), server)).toBeNull()
    expect(gateRow(resolveGate({}, { ...CAPTURES_ON, 'mcp.url': 'claude' }), server)).toBeNull()
    expect(gateRow(resolveGate({}, CAPTURES_ON), skill({ 'skill.text': 'Review it.' }))).toBeNull()
  })

  test("a skill's text with arguments filled in goes only where prompts do; held back, the row says so", () => {
    const g = resolveGate({}, { ...CAPTURES_ON, 'skill.text': 'on', 'prompt.text': 'off' })
    expect(gateRow(g, skill({ 'skill.text': 'Review it.', 'skill.has_arguments': false }))?.attributes['skill.text']).toBe('Review it.')
    const held = gateRow(g, skill({ 'skill.text': 'Review PR 12.', 'skill.has_arguments': true }))!.attributes
    expect(held['skill.text']).toBeUndefined()
    expect(held['skill.text_held_back']).toBe(true)
    expect(gateRow(resolveGate({}, { ...CAPTURES_ON, 'skill.text': 'on' }), skill({ 'skill.text': 'Review PR 12.', 'skill.has_arguments': true }))?.attributes['skill.text']).toBe('Review PR 12.')
  })

  test('their addresses and text go through the protections', () => {
    const g = resolveGate({}, { ...CAPTURES_ON, 'mcp.url': 'on', 'skill.text': 'on' })
    const local = { ...server, attributes: { ...server.attributes, transport_type: 'stdio', server_url: `npx server --token=${'s'.repeat(24)}` } }
    expect(gateRow(g, local)?.attributes['server_url']).toBe('npx server --token=[REDACTED:assigned_secret]')
    expect(gateRow(g, skill({ 'skill.text': `Use ghp_${'a'.repeat(36)}.` }))?.attributes['skill.text']).toBe('Use [REDACTED:github_token].')
  })

  test("Claude Code's MCP connection row: its server's name and scope are MCP names, and its error the server's address", () => {
    expect(ownerOf('mcp_server_connection', 'server_name')?.id).toBe('tool.mcp')
    expect(ownerOf('mcp_server_connection', 'error')?.id).toBe('mcp.url')
    const failed = { server_name: 'acme', server_scope: 'user', error: 'connect ECONNREFUSED https://mcp.acme.example.com/mcp' }
    expect(gateAttributes(resolveGate({}), 'mcp_server_connection', failed)).toEqual({ server_name: 'acme', server_scope: 'user' })
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
    const out = gateSpan(resolveGate({}, { ...CAPTURES_ON, 'tool.result': 'off' }), span)
    expect(out.attributes['error']).toBe('ShellError')
    expect(out.status).toEqual({ code: 2, message: 'ShellError' })
    expect(gateSpan(resolveGate({}, CAPTURES_ON), span)).toEqual(span)
    // It can repeat the command or the path the call was given: with tool input off, the class alone too.
    expect(gateSpan(resolveGate({}, { ...CAPTURES_ON, 'file.path': 'off' }), span).attributes['error']).toBe('ShellError')
  })

  test("a tool's output event goes only with tool results on, and its path and command only with theirs", () => {
    const event = { name: 'tool.output', timeMs: 1, attributes: { bash_command: 'echo hi', output: 'hi' } }
    expect(gateEvent(resolveGate({}, { ...CAPTURES_ON, 'tool.result': 'off' }), event)).toBeNull()
    expect(gateEvent(resolveGate({}, { ...CAPTURES_ON, 'bash.command': 'off' }), event)?.event.attributes).toEqual({ output: 'hi' })
    expect(gateEvent(resolveGate({}, CAPTURES_ON), { ...event, attributes: { output: 'token=abc' } })).toEqual({ event: { ...event, attributes: { output: 'token=[REDACTED:assigned_secret]' } }, count: 1 })
  })

  test('commit and pull request counts go only with command outcomes on; a metric loses the attributes of a data point off', () => {
    const point = { name: 'claude_code.commit.count', startMs: 0, timeMs: 1, value: 1, attributes: { 'vcs.repository.name': 'api' } }
    expect(gatePoint(resolveGate({}, { ...CAPTURES_ON, 'bash.outcome': 'off' }), point)).toBeNull()
    expect(gatePoint(resolveGate({}, { ...CAPTURES_ON, repo: 'off' }), point)?.attributes).toEqual({})
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

  test('the counts go with the defaults; the refs only where the repository goes too, which is off by default', () => {
    expect(stamps(gateAttributes(resolveGate({}), 'claude_code.tool', stamped))).toEqual(['mainwave.command.counted', 'mainwave.command.commits', 'mainwave.command.pushes', 'mainwave.command.branches_opened'])
    expect(gateAttributes(resolveGate({}, { repo: 'on' }), 'claude_code.tool', stamped)).toEqual(stamped)
  })

  test('none goes with command outcomes off, the refs included, though the repository is on', () => {
    expect(stamps(gateAttributes(resolveGate({}, { 'bash.outcome': 'off', repo: 'on' }), 'claude_code.tool', stamped))).toEqual([])
  })

  test('none goes as Claude Code sends it: Claude Code sends none of them', () => {
    expect(stamps(gateAttributes(resolveGate({}, { 'bash.outcome': 'claude', repo: 'claude' }), 'claude_code.tool', stamped))).toEqual([])
    expect(stamps(gateAttributes(resolveGate({}, { repo: 'claude' }), 'claude_code.tool', stamped))).toEqual(['mainwave.command.counted', 'mainwave.command.commits', 'mainwave.command.pushes', 'mainwave.command.branches_opened'])
  })

  test('a ref goes through the protections, and one the limit would cut is left off, not cut', () => {
    const secret = `ghp_${'a'.repeat(36)}`
    const out = gateAttributes(resolveGate({}, { repo: 'on' }), 'claude_code.tool', { ...stamped, 'mainwave.command.push_ref': secret })
    expect(out['mainwave.command.push_ref']).toBe('[REDACTED:github_token]')
    expect(out['mainwave.redaction.count']).toBe(1)
    const short = gateAttributes(resolveGate({}, { repo: 'on' }, 4), 'claude_code.tool', stamped)
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
    const g = resolveGate({}, CAPTURES_ON)
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

describe('redaction packs', () => {
  const ALL = resolveRedaction(['pii.contact', 'pii.us_gov_id', 'pii.payment_card'], undefined)
  // With identifiers and content on, as an organization's settings turn them on: with no settings they don't go at all.
  const withPacks = (redaction = ALL) => resolveGate({}, CAPTURES_ON, CONTENT_MAX_LENGTH, [], redaction)
  const HELD = resolveRedaction('unreadable', undefined)

  test('packsOf: a list or one string of names, as written; unset says nothing; any other value is unreadable', () => {
    expect(packsOf(['pii.contact', ' pii.us_gov_id '])).toEqual(['pii.contact', 'pii.us_gov_id'])
    expect(packsOf('pii.contact, pii.payment_card  secrets')).toEqual(['pii.contact', 'pii.payment_card', 'secrets'])
    expect(packsOf('')).toEqual([])
    expect(packsOf([])).toEqual([])
    expect(packsOf(undefined)).toBeUndefined()
    expect(packsOf(null)).toBeUndefined()
    for (const v of [7, true, { 'pii.contact': true }, ['pii.contact', 7]]) expect([v, packsOf(v)]).toEqual([v, 'unreadable'])
  })

  test('combinePacks: every name any source lists; one unreadable source makes it unreadable; none, nothing said', () => {
    expect(combinePacks([undefined, ['pii.contact'], ['pii.us_gov_id']])).toEqual(['pii.contact', 'pii.us_gov_id'])
    expect(combinePacks([undefined, undefined])).toBeUndefined()
    expect(combinePacks([['pii.contact'], 'unreadable'])).toBe('unreadable')
  })

  test('with no choice, secrets alone; the default is one constant', () => {
    expect(resolveRedaction(undefined, undefined)).toEqual({ packs: ['secrets'] })
    expect(resolveGate({}).redaction).toEqual({ packs: ['secrets'] })
  })

  test("the organization's packs in the order they run, secrets always; the person's add to them and never take one away", () => {
    expect(resolveRedaction(['pii.payment_card', 'pii.contact'], undefined)).toEqual({ packs: ['secrets', 'pii.contact', 'pii.payment_card'] })
    expect(resolveRedaction([], undefined)).toEqual({ packs: ['secrets'] })
    expect(resolveRedaction(['pii.contact'], [])).toEqual({ packs: ['secrets', 'pii.contact'] })
    expect(resolveRedaction(['pii.contact'], ['pii.us_gov_id'])).toEqual({ packs: ['secrets', 'pii.contact', 'pii.us_gov_id'] })
    expect(resolveRedaction(undefined, ['pii.payment_card'])).toEqual({ packs: ['secrets', 'pii.payment_card'] })
  })

  test("held when either can't be read or names a pack the plugin does not have", () => {
    expect(resolveRedaction('unreadable', undefined)).toEqual({ held: 'unreadable' })
    expect(resolveRedaction(['pii.contact'], 'unreadable')).toEqual({ held: 'unreadable' })
    expect(resolveRedaction(['pii.passport'], undefined)).toEqual({ held: 'unknown pack' })
    expect(resolveRedaction(undefined, ['pii.contacts'])).toEqual({ held: 'unknown pack' })
  })

  test('the packs in force run on every identifier and content value, after the secrets, and the record counts every match', () => {
    const out = gateAttributes(withPacks(), 'tool_result', {
      'organization.id': 'o', 'user.email': 'ana@example.com', tool_name: 'Bash',
      tool_parameters: '{"full_command":"mail -s hi bob@example.com --token=abc"}',
      tool_input: '{"command":"echo 078-05-1120"}', error: 'card 4111 1111 1111 1111 declined',
    })
    expect(out).toEqual({
      'organization.id': 'o', 'user.email': 'ana@example.com', tool_name: 'Bash',
      tool_parameters: '{"full_command":"mail -s hi [REDACTED:pii.contact.email] --token=[REDACTED:assigned_secret]"}',
      tool_input: '{"command":"echo [REDACTED:pii.us_gov_id.ssn]"}', error: 'card [REDACTED:pii.payment_card.card_number] declined',
      'mainwave.redaction.count': 4,
    })
    // Once more through the gate, as it is sent: nothing more to replace, and the count stands.
    expect(gateAttributes(withPacks(), 'tool_result', out)).toEqual(out)
  })

  test('by default an email in content goes as it is: secrets alone', () => {
    expect(gateAttributes(resolveGate({}, CAPTURES_ON), 'user_prompt', { prompt: 'mail bob@example.com' })).toEqual({ prompt: 'mail bob@example.com' })
  })

  test('the routing and identity keys are never scanned, a repository and a commit included; metadata is not content', () => {
    const attrs = {
      'organization.id': 'o', 'user.email': 'ana@example.com', 'user.account_uuid': 'u', 'session.id': 's', 'prompt.id': 'p',
      'vcs.repository.url.full': 'git@github.com:acme/api.git', 'vcs.commit.sha': '4111111111111111', model: 'claude-opus-5-5',
    }
    expect(gateAttributes(withPacks(), 'api_request', attrs)).toEqual(attrs)
    expect(gateAttributes(withPacks(HELD), 'api_request', attrs)).toEqual(attrs)
    // A key of the same data point that no other path exempts is scanned.
    expect(gateAttributes(withPacks(), 'api_request', { 'vcs.repository.name': 'bob@example.com' })['vcs.repository.name']).toBe('[REDACTED:pii.contact.email]')
  })

  test('each string of a list is scanned; a list holding anything else is left out', () => {
    const g = withPacks()
    expect(gateAttributes(g, 'cowork', { 'workspace.host_paths': ['/Users/ana/bob@example.com', '/tmp'] })).toEqual({ 'workspace.host_paths': ['/Users/ana/[REDACTED:pii.contact.email]', '/tmp'], 'mainwave.redaction.count': 1 })
    expect(gateAttributes(resolveGate({}, CAPTURES_ON), 'cowork', { 'workspace.host_paths': [`/x/ghp_${'a'.repeat(36)}`] })['workspace.host_paths']).toEqual(['/x/[REDACTED:github_token]'])
    expect(gateAttributes(g, 'cowork', { 'workspace.host_paths': ['/a', 7 as never] })).toEqual({})
  })

  test('held: every identifier and content value is left out, and the record goes with the rest', () => {
    const g = withPacks(HELD)
    const out = gateAttributes(g, 'user_prompt', { 'organization.id': 'o', 'user.email': 'ana@example.com', prompt: 'hello', prompt_length: '5', 'workspace.host_paths': ['/a'] })
    expect(out).toEqual({ 'organization.id': 'o', 'user.email': 'ana@example.com', prompt_length: '5' })
    expect(gateRow(g, { event: 'user_prompt', loggedAt: '2026-11-12T00:00:00.000Z', attributes: { prompt: 'hello', prompt_length: '5' } })).toEqual({ event: 'user_prompt', loggedAt: '2026-11-12T00:00:00.000Z', attributes: { prompt_length: '5' } })
  })

  test("a span's status message and its tool output go through the packs, and the span counts them; held, both are left out", () => {
    const span: BuiltSpan = {
      traceId: 't', spanId: 's', name: 'claude_code.tool.execution', startMs: 0, endMs: 1,
      attributes: { success: false, error: 'no user bob@example.com', error_class: 'ShellError' },
      status: { code: 2, message: 'no user bob@example.com' },
      events: [{ name: 'tool.output', timeMs: 1, attributes: { output: 'call (415) 555-2671', output_truncated: false } }],
    }
    const out = gateSpan(withPacks(), span)
    expect(out.attributes['error']).toBe('no user [REDACTED:pii.contact.email]')
    expect(out.status).toEqual({ code: 2, message: 'no user [REDACTED:pii.contact.email]' })
    expect(out.events).toEqual([{ name: 'tool.output', timeMs: 1, attributes: { output: 'call [REDACTED:pii.contact.phone_nanp]', output_truncated: false } }])
    expect(out.attributes['mainwave.redaction.count']).toBe(3)
    const held = gateSpan(withPacks(HELD), span)
    expect(held.attributes).toEqual({ success: false, error_class: 'ShellError' })
    expect(held.status).toEqual({ code: 2 })
    expect(held.events).toEqual([{ name: 'tool.output', timeMs: 1, attributes: { output_truncated: false } }])
  })
})

describe('a marker through the gate', () => {
  const commit = {
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'vcs.commit.created', startMs: 0, endMs: 0,
    attributes: { 'vcs.commit.sha': 'c'.repeat(40), 'vcs.commit.lines_added': 3, 'vcs.commit.file.paths': ['src/secret-plan.ts'], 'vcs.commit.file.lines_added': [3] as unknown as string[] },
  }
  const pr = {
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'vcs.change.opened', startMs: 0, endMs: 0,
    attributes: { 'vcs.repository.url.full': 'https://github.com/acme/api/pull/1', 'vcs.change.id': '1', 'vcs.change.title': 'Secret title' },
  }

  test('goes only while the data point of its key is on: not where it is as Claude Code sends it', () => {
    expect(gateMarker(resolveGate({}), commit)).toBeNull()
    expect(gateMarker(resolveGate({}, { repo: 'claude' }), commit)).toBeNull()
    expect(gateMarker(resolveGate({}, { repo: 'on' }), commit)!.attributes['vcs.commit.sha']).toBe('c'.repeat(40))
  })

  test('as Claude Code sends it sends none of its values: Claude Code sends no marker', () => {
    const g = resolveGate({}, { repo: 'on', 'file.path': 'claude', 'change.title': 'claude' })
    const c = gateMarker(g, commit)!
    expect(c.attributes['vcs.commit.file.paths']).toBeUndefined()
    expect(c.attributes['vcs.commit.lines_added']).toBe(3)
    expect(gateMarker(g, pr)!.attributes['vcs.change.title']).toBeUndefined()
    expect(gateMarker(resolveGate({}, { repo: 'on', 'file.path': 'on' }), commit)!.attributes['vcs.commit.file.paths']).toEqual(['src/secret-plan.ts'])
  })

  test('with the redaction held, its paths are held back and the marker still goes on its key', () => {
    const g = { ...resolveGate({}, { repo: 'on', 'file.path': 'on' }), redaction: { held: 'unreadable' as const } }
    const c = gateMarker(g, commit)!
    expect(c.attributes['vcs.commit.sha']).toBe('c'.repeat(40))
    expect(c.attributes['vcs.commit.file.paths']).toBeUndefined()
  })
})
