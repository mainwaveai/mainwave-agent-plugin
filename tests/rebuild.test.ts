// The rebuild of Claude Code's spans and measures, driven directly: rows and engine events in, finished spans and measures out.
// The shapes asserted here are the ones Claude Code 2.1.322's exporter sends (tests/e2e/compare.mjs checks them against it).

import { describe, expect, test } from 'claude-code/testing'

import type { BuiltSpan } from '../hooks/otlp.ts'
import {
  agentSpawned, commandEnd, commandStart, commonOf, isCoherent, newRebuild, observeRow, parseTraceparent, promptDropped, promptSubmitted, takeReady, sessionStarted, stepEnd, stepStart, sweep, toolEnd, toolStart, turnComplete, turnStart,
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
  return newRebuild({ toolDetails: true, claudeTraces: true, ...settings }, len => (++n).toString(16).padStart(len, 'a'))
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
    turnStart(r, { turnId: 't1', text: 'run it' }, 0)
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
    turnStart(r, { turnId: 't2', text: 'next' }, 0)
    const { spans } = turnComplete(r, { turnId: 't2', durationMs: 10 }, 320)
    expect(spans[0]).toEqual(expect.objectContaining({ spanId: 'f00df00df00df00d' }))
    expect(spans[0]!.attributes['interaction.sequence']).toBe(2)
  })

  test("a prompt row that started no turn is not taken by the next turn", () => {
    const r = rebuild()
    observeRow(r, row('user_prompt', 10, { prompt: 'blocked by a hook', prompt_length: '17' }, 'f00df00df00df00d'))
    turnStart(r, { turnId: 't9', text: 'go' }, 0)
    observeRow(r, row('user_prompt', 20, { prompt: 'go', prompt_length: '2' }, INTERACTION))
    const { spans } = turnComplete(r, { turnId: 't9', durationMs: 5 }, 30)
    expect(spans[0]!.spanId).toBe(INTERACTION)
    expect(spans[0]!.attributes['user_prompt']).toBe('go')
  })

  test("a prompt row whose text the turn's does not match is still the turn's when its requests name the same span", () => {
    const r = rebuild()
    turnStart(r, { turnId: 't8', text: 'see [Pasted text #1]' }, 0)
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
    turnStart(r, { turnId: 't', text: '' }, 0)
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

describe('slash commands', () => {
  test('a command that asks no model is an interaction of its own, with its prompt row\'s ids, whichever comes first', () => {
    for (const rowFirst of [true, false]) {
      const r = rebuild()
      commandStart(r, 100)
      let out: Emit = { spans: [], measures: [] }
      if (rowFirst) observeRow(r, row('user_prompt', 105, { prompt: '/context', prompt_length: '8' }, INTERACTION))
      out = commandEnd(r, 113)
      if (!rowFirst) out = all(out, observeRow(r, row('user_prompt', 120, { prompt: '/cost', prompt_length: '5' }, INTERACTION)))
      expect(all(out, sweep(r, 1_000, false)).spans).toEqual([])
      out = sweep(r, 2_200, false)
      const [i] = named(out.spans, 'interaction')
      expect(i).toEqual(expect.objectContaining({ traceId: TRACE, spanId: INTERACTION, startMs: 100, endMs: rowFirst ? 113 : 120 }))
      expect(i!.attributes).toEqual(expect.objectContaining({ user_prompt: rowFirst ? '/context' : '/cost', 'interaction.sequence': 1, 'interaction.duration_ms': rowFirst ? 13 : 20 }))
      expect(out.measures).toEqual([expect.objectContaining({ name: 'claude_code.active_time.total', value: rowFirst ? 0.013 : 0.02 })])
    }
  })

  test('a command that goes on to ask the model is one interaction with its turn', () => {
    const r = rebuild()
    commandStart(r, 100)
    observeRow(r, row('user_prompt', 101, { prompt: '/review', prompt_length: '7' }, INTERACTION))
    expect(commandEnd(r, 110).spans).toEqual([])
    promptSubmitted(r, { command: { name: 'review', args: '' } }, 111)
    turnStart(r, { turnId: 't1', text: 'Review this change' }, 112)
    expect(sweep(r, 5_000, false).spans).toEqual([])
    const { spans } = turnComplete(r, { turnId: 't1', durationMs: 50 }, 200)
    expect(spans.map(s => [s.name, s.spanId, s.attributes['user_prompt'], s.attributes['interaction.sequence']])).toEqual([['claude_code.interaction', INTERACTION, '/review', 1]])
    turnStart(r, { turnId: 't2', text: 'next' }, 0)
    expect(r.interaction!.sequence).toBe(2)
  })

  test('two commands back to back are two interactions, numbered in turn', () => {
    const r = rebuild()
    commandStart(r, 100)
    observeRow(r, row('user_prompt', 101, { prompt: '/cost', prompt_length: '5' }, INTERACTION))
    commandEnd(r, 110)
    commandStart(r, 120)
    const flushed = takeReady(r)
    observeRow(r, row('user_prompt', 121, { prompt: '/context', prompt_length: '8' }, 'f00df00df00df00d'))
    commandEnd(r, 130)
    const later = sweep(r, 2_200, false)
    expect([...flushed.spans, ...later.spans].map(s => [s.spanId, s.attributes['user_prompt'], s.attributes['interaction.sequence']])).toEqual([
      [INTERACTION, '/cost', 1], ['f00df00df00df00d', '/context', 2],
    ])
  })

  test('a plain prompt right after a command is a turn of its own, and the command goes first', () => {
    const r = rebuild()
    commandStart(r, 100)
    observeRow(r, row('user_prompt', 101, { prompt: '/cost', prompt_length: '5' }, INTERACTION))
    commandEnd(r, 110)
    const sent = promptSubmitted(r, {}, 300)
    expect(sent.spans.map(s => [s.spanId, s.attributes['interaction.sequence']])).toEqual([[INTERACTION, 1]])
    turnStart(r, { turnId: 't', text: 'hello' }, 0)
    observeRow(r, row('user_prompt', 301, { prompt: 'hello', prompt_length: '5' }, 'f00df00df00df00d'))
    const { spans } = turnComplete(r, { turnId: 't', durationMs: 50 }, 400)
    expect(spans.map(s => [s.spanId, s.attributes['user_prompt'], s.attributes['interaction.sequence']])).toEqual([['f00df00df00df00d', 'hello', 2]])
  })

  test('a turn no submission handed a command to does not take it over', () => {
    const r = rebuild()
    commandStart(r, 100)
    observeRow(r, row('user_prompt', 101, { prompt: '/cost', prompt_length: '5' }, INTERACTION))
    commandEnd(r, 110)
    const sent = turnStart(r, { turnId: 't', text: 'hello' }, 150)
    expect(sent.spans.map(s => [s.spanId, s.attributes['interaction.sequence']])).toEqual([[INTERACTION, 1]])
    expect(r.interaction!.sequence).toBe(2)
  })

  test('a submission that runs a command keeps the command for its turn', () => {
    const r = rebuild()
    commandStart(r, 100)
    observeRow(r, row('user_prompt', 101, { prompt: '/review', prompt_length: '7' }, INTERACTION))
    commandEnd(r, 110)
    expect(promptSubmitted(r, { command: { name: 'review', args: '' } }, 111).spans).toEqual([])
    expect(turnStart(r, { turnId: 't', text: 'Review this change' }, 112).spans).toEqual([])
    expect(turnComplete(r, { turnId: 't', durationMs: 50 }, 200).spans.map(s => s.spanId)).toEqual([INTERACTION])
  })

  test("a slash command's prompt row seen just before the command is the command's; another prompt's is not", () => {
    const r = rebuild()
    observeRow(r, row('user_prompt', 99, { prompt: '/cost', prompt_length: '5' }, INTERACTION))
    commandStart(r, 100)
    commandEnd(r, 110)
    expect(sweep(r, 2_200, false).spans.map(s => s.spanId)).toEqual([INTERACTION])
    const r2 = rebuild()
    commandStart(r2, 100)
    observeRow(r2, row('user_prompt', 101, { prompt: 'hello', prompt_length: '5' }, INTERACTION))
    commandEnd(r2, 110)
    expect(sweep(r2, 2_200, false).spans[0]!.spanId).not.toBe(INTERACTION)
  })

  test("a prompt row that started nothing a while ago is not the next command's", () => {
    const r = rebuild()
    observeRow(r, row('user_prompt', 10, { prompt: '<REDACTED>', prompt_length: '17' }, '1111111111111111'))
    commandStart(r, 5_000)
    observeRow(r, row('user_prompt', 5_001, { prompt: '<REDACTED>', prompt_length: '5' }, INTERACTION))
    commandEnd(r, 5_010)
    const [i] = sweep(r, 8_000, false).spans
    expect([i!.spanId, i!.attributes['user_prompt_length']]).toEqual([INTERACTION, 5])
  })

  test('/cost then /exit at once: both are sent, the first even though the session ends inside the second', () => {
    const r = rebuild()
    commandStart(r, 100)
    observeRow(r, row('user_prompt', 101, { prompt: '/cost', prompt_length: '5' }, INTERACTION))
    commandEnd(r, 110)
    commandStart(r, 120)
    observeRow(r, row('user_prompt', 121, { prompt: '/exit', prompt_length: '5' }, 'f00df00df00df00d'))
    expect(sweep(r, 125, true).spans.map(s => [s.attributes['user_prompt'], s.attributes['interaction.sequence']])).toEqual([['/cost', 1], ['/exit', 2]])
  })

  test('a command handed to a turn waits for that turn past the usual wait; one whose prompt is dropped goes alone', () => {
    const r = rebuild()
    commandStart(r, 100)
    observeRow(r, row('user_prompt', 101, { prompt: '/review', prompt_length: '7' }, INTERACTION))
    commandEnd(r, 110)
    promptSubmitted(r, { command: { name: 'review', args: '' } }, 111)
    expect(sweep(r, 5_000, false).spans).toEqual([])
    expect(turnStart(r, { turnId: 't', text: 'Review this change' }, 5_001).spans).toEqual([])
    expect(r.interaction!.sequence).toBe(1)
    const r2 = rebuild()
    commandStart(r2, 100)
    commandEnd(r2, 110)
    promptSubmitted(r2, { command: { name: 'review', args: '' } }, 111)
    expect(promptDropped(r2, 112).spans.length).toBe(1)
    const r3 = rebuild()
    commandStart(r3, 100)
    commandEnd(r3, 110)
    promptSubmitted(r3, { command: { name: 'review', args: '' } }, 111)
    expect(sweep(r3, 30_200, false).spans.length).toBe(1)
  })

  test('a command still open when the session ends (/exit) ends with it', () => {
    const r = rebuild()
    commandStart(r, 100)
    observeRow(r, row('user_prompt', 101, { prompt: '/exit', prompt_length: '5' }, INTERACTION))
    const [i] = sweep(r, 115, true).spans
    expect(i).toEqual(expect.objectContaining({ name: 'claude_code.interaction', spanId: INTERACTION, startMs: 100, endMs: 115 }))
  })
})

describe('the request context', () => {
  test('a request whose row names no span, in a turn whose rows do, ran outside the interaction', () => {
    const r = rebuild()
    turnStart(r, { turnId: 't', text: 'go' }, 0)
    observeRow(r, row('user_prompt', 1, { prompt: 'go', prompt_length: '2' }, INTERACTION))
    const [aux] = observeRow(r, request(10, 77, { query_source: 'generate_session_title' }, '')).spans
    expect(aux!.attributes['llm_request.context']).toBe('standalone')
  })
})

describe('hosts that carry no trace on their rows (the SDK), and those that do', () => {
  test('once a prompt row has named its span, a spanless request before the next prompt row is standalone', () => {
    const r = rebuild()
    turnStart(r, { turnId: 't1', text: 'go' }, 0)
    observeRow(r, row('user_prompt', 1, { prompt: 'go', prompt_length: '2' }, INTERACTION))
    turnComplete(r, { turnId: 't1', durationMs: 5 }, 10)
    turnStart(r, { turnId: 't2', text: 'next' }, 20)
    const [aux] = observeRow(r, request(21, 88, { query_source: 'generate_session_title' }, '')).spans
    expect(aux!.attributes['llm_request.context']).toBe('standalone')
  })
})

describe('hosts that carry no trace on their rows (the SDK)', () => {
  test("a main-loop request with no span on its row runs in the open interaction; a subagent's in its tool", () => {
    const r = rebuild()
    turnStart(r, { turnId: 't', text: 'go' }, 0)
    const [main] = observeRow(r, request(10, 1201, { query_source: 'generate_session_title' }, '')).spans
    expect(main!.attributes['llm_request.context']).toBe('interaction')
    const [sub] = observeRow(r, request(20, 1202, { query_source: 'generate_session_title', agent_id: 'a1' }, '')).spans
    expect(sub!.attributes['llm_request.context']).toBe('tool')
    turnComplete(r, { turnId: 't', durationMs: 30 }, 40)
    const [after] = observeRow(r, request(50, 1203, { query_source: 'generate_session_title' }, '')).spans
    expect(after!.attributes['llm_request.context']).toBe('standalone')
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
    turnStart(r, { turnId: 'open', text: 'x' }, 0)
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

describe('without the beta, no row names a span: the plugin builds the trace (coherent mode)', () => {
  const coherent = () => rebuild({ claudeTraces: false })
  const one = (spans: BuiltSpan[], name: string) => {
    const found = named(spans, name)
    expect(found.length).toBe(1)
    return found[0]!
  }

  /** A main-loop turn with one Bash call, as Claude Code raises it without the beta: the same events and rows, none naming a span. */
  function bareTurn(r: Rebuild, id = 't1', at = 0, input = 1201) {
    const out: Emit[] = []
    out.push(observeRow(r, row('user_prompt', at + 1, { prompt: 'run it', prompt_length: '6' })))
    out.push(turnStart(r, { turnId: id, text: 'run it' }, at + 2))
    stepStart(r, undefined, 'claude-haiku-5-5')
    toolStart(r, { tool: 'Bash', tool_use_id: `${id}_bash`, command: 'echo e2e', description: 'x' }, at + 30)
    out.push(observeRow(r, row('tool_decision', at + 35, { decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: `${id}_bash` })))
    out.push(stepEnd(r, undefined, at + 10, { stopReason: 'tool_use', usage: usage(input) }, at + 40))
    out.push(observeRow(r, request(at + 41, input, {}, '')))
    out.push(observeRow(r, row('tool_result', at + 80, { tool_name: 'Bash', tool_use_id: `${id}_bash`, success: 'true' })))
    out.push(toolEnd(r, `${id}_bash`, { result: { stdout: 'e2e' } }, at + 81))
    stepStart(r, undefined, 'claude-haiku-5-5')
    out.push(observeRow(r, request(at + 120, input + 1, {}, '')))
    out.push(stepEnd(r, undefined, at + 90, { stopReason: 'end_turn', usage: usage(input + 1) }, at + 121))
    out.push(turnComplete(r, { turnId: id, durationMs: 128 }, at + 130))
    return all(...out)
  }

  test('the interaction is the root of its own trace; its requests and calls are its children, the decision and the run the call\'s', () => {
    const { spans } = bareTurn(coherent())
    const i = one(spans, 'interaction')
    expect(i.parentSpanId).toBeUndefined()
    expect(i.attributes['user_prompt']).toBe('run it')
    expect(new Set(spans.map(s => s.traceId))).toEqual(new Set([i.traceId]))
    const reqs = named(spans, 'llm_request')
    expect(reqs.map(s => [s.parentSpanId, s.attributes['llm_request.context']])).toEqual([[i.spanId, 'interaction'], [i.spanId, 'interaction']])
    const tool = one(spans, 'tool')
    expect(tool.parentSpanId).toBe(i.spanId)
    expect(one(spans, 'tool.blocked_on_user').parentSpanId).toBe(tool.spanId)
    expect(one(spans, 'tool.execution').parentSpanId).toBe(tool.spanId)
    expect(new Set(spans.map(s => s.spanId)).size).toBe(spans.length)
  })

  test('each turn is a trace of its own', () => {
    const r = coherent()
    const first = one(bareTurn(r, 't1', 0, 1201).spans, 'interaction')
    const second = bareTurn(r, 't2', 1_000, 1301).spans
    const i2 = one(second, 'interaction')
    expect(i2.traceId).not.toBe(first.traceId)
    expect(i2.attributes['interaction.sequence']).toBe(2)
    expect(new Set(second.map(s => s.traceId))).toEqual(new Set([i2.traceId]))
  })

  test("a subagent's requests and calls sit under its Agent call's run, in the turn's trace, nested subagents too", () => {
    const r = coherent()
    const out: Emit[] = []
    out.push(turnStart(r, { turnId: 't1', text: 'go' }, 0))
    toolStart(r, { tool: 'Agent', tool_use_id: 'toolu_a', subagent_type: 'general-purpose', prompt: 'p', description: 'd' }, 10)
    out.push(observeRow(r, row('tool_decision', 11, { decision: 'accept', source: 'config', tool_name: 'Agent', tool_use_id: 'toolu_a' })))
    agentSpawned(r, 'toolu_a', 'a1', undefined)
    // A background subagent: the call returns as the subagent starts, and the subagent runs on.
    out.push(observeRow(r, row('tool_result', 20, { tool_name: 'Agent', tool_use_id: 'toolu_a', success: 'true' })))
    out.push(toolEnd(r, 'toolu_a', { result: { status: 'async_launched' } }, 21))
    stepStart(r, 'a1', 'claude-haiku-5-5')
    out.push(stepEnd(r, 'a1', 22, { stopReason: 'tool_use', usage: usage(1300) }, 28))
    out.push(observeRow(r, request(29, 1300, { agent_id: 'a1', query_source: 'agent:builtin:general-purpose' }, '')))
    toolStart(r, { tool: 'Bash', tool_use_id: 'toolu_s', agentId: 'a1', command: 'echo sub' }, 30)
    out.push(observeRow(r, row('tool_decision', 31, { decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_s', agent_id: 'a1' })))
    out.push(observeRow(r, row('tool_result', 35, { tool_name: 'Bash', tool_use_id: 'toolu_s', success: 'true', agent_id: 'a1' })))
    out.push(toolEnd(r, 'toolu_s', { result: { stdout: 'sub' } }, 36))
    toolStart(r, { tool: 'Agent', tool_use_id: 'toolu_n', agentId: 'a1', subagent_type: 'Explore', prompt: 'p', description: 'd' }, 40)
    out.push(observeRow(r, row('tool_decision', 41, { decision: 'accept', source: 'config', tool_name: 'Agent', tool_use_id: 'toolu_n', agent_id: 'a1' })))
    agentSpawned(r, 'toolu_n', 'a2', 'a1')
    stepStart(r, 'a2', 'claude-haiku-5-5')
    out.push(stepEnd(r, 'a2', 42, { stopReason: 'end_turn', usage: usage(1400) }, 48))
    out.push(observeRow(r, request(49, 1400, { agent_id: 'a2', query_source: 'agent:builtin:Explore' }, '')))
    out.push(observeRow(r, row('tool_result', 50, { tool_name: 'Agent', tool_use_id: 'toolu_n', success: 'true', agent_id: 'a1' })))
    out.push(toolEnd(r, 'toolu_n', { result: {} }, 51))
    // The main turn ends while the background subagent's spans are all sent.
    out.push(turnComplete(r, { turnId: 't1', durationMs: 60 }, 60))
    const { spans } = all(...out)

    const i = one(spans, 'interaction')
    expect(new Set(spans.map(s => s.traceId))).toEqual(new Set([i.traceId]))
    const byUse = (name: string, id: string) => named(spans, name).find(s => s.attributes['tool_use_id'] === id)!
    const agentCall = byUse('tool', 'toolu_a')
    const agentRun = byUse('tool.execution', 'toolu_a')
    expect(agentCall.parentSpanId).toBe(i.spanId)
    expect(agentRun.parentSpanId).toBe(agentCall.spanId)
    const subReq = named(spans, 'llm_request').find(s => s.attributes['agent_id'] === 'a1')!
    expect([subReq.parentSpanId, subReq.attributes['llm_request.context']]).toEqual([agentRun.spanId, 'tool'])
    expect(byUse('tool', 'toolu_s').parentSpanId).toBe(agentRun.spanId)
    expect(byUse('tool.execution', 'toolu_s').parentSpanId).toBe(byUse('tool', 'toolu_s').spanId)
    const nestedCall = byUse('tool', 'toolu_n')
    const nestedRun = byUse('tool.execution', 'toolu_n')
    expect(nestedCall.parentSpanId).toBe(agentRun.spanId)
    expect(nestedRun.parentSpanId).toBe(nestedCall.spanId)
    const nestedReq = named(spans, 'llm_request').find(s => s.attributes['agent_id'] === 'a2')!
    expect(nestedReq.parentSpanId).toBe(nestedRun.spanId)
    expect(nestedReq.attributes['parent_agent_id']).toBe('a1')
  })

  test('a loop no Agent call starts (a forked skill) stays in one trace, under the interaction open when it was first seen', () => {
    const r = coherent()
    const out: Emit[] = []
    out.push(turnStart(r, { turnId: 't1', text: 'go' }, 0))
    for (const [id, at] of [['toolu_f1', 10], ['toolu_f2', 20]] as const) {
      toolStart(r, { tool: 'Read', tool_use_id: id, agentId: 'f1', file_path: '/w/a.ts' }, at)
      out.push(observeRow(r, row('tool_result', at + 2, { tool_name: 'Read', tool_use_id: id, success: 'true', agent_id: 'f1' })))
      out.push(toolEnd(r, id, { result: {} }, at + 3))
    }
    stepStart(r, 'f1', 'claude-haiku-5-5')
    out.push(stepEnd(r, 'f1', 25, { stopReason: 'end_turn', usage: usage(1600) }, 28))
    out.push(observeRow(r, request(29, 1600, { agent_id: 'f1', query_source: 'agent:custom' }, '')))
    out.push(turnComplete(r, { turnId: 't1', durationMs: 40 }, 40))
    const { spans } = all(...out)
    const i = one(spans, 'interaction')
    expect(new Set(spans.map(s => s.traceId))).toEqual(new Set([i.traceId]))
    expect(named(spans, 'tool').map(s => s.parentSpanId)).toEqual([i.spanId, i.spanId])
    expect(one(spans, 'llm_request').parentSpanId).toBe(i.spanId)
  })

  test('a call that starts several agents (a workflow) has one run, the parent of every one of them', () => {
    const r = coherent()
    const out: Emit[] = []
    out.push(turnStart(r, { turnId: 't1', text: 'go' }, 0))
    toolStart(r, { tool: 'Workflow', tool_use_id: 'toolu_w' }, 10)
    out.push(observeRow(r, row('tool_decision', 11, { decision: 'accept', source: 'config', tool_name: 'Workflow', tool_use_id: 'toolu_w' })))
    agentSpawned(r, 'toolu_w', 'w1', undefined)
    agentSpawned(r, 'toolu_w', 'w2', undefined)
    for (const [agent, input] of [['w1', 1700], ['w2', 1701]] as const) {
      stepStart(r, agent, 'claude-haiku-5-5')
      out.push(stepEnd(r, agent, 12, { stopReason: 'end_turn', usage: usage(input) }, 15))
      out.push(observeRow(r, request(16, input, { agent_id: agent, query_source: 'agent:custom' }, '')))
    }
    out.push(observeRow(r, row('tool_result', 30, { tool_name: 'Workflow', tool_use_id: 'toolu_w', success: 'true' })))
    out.push(toolEnd(r, 'toolu_w', { result: {} }, 31))
    out.push(turnComplete(r, { turnId: 't1', durationMs: 40 }, 40))
    const { spans } = all(...out)
    const run = one(spans, 'tool.execution')
    expect(named(spans, 'llm_request').map(s => s.parentSpanId)).toEqual([run.spanId, run.spanId])
  })

  test('a request whose span goes after its turn has ended still sits under its interaction', () => {
    const r = coherent()
    turnStart(r, { turnId: 't1', text: 'go' }, 0)
    expect(observeRow(r, request(10, 1201, {}, '')).spans).toEqual([])
    const i = one(turnComplete(r, { turnId: 't1', durationMs: 15 }, 15).spans, 'interaction')
    const req = one(sweep(r, 3_000, false).spans, 'llm_request')
    expect([req.traceId, req.parentSpanId, req.attributes['llm_request.context']]).toEqual([i.traceId, i.spanId, 'interaction'])
  })

  test("a request outside the main loop and its subagents (a session title) is a root, as Claude Code's exporter sends it", () => {
    const r = coherent()
    turnStart(r, { turnId: 't1', text: 'go' }, 0)
    const aux = one(observeRow(r, request(10, 77, { query_source: 'generate_session_title' }, '')).spans, 'llm_request')
    expect(aux.parentSpanId).toBeUndefined()
    expect(aux.attributes['llm_request.context']).toBe('standalone')
  })

  test("a slash command that asks no model is a trace of its own; one a turn takes over is that turn's interaction", () => {
    const r = coherent()
    commandStart(r, 0)
    commandEnd(r, 5)
    const cmd = one(sweep(r, 5_000, false).spans, 'interaction')
    expect(cmd.parentSpanId).toBeUndefined()
    commandStart(r, 6_000)
    promptSubmitted(r, { command: 'review' }, 6_001)
    commandEnd(r, 6_002)
    turnStart(r, { turnId: 't2', text: 'review it' }, 6_003)
    stepStart(r, undefined, 'claude-haiku-5-5')
    stepEnd(r, undefined, 6_004, { stopReason: 'end_turn', usage: usage(1500) }, 6_010)
    const req = one(observeRow(r, request(6_011, 1500, {}, '')).spans, 'llm_request')
    const turn = one(turnComplete(r, { turnId: 't2', durationMs: 20 }, 6_020).spans, 'interaction')
    expect(turn.traceId).not.toBe(cmd.traceId)
    expect([req.traceId, req.parentSpanId]).toEqual([turn.traceId, turn.spanId])
    expect(turn.attributes['interaction.sequence']).toBe(2)
  })

  test('once a row names a span the rebuild mirrors the rows again', () => {
    const r = coherent()
    expect(isCoherent(r)).toBe(true)
    observeRow(r, row('user_prompt', 1, { prompt: 'go', prompt_length: '2' }, INTERACTION))
    expect(isCoherent(r)).toBe(false)
    turnStart(r, { turnId: 't1', text: 'go' }, 2)
    const i = one(turnComplete(r, { turnId: 't1', durationMs: 5 }, 10).spans, 'interaction')
    expect([i.traceId, i.spanId]).toEqual([TRACE, INTERACTION])
  })

  test('the rows read in this mode carry the ids of the spans they ran in, as Claude Code\'s do when it traces', () => {
    const r = coherent()
    const prompt = observeRow(r, row('user_prompt', 1, { prompt: 'run it', prompt_length: '6' })).rowCtx
    turnStart(r, { turnId: 't1', text: 'run it' }, 2)
    toolStart(r, { tool: 'Bash', tool_use_id: 'toolu_1', command: 'echo e2e' }, 30)
    const decision = observeRow(r, row('tool_decision', 35, { decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_1' })).rowCtx
    stepStart(r, undefined, 'claude-haiku-5-5')
    stepEnd(r, undefined, 10, { stopReason: 'tool_use', usage: usage(1201) }, 40)
    const req = observeRow(r, request(41, 1201, {}, ''))
    const result = observeRow(r, row('tool_result', 80, { tool_name: 'Bash', tool_use_id: 'toolu_1', success: 'true' }))
    const spans = all(req, result, toolEnd(r, 'toolu_1', { result: {} }, 81), turnComplete(r, { turnId: 't1', durationMs: 80 }, 90)).spans
    const i = one(spans, 'interaction')
    const ids = (s: BuiltSpan) => ({ traceId: s.traceId, spanId: s.spanId })
    expect(prompt).toEqual(ids(i))
    expect(req.rowCtx).toEqual(ids(i))
    expect(result.rowCtx).toEqual(ids(i))
    expect(decision).toEqual(ids(one(spans, 'tool.blocked_on_user')))
    // A row outside any turn ran in no span the plugin knows.
    expect(observeRow(r, row('retention_sweep', 200, {})).rowCtx).toBeUndefined()
  })
})

describe('with the beta on, a turn whose prompt row names no span (an SDK host\'s first turn): the plugin rebuilds it', () => {
  const traced = () => rebuild({ claudeTraces: true })
  const one = (spans: BuiltSpan[], name: string) => {
    const found = named(spans, name)
    expect(found.length).toBe(1)
    return found[0]!
  }
  const T = (n: number) => n.toString(16).padStart(32, 'c')
  const S = (n: number) => n.toString(16).padStart(16, 'c')
  /** A row whose span is in a trace of its own, as Claude Code logs a call's rows in that turn. */
  const inTrace = (event: string, atMs: number, attributes: Record<string, unknown>, traceId: string, spanId: string): RowIn => ({ ...row(event, atMs, attributes), span: { traceId, spanId } })

  /**
   * The turn as the rows of a live session had it: the prompt, the main loop's requests and results name no span; each call's
   * decision names its span in a trace of its own; an Agent call's subagent logs everything in that call's trace, its requests and
   * results under the call's run (EXEC).
   */
  function firstTurn(r: Rebuild) {
    const out: (Emit & { rowCtx?: { traceId: string; spanId: string } })[] = []
    out.push(observeRow(r, row('user_prompt', 1, { prompt: 'go', prompt_length: '2' })))
    out.push(turnStart(r, { turnId: 't1', text: 'go' }, 2))
    stepStart(r, undefined, 'claude-haiku-5-5')
    out.push(stepEnd(r, undefined, 5, { stopReason: 'tool_use', usage: usage(1201) }, 9))
    out.push(observeRow(r, request(10, 1201, {}, '')))
    toolStart(r, { tool: 'Bash', tool_use_id: 'toolu_b', command: 'echo hi' }, 11)
    out.push(observeRow(r, inTrace('tool_decision', 12, { decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_b' }, T(1), S(1))))
    out.push(observeRow(r, row('tool_result', 15, { tool_name: 'Bash', tool_use_id: 'toolu_b', success: 'true' })))
    out.push(toolEnd(r, 'toolu_b', { result: {} }, 16))
    toolStart(r, { tool: 'Agent', tool_use_id: 'toolu_a', subagent_type: 'Explore', prompt: 'p', description: 'd' }, 20)
    out.push(observeRow(r, inTrace('tool_decision', 21, { decision: 'accept', source: 'config', tool_name: 'Agent', tool_use_id: 'toolu_a' }, T(2), S(2))))
    agentSpawned(r, 'toolu_a', 'a1', undefined)
    stepStart(r, 'a1', 'claude-haiku-5-5')
    out.push(stepEnd(r, 'a1', 22, { stopReason: 'tool_use', usage: usage(1300) }, 25))
    out.push(observeRow(r, inTrace('api_request', 26, { ...request(26, 1300).attributes, agent_id: 'a1', query_source: 'agent:builtin:Explore' }, T(2), S(3))))
    toolStart(r, { tool: 'Bash', tool_use_id: 'toolu_s', agentId: 'a1', command: 'echo sub' }, 27)
    out.push(observeRow(r, inTrace('tool_decision', 28, { decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_s', agent_id: 'a1' }, T(2), S(4))))
    out.push(observeRow(r, inTrace('tool_result', 30, { tool_name: 'Bash', tool_use_id: 'toolu_s', success: 'true', agent_id: 'a1' }, T(2), S(3))))
    out.push(toolEnd(r, 'toolu_s', { result: {} }, 31))
    out.push(observeRow(r, row('tool_result', 40, { tool_name: 'Agent', tool_use_id: 'toolu_a', success: 'true' })))
    out.push(toolEnd(r, 'toolu_a', { result: {} }, 41))
    out.push(turnComplete(r, { turnId: 't1', durationMs: 50 }, 52))
    return { emits: out, spans: all(...out).spans }
  }

  test('the turn is one trace: the interaction its root, its requests and calls under it, a subagent under its Agent call\'s run', () => {
    const r = traced()
    const { spans } = firstTurn(r)
    const i = one(spans, 'interaction')
    expect(i.parentSpanId).toBeUndefined()
    expect(new Set(spans.map(s => s.traceId))).toEqual(new Set([i.traceId]))
    const byUse = (name: string, id: string) => named(spans, name).find(s => s.attributes['tool_use_id'] === id)!
    const main = named(spans, 'llm_request').find(s => s.attributes['agent_id'] === undefined)!
    expect([main.parentSpanId, main.attributes['llm_request.context']]).toEqual([i.spanId, 'interaction'])
    expect(byUse('tool', 'toolu_b').parentSpanId).toBe(i.spanId)
    expect(byUse('tool', 'toolu_a').parentSpanId).toBe(i.spanId)
    // The span ids the rows name are kept: the decisions', and the Agent call's run, which its subagent's rows name.
    expect(named(spans, 'tool.blocked_on_user').map(s => s.spanId).sort()).toEqual([S(1), S(2), S(4)].sort())
    expect(byUse('tool.execution', 'toolu_a').spanId).toBe(S(3))
    const sub = named(spans, 'llm_request').find(s => s.attributes['agent_id'] === 'a1')!
    expect(sub.parentSpanId).toBe(S(3))
    expect(byUse('tool', 'toolu_s').parentSpanId).toBe(S(3))
  })

  test("the turn's rows carry the ids of its spans, the calls' traces moved onto the interaction's", () => {
    const r = traced()
    const { emits, spans } = firstTurn(r)
    const i = one(spans, 'interaction')
    const rows = emits.filter(e => 'rowCtx' in e).map(e => e.rowCtx!)
    expect(new Set(rows.map(c => c.traceId))).toEqual(new Set([i.traceId]))
    expect(rows[0]).toEqual({ traceId: i.traceId, spanId: i.spanId })
    expect(rows.map(c => c.spanId)).toEqual([i.spanId, i.spanId, S(1), i.spanId, S(2), S(3), S(4), S(3), i.spanId])
  })

  test('a later turn that Claude Code traces is mirrored as before, its ids the rows\'', () => {
    const r = traced()
    firstTurn(r)
    observeRow(r, row('user_prompt', 100, { prompt: 'next', prompt_length: '4' }, INTERACTION))
    turnStart(r, { turnId: 't2', text: 'next' }, 101)
    stepStart(r, undefined, 'claude-haiku-5-5')
    stepEnd(r, undefined, 102, { stopReason: 'end_turn', usage: usage(1400) }, 105)
    const req = observeRow(r, request(106, 1400))
    const i = one(turnComplete(r, { turnId: 't2', durationMs: 10 }, 111).spans, 'interaction')
    expect([i.traceId, i.spanId]).toEqual([TRACE, INTERACTION])
    expect([one(req.spans, 'llm_request').traceId, one(req.spans, 'llm_request').parentSpanId]).toEqual([TRACE, INTERACTION])
    expect(req.rowCtx).toEqual({ traceId: TRACE, spanId: INTERACTION })
  })

  test('a turn with no prompt row at all is mirrored as before: its requests in the open interaction, with ids of their own', () => {
    const r = traced()
    turnStart(r, { turnId: 't', text: 'go' }, 0)
    const [main] = observeRow(r, request(10, 1201, { query_source: 'generate_session_title' }, '')).spans
    expect(main!.parentSpanId).toBeUndefined()
    expect(main!.attributes['llm_request.context']).toBe('interaction')
  })
})
