// The rebuild of Claude Code's spans and measures, driven directly: rows and engine events in, finished spans and measures out.
// The shapes asserted here are the ones Claude Code 2.1.322's exporter sends (tests/e2e/compare.mjs checks them against it).

import { describe, expect, test } from 'claude-code/testing'

import type { BuiltSpan } from '../hooks/otlp.ts'
import {
  agentSpawned, commonOf, newRebuild, observeRow, parseTraceparent, sessionStarted, stepEnd, stepStart, sweep, toolEnd, toolStart, turnComplete, turnStart,
  type Emit, type Rebuild, type RowIn, type Settings,
} from '../hooks/rebuild.ts'
import { ORG } from './rig.ts'

const TRACE = '7d2fa3029813d71c9ad4ef05815fa7d5'
const INTERACTION = 'e4a76fb0fca33a96'
const BLOCKED = '1111111111111111'
const AGENT_EXEC = '2222222222222222'
const COMMON = { 'mainwave.source': 'coding_agent.claude_code', 'organization.id': ORG, 'user.id': 'device-1', 'session.id': 's-1', 'anthropic.provider': 'firstParty', 'terminal.type': 'cli' }

/** A rebuild whose new ids count up, so tests can name them. */
function rebuild(settings: Partial<Settings> = {}): Rebuild {
  let n = 0
  return newRebuild({ toolDetails: true, ...settings }, len => (++n).toString(16).padStart(len, 'a'))
}

const row = (event: string, atMs: number, attributes: Record<string, unknown>, spanId?: string): RowIn => ({
  event, atMs, ...(spanId ? { span: { traceId: TRACE, spanId } } : {}),
  attributes: { ...COMMON, 'event.name': event, 'event.timestamp': '2026-11-13T00:00:00.000Z', 'event.sequence': 1, ...attributes } as RowIn['attributes'],
})
const usage = (input: number) => ({ input_tokens: input, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 })
const request = (atMs: number, input: number, extra: Record<string, unknown> = {}, spanId = INTERACTION) => row('api_request', atMs, {
  model: 'claude-haiku-5-5', input_tokens: input, output_tokens: 20, cache_read_tokens: 100, cache_creation_tokens: 10, cost_usd: 0.0001, duration_ms: 30,
  ttft_ms: 6, request_id: `req_${input}`, speed: 'normal', query_source: 'sdk', effort: 'medium', ...extra,
}, spanId)

const all = (...emits: Emit[]) => emits.reduce((a, b) => ({ spans: [...a.spans, ...b.spans], measures: [...a.measures, ...b.measures] }), { spans: [], measures: [] } as Emit)
const named = (spans: BuiltSpan[], name: string) => spans.filter(s => s.name === `claude_code.${name}`)
const keysAfterCommon = (s: BuiltSpan) => Object.keys(s.attributes).slice(Object.keys(COMMON).length)

describe('commonOf', () => {
  test("the attributes before event.name, in order; a row without one names none", () => {
    expect(commonOf({ a: 1, b: 'x', 'event.name': 'e', c: 2 })).toEqual({ a: 1, b: 'x' })
    expect(Object.keys(commonOf({ z: 1, a: 2, 'event.name': 'e' }))).toEqual(['z', 'a'])
    expect(commonOf({ a: 1 })).toEqual({})
  })
  test('keys the plugin owns never ride along', () => {
    const r = rebuild()
    observeRow(r, row('user_prompt', 1, {}))
    observeRow(r, { ...row('user_prompt', 1, {}), attributes: { 'mainwave.telemetry.route': 'exporter', ...COMMON, 'event.name': 'user_prompt' } })
    expect(r.common).toEqual(COMMON)
  })
})

describe('one turn', () => {
  /** A main-loop turn with one Bash call, as Claude Code raises its events and rows. */
  function turn(r: Rebuild) {
    const out: Emit[] = []
    turnStart(r, { turnId: 't1', text: 'run it' })
    out.push(observeRow(r, row('user_prompt', 100, { prompt: 'run it', prompt_length: '6' }, INTERACTION)))
    stepStart(r, undefined, 'claude-haiku-5-5')
    toolStart(r, { tool: 'Bash', tool_use_id: 'toolu_1', command: 'echo e2e', description: 'x' }, 130)
    out.push(observeRow(r, row('tool_decision', 135, { decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_1' }, BLOCKED)))
    out.push(stepEnd(r, undefined, 110, { stopReason: 'tool_use', usage: usage(1201) }, 140))
    out.push(observeRow(r, request(141, 1201)))
    out.push(observeRow(r, row('tool_result', 180, { tool_name: 'Bash', tool_use_id: 'toolu_1', success: 'true' }, INTERACTION)))
    out.push(toolEnd(r, 'toolu_1', { result: { stdout: 'e2e' } }, 181))
    stepStart(r, undefined, 'claude-haiku-5-5')
    out.push(observeRow(r, request(220, 1202)))
    out.push(stepEnd(r, undefined, 190, { stopReason: 'end_turn', usage: usage(1202) }, 221))
    out.push(turnComplete(r, { turnId: 't1', durationMs: 150 }, 230))
    return all(...out)
  }

  test('the interaction takes its ids from the prompt row and its time from the turn', () => {
    const { spans } = turn(rebuild())
    const [i] = named(spans, 'interaction')
    expect(i).toEqual(expect.objectContaining({ traceId: TRACE, spanId: INTERACTION, startMs: 80, endMs: 230 }))
    expect(i!.parentSpanId).toBeUndefined()
    expect(i!.attributes).toEqual({
      ...COMMON, 'gen_ai.provider.name': 'anthropic', 'span.type': 'interaction', 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': 's-1',
      user_prompt: 'run it', user_prompt_length: 6, 'interaction.sequence': 1, 'parent.source': 'none', queued_sends: 0, 'interaction.duration_ms': 150,
    })
    expect(keysAfterCommon(i!)).toEqual(['gen_ai.provider.name', 'span.type', 'gen_ai.operation.name', 'gen_ai.conversation.id', 'user_prompt', 'user_prompt_length', 'interaction.sequence', 'parent.source', 'queued_sends', 'interaction.duration_ms'])
  })

  test('each request is its row, paired with its step for the start and the stop reason, whichever comes first', () => {
    const { spans } = turn(rebuild())
    const reqs = named(spans, 'llm_request')
    expect(reqs.map(s => [s.attributes['request_id'], s.attributes['stop_reason'], s.startMs, s.endMs])).toEqual([['req_1201', 'tool_use', 110, 141], ['req_1202', 'end_turn', 190, 220]])
    const [a] = reqs
    expect(a!.traceId).toBe(TRACE)
    expect(a!.parentSpanId).toBe(INTERACTION)
    expect(keysAfterCommon(a!)).toEqual([
      'gen_ai.provider.name', 'span.type', 'model', 'gen_ai.system', 'gen_ai.request.model', 'llm_request.context', 'speed', 'gen_ai.conversation.id', 'query_source_safe',
      'duration_ms', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'success', 'attempt', 'request_id', 'gen_ai.response.id', 'ttft_ms',
      'first_content_ms', 'effort', 'stop_reason', 'gen_ai.response.finish_reasons',
    ])
    expect(a!.attributes).toEqual(expect.objectContaining({
      'llm_request.context': 'interaction', query_source_safe: 'sdk', input_tokens: 1201, success: true, attempt: 1, duration_ms: 31, 'gen_ai.response.finish_reasons': ['tool_use'],
    }))
    expect(a!.events).toEqual([{ name: 'gen_ai.request.attempt', timeMs: 110, attributes: { attempt: 1 } }])
  })

  test('a tool call is three spans: the call under its row\'s span, the decision with its own ids, and the run', () => {
    const { spans } = turn(rebuild())
    const [tool] = named(spans, 'tool')
    const [blocked] = named(spans, 'tool.blocked_on_user')
    const [exec] = named(spans, 'tool.execution')
    expect(tool).toEqual(expect.objectContaining({ traceId: TRACE, parentSpanId: INTERACTION, startMs: 130, endMs: 181 }))
    expect(keysAfterCommon(tool!)).toEqual([
      'gen_ai.provider.name', 'span.type', 'tool_name', 'tool_name_safe', 'gen_ai.operation.name', 'gen_ai.tool.name', 'gen_ai.conversation.id', 'full_command',
      'bash_command_class', 'bash_argv0', 'tool_use_id', 'gen_ai.tool.call.id', 'duration_ms',
    ])
    expect(tool!.attributes).toEqual(expect.objectContaining({ full_command: 'echo e2e', bash_command_class: 'shell_builtin', bash_argv0: 'echo', duration_ms: 51 }))
    expect(blocked).toEqual(expect.objectContaining({ traceId: TRACE, spanId: BLOCKED, parentSpanId: tool!.spanId, startMs: 130, endMs: 135 }))
    expect(blocked!.attributes).toEqual({ ...COMMON, 'gen_ai.provider.name': 'anthropic', 'span.type': 'tool.blocked_on_user', 'gen_ai.conversation.id': 's-1', duration_ms: 5, decision: 'accept', source: 'config' })
    expect(exec).toEqual(expect.objectContaining({ traceId: TRACE, parentSpanId: tool!.spanId, startMs: 135, endMs: 181 }))
    expect(exec!.attributes).toEqual({ ...COMMON, 'gen_ai.provider.name': 'anthropic', 'span.type': 'tool.execution', 'gen_ai.conversation.id': 's-1', tool_use_id: 'toolu_1', 'gen_ai.tool.call.id': 'toolu_1', duration_ms: 46, success: true })
    expect(exec!.status).toBeUndefined()
  })

  test('the measures: cost and tokens per request, and the turn as active time', () => {
    const { measures } = turn(rebuild())
    const base = { ...COMMON, model: 'claude-haiku-5-5', query_source: 'main', effort: 'medium' }
    expect(measures.filter(m => m.name === 'claude_code.cost.usage').map(m => [m.value, m.attributes, m.atMs])).toEqual([[0.0001, base, 141], [0.0001, base, 220]])
    expect(measures.filter(m => m.name === 'claude_code.token.usage').slice(0, 4).map(m => [m.attributes['type'], m.value])).toEqual([['input', 1201], ['output', 20], ['cacheRead', 100], ['cacheCreation', 10]])
    expect(measures.filter(m => m.name === 'claude_code.active_time.total')).toEqual([{ name: 'claude_code.active_time.total', value: 0.15, attributes: { ...COMMON, type: 'cli' }, atMs: 230 }])
  })

  test('without OTEL_LOG_TOOL_DETAILS a tool span carries no command, but still its class', () => {
    const { spans } = turn(rebuild({ toolDetails: false }))
    const [tool] = named(spans, 'tool')
    expect(tool!.attributes['full_command']).toBeUndefined()
    expect(tool!.attributes['bash_argv0']).toBe('echo')
  })

  test('interactions count up, and the prompt row may come before its turn', () => {
    const r = rebuild()
    turn(r)
    observeRow(r, row('user_prompt', 300, { prompt: 'next', prompt_length: '4' }, 'f00df00df00df00d'))
    turnStart(r, { turnId: 't2', text: 'next' })
    const { spans } = turnComplete(r, { turnId: 't2', durationMs: 10 }, 320)
    expect(spans[0]).toEqual(expect.objectContaining({ spanId: 'f00df00df00df00d' }))
    expect(spans[0]!.attributes['interaction.sequence']).toBe(2)
  })

  test("a prompt row that started no turn is not taken by the next turn", () => {
    const r = rebuild()
    observeRow(r, row('user_prompt', 10, { prompt: 'blocked by a hook', prompt_length: '17' }, 'f00df00df00df00d'))
    turnStart(r, { turnId: 't9', text: 'go' })
    observeRow(r, row('user_prompt', 20, { prompt: 'go', prompt_length: '2' }, INTERACTION))
    const { spans } = turnComplete(r, { turnId: 't9', durationMs: 5 }, 30)
    expect(spans[0]!.spanId).toBe(INTERACTION)
    expect(spans[0]!.attributes['user_prompt']).toBe('go')
  })

  test("a prompt row whose text the turn's does not match is still the turn's when its requests name the same span", () => {
    const r = rebuild()
    turnStart(r, { turnId: 't8', text: 'see [Pasted text #1]' })
    observeRow(r, row('user_prompt', 10, { prompt: 'see a long pasted text', prompt_length: '22' }, INTERACTION))
    observeRow(r, request(20, 1201))
    const { spans } = turnComplete(r, { turnId: 't8', durationMs: 5 }, 30)
    expect(spans[0]!.spanId).toBe(INTERACTION)
    expect(spans[0]!.attributes['user_prompt']).toBe('see a long pasted text')
  })

  test("only a subagent's own request names its Agent call's run", () => {
    const r = rebuild()
    observeRow(r, row('hook_execution_complete', 5, { agent_id: 'a7' }, '3333333333333333'))
    observeRow(r, request(6, 900, { agent_id: 'a7', query_source: 'agent:builtin:Explore' }, AGENT_EXEC))
    expect(r.execOfAgent.get('a7')).toBe(AGENT_EXEC)
  })

  test('a turn started under TRACEPARENT joins its trace', () => {
    const r = rebuild({ traceparent: parseTraceparent(`00-${TRACE}-0123456789abcdef-01`)! })
    const { spans } = turn(r)
    const [i] = named(spans, 'interaction')
    expect(i!.parentSpanId).toBe('0123456789abcdef')
    expect(i!.attributes['parent.source']).toBe('env')
  })
})

describe('pairing', () => {
  test('a request whose step never settles goes after a short wait, timed from its own row', () => {
    const r = rebuild()
    observeRow(r, row('user_prompt', 0, {}, INTERACTION))
    expect(observeRow(r, request(1_000, 1201)).spans).toEqual([])
    expect(sweep(r, 1_500, false).spans).toEqual([])
    const [s] = sweep(r, 3_100, false).spans
    expect(s).toEqual(expect.objectContaining({ startMs: 970, endMs: 1_000 }))
    expect(s!.attributes['stop_reason']).toBeUndefined()
  })

  test("a request outside the loops (a title, a summary) goes at once, with no step", () => {
    const r = rebuild()
    const { spans } = observeRow(r, request(1_000, 50, { query_source: 'generate_session_title' }, ''))
    expect(spans.length).toBe(1)
    expect(spans[0]!.attributes['llm_request.context']).toBe('standalone')
    expect(spans[0]!.parentSpanId).toBeUndefined()
  })

  test("a plugin's own completion is a request span but counts toward no cost or tokens, as in Claude Code", () => {
    const r = rebuild()
    const { spans, measures } = observeRow(r, request(1_000, 60, { query_source: 'plugin_model_complete' }, ''))
    expect(spans.length).toBe(1)
    expect(measures).toEqual([])
  })

  test('a failed request is an error span, its attempt and status as the row says', () => {
    const r = rebuild()
    stepStart(r, undefined, 'claude-haiku-5-5')
    stepEnd(r, undefined, 100, { stopReason: null, usage: null }, 150)
    const { spans } = observeRow(r, row('api_error', 160, { model: 'claude-haiku-5-5', error: 'Overloaded', status_code: '529', attempt: 3, duration_ms: 50, query_source: 'sdk' }, INTERACTION))
    expect(spans[0]!.status).toEqual({ code: 2, message: 'Overloaded' })
    expect(spans[0]!.attributes).toEqual(expect.objectContaining({ success: false, status_code: 529, error: 'Overloaded', attempt: 3 }))
    expect(spans[0]!.startMs).toBe(100)
  })
})

describe('tools', () => {
  test('a refused call has its decision and no run', () => {
    const r = rebuild()
    toolStart(r, { tool: 'Bash', tool_use_id: 'toolu_2', command: 'touch x' }, 10)
    observeRow(r, row('tool_decision', 12, { decision: 'reject', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_2' }, BLOCKED))
    const { spans } = toolEnd(r, 'toolu_2', { isError: true, result: 'denied' }, 14)
    expect(spans.map(s => s.name)).toEqual(['claude_code.tool', 'claude_code.tool.blocked_on_user'])
    expect(spans[1]!.attributes['decision']).toBe('reject')
  })

  test('a call a hook stopped before its permission step has no spans', () => {
    const r = rebuild()
    toolStart(r, { tool: 'Bash', tool_use_id: 'toolu_3', command: 'x' }, 10)
    expect(toolEnd(r, 'toolu_3', { deny: 'no' }, 11).spans).toEqual([])
    expect(sweep(r, 10_000, true).spans).toEqual([])
  })

  test('a call whose result row never comes goes after a short wait; a run that failed is an error', () => {
    const r = rebuild()
    observeRow(r, row('user_prompt', 0, {}, INTERACTION))
    turnStart(r, { turnId: 't', text: '' })
    toolStart(r, { tool: 'Read', tool_use_id: 'toolu_4', file_path: '/w/a.ts' }, 10)
    observeRow(r, row('tool_decision', 11, { decision: 'accept', source: 'config', tool_name: 'Read', tool_use_id: 'toolu_4' }, BLOCKED))
    expect(toolEnd(r, 'toolu_4', { isError: true, result: 'gone' }, 20).spans).toEqual([])
    const { spans } = sweep(r, 2_100, false)
    expect(spans.map(s => s.name)).toEqual(['claude_code.tool', 'claude_code.tool.blocked_on_user', 'claude_code.tool.execution'])
    expect(spans[0]!.parentSpanId).toBe(INTERACTION)
    expect(spans[0]!.attributes['file_path']).toBe('/w/a.ts')
    expect(spans[2]!.attributes).toEqual(expect.objectContaining({ success: false, 'error.type': 'tool_error' }))
    expect(spans[2]!.status).toEqual({ code: 2 })
  })

  test("an Agent call's run takes the id its subagent's rows name, and the subagent's requests sit under it", () => {
    const r = rebuild()
    toolStart(r, { tool: 'Agent', tool_use_id: 'toolu_5', description: 'd', prompt: 'p', subagent_type: 'general-purpose' }, 10)
    observeRow(r, row('tool_decision', 11, { decision: 'accept', source: 'config', tool_name: 'Agent', tool_use_id: 'toolu_5' }, BLOCKED))
    agentSpawned(r, 'toolu_5', 'a123', undefined)
    observeRow(r, row('tool_result', 20, { tool_name: 'Agent', tool_use_id: 'toolu_5', success: 'true' }, INTERACTION))
    const ended = toolEnd(r, 'toolu_5', { result: { status: 'async_launched' } }, 21)
    expect(ended.spans.map(s => s.name)).toEqual(['claude_code.tool', 'claude_code.tool.blocked_on_user'])
    expect(ended.spans[0]!.attributes['subagent_type']).toBe('general-purpose')
    stepStart(r, 'a123', 'claude-haiku-5-5')
    stepEnd(r, 'a123', 30, { stopReason: 'end_turn', usage: usage(1300) }, 50)
    const { spans, measures } = observeRow(r, request(51, 1300, { agent_id: 'a123', query_source: 'agent:builtin:general-purpose', 'agent.name': 'general-purpose' }, AGENT_EXEC))
    const [req] = named(spans, 'llm_request')
    const [exec] = named(spans, 'tool.execution')
    expect(req).toEqual(expect.objectContaining({ parentSpanId: AGENT_EXEC }))
    expect(req!.attributes).toEqual(expect.objectContaining({ 'llm_request.context': 'tool', 'gen_ai.conversation.id': 'a123', agent_id: 'a123', query_source_safe: 'agent.builtin.general-purpose' }))
    expect(exec).toEqual(expect.objectContaining({ spanId: AGENT_EXEC, parentSpanId: ended.spans[0]!.spanId }))
    expect(measures[0]!.attributes).toEqual(expect.objectContaining({ query_source: 'subagent', 'agent.name': 'general-purpose' }))
  })

  test("an Agent call whose subagent names nothing still sends its run when the subagent's turn ends", () => {
    const r = rebuild()
    toolStart(r, { tool: 'Agent', tool_use_id: 'toolu_6', subagent_type: 'Explore' }, 10)
    observeRow(r, row('tool_decision', 11, { decision: 'accept', source: 'config', tool_name: 'Agent', tool_use_id: 'toolu_6' }, BLOCKED))
    agentSpawned(r, 'toolu_6', 'a9', undefined)
    observeRow(r, row('tool_result', 20, { tool_name: 'Agent', tool_use_id: 'toolu_6', success: 'true' }, INTERACTION))
    toolEnd(r, 'toolu_6', { result: {} }, 21)
    expect(named(turnComplete(r, { turnId: 'x', durationMs: 5, agentId: 'a9' }, 40).spans, 'tool.execution').length).toBe(1)
  })

  test('file edits count their lines and permission decisions; a commit counts', () => {
    const r = rebuild()
    observeRow(r, row('user_prompt', 0, {}, INTERACTION))
    stepStart(r, undefined, 'claude-opus-5-5')
    toolStart(r, { tool: 'Write', tool_use_id: 'toolu_7', file_path: '/w/a.txt', content: 'one\ntwo\n' }, 10)
    const decided = observeRow(r, row('tool_decision', 11, { decision: 'accept', source: 'config', tool_name: 'Write', tool_use_id: 'toolu_7' }, BLOCKED))
    expect(decided.measures).toEqual([{ name: 'claude_code.code_edit_tool.decision', value: 1, atMs: 11, attributes: { ...COMMON, decision: 'accept', source: 'config', tool_name: 'Write', language: 'Plain text' } }])
    const written = toolEnd(r, 'toolu_7', { result: { type: 'create', content: 'one\ntwo\n', structuredPatch: [], originalFile: null } }, 20)
    expect(written.measures.map(m => [m.name, m.value, m.attributes['type'], m.attributes['model']])).toEqual([
      ['claude_code.lines_of_code.count', 3, 'added', 'claude-opus-5-5'], ['claude_code.lines_of_code.count', 0, 'removed', 'claude-opus-5-5'],
    ])
    toolStart(r, { tool: 'Bash', tool_use_id: 'toolu_8', command: 'git commit -m x && gh pr create --fill' }, 30)
    expect(toolEnd(r, 'toolu_8', { result: {} }, 40).measures.map(m => [m.name, m.value])).toEqual([['claude_code.commit.count', 1], ['claude_code.pull_request.count', 1]])
    toolStart(r, { tool: 'Bash', tool_use_id: 'toolu_9', command: 'git commit -m x' }, 50)
    expect(toolEnd(r, 'toolu_9', { isError: true, result: 'exit 1' }, 60).measures).toEqual([])
  })
})

describe('the session', () => {
  test('its count waits for a row to name it, and is timed when it started', () => {
    const r = rebuild()
    expect(sessionStarted(r, 5).measures).toEqual([])
    const { measures } = observeRow(r, row('user_prompt', 100, {}))
    expect(measures).toEqual([{ name: 'claude_code.session.count', value: 1, atMs: 5, attributes: { ...COMMON, start_type: 'fresh' } }])
  })

  test('at the end, what has ended goes; what has not never does', () => {
    const r = rebuild()
    turnStart(r, { turnId: 'open', text: 'x' })
    toolStart(r, { tool: 'Bash', tool_use_id: 'toolu_10', command: 'sleep 100' }, 10)
    observeRow(r, row('tool_decision', 11, { decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_10' }, BLOCKED))
    observeRow(r, request(20, 1500))
    expect(sweep(r, 25, true).spans.map(s => s.name)).toEqual(['claude_code.llm_request'])
  })

  test('long strings are cut to the length limit the session sets', () => {
    const r = rebuild({ valueLengthLimit: 5 })
    const { spans } = observeRow(r, request(1, 7, { query_source: 'compact', model: 'claude-haiku-5-5-long-name' }, ''))
    expect(spans[0]!.attributes['model']).toBe('claud')
  })
})
