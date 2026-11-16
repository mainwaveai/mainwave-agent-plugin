// End to end: the spans and metrics the plugin rebuilds, driven through the engine's own events (a turn, its model requests, a tool
// call) and the rows Claude Code raises beside them, with the engine beneath played by rig.ts and the kit's mocks.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { boot, KEY, LOGGED_AT, memoryStore, network, ORG, type Post, type Reply } from './rig.ts'

const withKey = { options: { devIngestKey: KEY } }
const TRACES_URL = 'https://collector.dev.mainwave.com/v1/traces'
const METRICS_URL = 'https://collector.dev.mainwave.com/v1/metrics'
const TRACE = '7d2fa3029813d71c9ad4ef05815fa7d5'
const INTERACTION = 'e4a76fb0fca33a96'
const BLOCKED = '1111111111111111'
const START = 1_800_000_000_000
const COMMON = { 'organization.id': ORG, 'user.id': 'device-1', 'session.id': 's-1', 'anthropic.provider': 'firstParty' }
const USAGE = { input_tokens: 1201, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function world(on: On, opts: { reply?: (n: number, post: Post) => Reply; store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: START })
  memoryStore(on, opts.store)
  const posts = network(on, opts.reply)
  // The org-wide env block's beta: Claude Code traces, and its rows name their spans.
  const rig = boot(on, { entrypoint: 'cli', env: { OTEL_LOG_TOOL_DETAILS: '1', OTEL_RESOURCE_ATTRIBUTES: 'mainwave.source=coding_agent.claude_code', CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1' } })
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: 'ok' }) as never)
  // The model: one response, its usage that of the row the test logs for it.
  on('turn.step', async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'tool_use', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
  })
  on('tool.call', () => ({ result: { stdout: 'hi', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }) as never)
  on('command.run', (_$, e) => {
    if ((e as { command: string }).command === 'broken') throw new Error('the command failed in test')
    return { text: 'Total cost: $0.00' } as never
  })
  return { clock, posts, rig }
}

/** Logs one collector row, as Claude Code raises it. */
async function row($: Engine, event: string, attributes: Record<string, unknown>, spanId?: string, loggedAt = LOGGED_AT) {
  await $.telemetry.log({
    to: 'collector', event, loggedAt, ...(spanId ? { span: { traceId: TRACE, spanId, traceFlags: 1 } } : {}),
    attributes: { ...COMMON, 'event.name': event, 'event.sequence': 1, ...attributes },
  } as never)
}

/**
 * One main-loop turn: a prompt, a request that calls Bash, the call with its decision and result rows, and the turn's end. Answers
 * what the stream yielded and what the step and the tool call resolved to.
 */
async function turn($: Engine) {
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  await row($, 'user_prompt', { prompt: 'go', prompt_length: '2' }, INTERACTION)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1 } as never)
  const chunks: unknown[] = []
  let read = await stream.next()
  while (!read.done) {
    chunks.push(read.value)
    read = await stream.next()
  }
  const step = read.value
  await row($, 'api_request', {
    model: 'claude-haiku-5-5', input_tokens: 1201, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.25,
    duration_ms: 10, ttft_ms: 4, request_id: 'req_1', speed: 'normal', query_source: 'sdk', effort: 'medium',
  }, INTERACTION)
  const tool = await $.tool.call({ tool: 'Bash', command: 'echo hi', description: 'x', tool_use_id: 'toolu_1' } as never)
  await row($, 'tool_decision', { decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_1' }, BLOCKED)
  await row($, 'tool_result', { tool_name: 'Bash', tool_use_id: 'toolu_1', success: 'true' }, INTERACTION)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 40, isAborted: false, reason: 'answer' } as never)
  return { chunks, step, tool }
}

/** The spans a set of requests carried, with their attributes as plain values and their resource and scope. */
function spans(posts: readonly Post[]) {
  const out: { name: string; traceId: string; spanId: string; parentSpanId?: string; attrs: Record<string, unknown>; resource: Record<string, unknown>; scope: unknown }[] = []
  const plain = (v: Record<string, unknown>): unknown => ('stringValue' in v ? v['stringValue'] : 'intValue' in v ? v['intValue'] : 'doubleValue' in v ? v['doubleValue'] : 'boolValue' in v ? v['boolValue'] : (v['arrayValue'] as { values: Record<string, unknown>[] }).values.map(plain))
  const kvs = (l: { key: string; value: Record<string, unknown> }[]) => Object.fromEntries(l.map(a => [a.key, plain(a.value)]))
  for (const p of posts.filter(p => p.url === TRACES_URL)) {
    for (const rs of JSON.parse(p.body).resourceSpans) {
      for (const ss of rs.scopeSpans) for (const s of ss.spans) out.push({ ...s, attrs: kvs(s.attributes), resource: kvs(rs.resource.attributes), scope: ss.scope })
    }
  }
  return out
}

describe('with a key', () => {
  test('a turn becomes its interaction, request, tool call, decision and run, each on the traces path with route plugin', withKey, async ($, on) => {
    const { clock, posts } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($)
    await clock.advance(5_000)
    const sent = spans(posts)
    expect(sent.map(s => s.name).sort()).toEqual(['claude_code.interaction', 'claude_code.llm_request', 'claude_code.tool', 'claude_code.tool.blocked_on_user', 'claude_code.tool.execution'])
    for (const s of sent) {
      expect(s.attrs['mainwave.telemetry.route']).toBe('plugin')
      expect(s.attrs['organization.id']).toBe(ORG)
      expect(s.traceId).toBe(TRACE)
      expect(s.scope).toEqual({ name: 'com.anthropic.claude_code.tracing', version: '1.0.0' })
      expect(s.resource).toEqual({ 'service.name': 'claude-code', 'service.version': '2.1.322', 'mainwave.source': 'coding_agent.claude_code' })
    }
    const by = (n: string) => sent.find(s => s.name === `claude_code.${n}`)!
    expect(by('interaction').spanId).toBe(INTERACTION)
    expect(by('llm_request').parentSpanId).toBe(INTERACTION)
    expect(by('llm_request').attrs['stop_reason']).toBe('tool_use')
    expect(by('tool').parentSpanId).toBe(INTERACTION)
    expect(by('tool').attrs['full_command']).toBe('echo hi')
    expect(by('tool.blocked_on_user').spanId).toBe(BLOCKED)
    expect(by('tool.blocked_on_user').parentSpanId).toBe(by('tool').spanId)
    expect(by('tool.execution').parentSpanId).toBe(by('tool').spanId)
  })

  test('the hooks only watch: the stream, the step result and the tool result come back as they were', withKey, async ($, on) => {
    world(on)
    const { chunks, step, tool } = await turn($)
    expect(chunks).toEqual([{ kind: 'stop', stopReason: 'tool_use', usage: { ...USAGE, model: 'claude-haiku-5-5' } }])
    expect(step).toEqual(expect.objectContaining({ stopReason: 'tool_use', turnId: 't1', index: 0 }))
    expect((tool as { result: { stdout: string } }).result.stdout).toBe('hi')
  })

  test('the session end sends the metrics: delta sums of doubles, with route plugin', withKey, async ($, on) => {
    const { posts } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    const bodies = posts.filter(p => p.url === METRICS_URL).map(p => JSON.parse(p.body))
    expect(bodies.length).toBe(1)
    const metrics = bodies[0].resourceMetrics[0].scopeMetrics[0]
    expect(metrics.scope).toEqual({ name: 'com.anthropic.claude_code', version: '2.1.322' })
    const names = metrics.metrics.map((m: { name: string }) => m.name)
    expect(names).toEqual(['claude_code.session.count', 'claude_code.cost.usage', 'claude_code.token.usage', 'claude_code.active_time.total'])
    const cost = metrics.metrics[1]
    expect(cost.unit).toBe('USD')
    expect(cost.sum.aggregationTemporality).toBe(1)
    expect(cost.sum.isMonotonic).toBe(true)
    expect(cost.sum.dataPoints[0].asDouble).toBe(0.25)
    const attrs = Object.fromEntries(cost.sum.dataPoints[0].attributes.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]))
    expect(attrs).toEqual(expect.objectContaining({ 'organization.id': ORG, model: 'claude-haiku-5-5', query_source: 'main', 'mainwave.telemetry.route': 'plugin' }))
    // The whole of the copy, logs included, went at the session's end, the three paths at once.
    expect(posts.map(p => p.url.split('/').at(-1)).sort()).toEqual(['logs', 'metrics', 'traces'])
  })

  test('a /clear sends what has ended but keeps the metrics counting, as the process goes on', withKey, async ($, on) => {
    const { posts } = world(on)
    await turn($)
    await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(posts.filter(p => p.url === METRICS_URL)).toEqual([])
    expect(spans(posts).length).toBe(5)
  })
})

describe('a model stream closed early', () => {
  test("moves no later request's start", withKey, async ($, on) => {
    const { clock, posts } = world(on)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await row($, 'user_prompt', { prompt: 'go', prompt_length: '2' }, INTERACTION)
    const closed = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1 } as never)
    await closed.next()
    await closed.return(undefined as never)
    await clock.advance(10_000)
    const stream = $.turn.step({ turnId: 't1', index: 1, model: 'claude-haiku-5-5', messageCount: 2 } as never)
    while (!(await stream.next()).done) {
      // read to the end
    }
    await row($, 'api_request', {
      model: 'claude-haiku-5-5', input_tokens: 1201, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.25,
      duration_ms: 10, ttft_ms: 4, request_id: 'req_2', speed: 'normal', query_source: 'sdk', effort: 'medium',
    }, INTERACTION, new Date(START + 10_050).toISOString())
    await clock.advance(5_000)
    const body = JSON.parse(posts.find(p => p.url === TRACES_URL)!.body)
    const span = body.resourceSpans[0].scopeSpans[0].spans[0]
    expect(span.name).toBe('claude_code.llm_request')
    expect(span.startTimeUnixNano).toBe(`${START + 10_000}000000`)
  })
})

describe('a slash command', () => {
  test('that asks no model goes on untouched, and is sent as an interaction with its prompt row\'s ids', withKey, async ($, on) => {
    const { clock, posts } = world(on)
    const result = await $.command.run({ command: 'usage', args: '' } as never)
    expect(result).toEqual({ text: 'Total cost: $0.00' })
    await row($, 'user_prompt', { prompt: '/cost', prompt_length: '5' }, INTERACTION)
    await clock.advance(5_000)
    const [i] = spans(posts).filter(s => s.name === 'claude_code.interaction')
    expect(i).toEqual(expect.objectContaining({ traceId: TRACE, spanId: INTERACTION }))
    expect(i!.attrs['user_prompt']).toBe('/cost')
  })
})

describe('a slash command that fails', () => {
  test('fails as it would without the plugin, and is not taken by the next turn', withKey, async ($, on) => {
    const { clock, posts } = world(on)
    await expect($.command.run({ command: 'broken', args: '' } as never)).rejects.toThrow()
    await row($, 'user_prompt', { prompt: '/broken', prompt_length: '7' }, 'f00df00df00df00d')
    await turn($)
    await clock.advance(5_000)
    const interactions = spans(posts).filter(s => s.name === 'claude_code.interaction').map(s => [s.spanId, s.attrs['user_prompt'], s.attrs['interaction.sequence']])
    expect(interactions).toEqual([['f00df00df00df00d', '/broken', 1], [INTERACTION, 'go', 2]])
  })
})

describe('without a key', () => {
  test('nothing is rebuilt or sent, and every event goes on as it was', async ($, on) => {
    const { clock, posts, rig } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    const { step, tool } = await turn($)
    await clock.advance(70_000)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(posts).toEqual([])
    expect(step).toEqual(expect.objectContaining({ stopReason: 'tool_use' }))
    expect((tool as { result: { stdout: string } }).result.stdout).toBe('hi')
    expect(rig.rows.length).toBe(4)
  })
})

describe('each signal on its own path', () => {
  const LOGS_URL = 'https://collector.dev.mainwave.com/v1/logs'
  const count = (posts: readonly Post[], url: string) => posts.filter(p => p.url === url).length

  for (const [name, status] of [['has no traces path (404)', 404], ['is busy on its traces path (503)', 503]] as const) {
    test(`a collector that ${name} holds back neither the log rows nor the metrics`, withKey, async ($, on) => {
      const { clock, posts } = world(on, { reply: (_n, p) => (p.url === TRACES_URL ? { status } : { status: 200 }) })
      await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
      await turn($)
      await clock.advance(5_000)
      for (let i = 0; i < 3; i++) {
        await row($, 'tool_result', { tool_name: 'Bash', tool_use_id: `later_${i}`, success: 'true' }, INTERACTION)
        await clock.advance(5_000)
      }
      await clock.advance(60_000)
      expect(count(posts, LOGS_URL)).toBeGreaterThanOrEqual(4)
      expect(count(posts, METRICS_URL)).toBe(1)
      // A missing path is not asked again this load; a busy one is, after its own wait.
      if (status === 404) expect(count(posts, TRACES_URL)).toBe(1)
      else expect(count(posts, TRACES_URL)).toBeGreaterThan(1)
    })
  }

  test('a metric batch whose request may have landed (it timed out) is dropped, never sent twice', withKey, async ($, on) => {
    const { clock, posts } = world(on, { reply: (_n, p) => (p.url === METRICS_URL && posts.filter(x => x.url === METRICS_URL).length === 1 ? 'hang' : { status: 200 }) })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($)
    await clock.advance(60_000)
    await clock.advance(15_000)
    await clock.advance(60_000)
    expect(count(posts, METRICS_URL)).toBe(1)
  })

  test('a stored record that cannot be written as a request is dropped, and the rest go on', withKey, async ($, on) => {
    const resources = [JSON.stringify({ 'service.name': 'claude-code' })]
    const bad = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'claude_code.tool', startMs: 1, endMs: 2, attributes: {}, events: [null] }
    const box = { v: 2, updatedAt: START - 120_000, resources, items: [{ s: 'traces', r: 0, d: bad }, { s: 'logs', r: 0, d: { event: 'api_request', loggedAt: LOGGED_AT, attributes: { 'event.sequence': 1 } } }] }
    const { clock, posts } = world(on, { store: { 'outbox:gone': box } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(5_000)
    await clock.advance(5_000)
    expect(count(posts, TRACES_URL)).toBe(0)
    expect(count(posts, LOGS_URL)).toBe(1)
  })
})
