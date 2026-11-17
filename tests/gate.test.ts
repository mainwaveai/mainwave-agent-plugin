// The data-point gate, the catalog it reads and the always-on protections, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { CATALOG, DEFAULTS, ownerOf } from '../hooks/catalog.ts'
import { allows, gateAttributes, gateEvent, gatePoint, gateRow, gateSpan, resolveGate } from '../hooks/gate.ts'
import type { BuiltSpan } from '../hooks/otlp.ts'
import { contentLimit, CONTENT_MAX_LENGTH, cut, redact } from '../hooks/protect.ts'

const SWITCHED_OFF = { OTEL_LOG_TOOL_DETAILS: '0', OTEL_LOG_TOOL_CONTENT: '0', OTEL_LOG_USER_PROMPTS: '0', OTEL_METRICS_INCLUDE_REPOSITORY: '0' }

describe('the catalog', () => {
  test('twenty-two data points: four required, nine metadata, three identifiers and six content, each ID once', () => {
    expect(CATALOG.length).toBe(22)
    expect(new Set(CATALOG.map(d => d.id)).size).toBe(22)
    expect(CATALOG.filter(d => d.required).map(d => d.id)).toEqual(['session.identity', 'session.links', 'session.client', 'usage'])
    const switchable = CATALOG.filter(d => !d.required)
    expect(switchable.filter(d => d.class === 'metadata').length).toBe(9)
    expect(switchable.filter(d => d.class === 'identifiers').length).toBe(3)
    expect(switchable.filter(d => d.class === 'content').length).toBe(6)
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
    expect(g.settings.get('response.thinking')).toBe('off')
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
    expect(gateRow(g, row).attributes['prompt']).toBe('hello')
    expect(gateRow(g, row, true).attributes).toEqual({ prompt: '<REDACTED>', prompt_length: '5', 'vcs.repository.name': 'api' })
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
