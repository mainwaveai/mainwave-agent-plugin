// End to end: the copy sent without a key, as a session without Mainwave's env block runs. The engine beneath is played by rig.ts and
// the kit's mocks, and the network by keyless ingest's own rules (rig.ts `keylessAnswer`): no Authorization header, the organization
// and email on every record, span and data point, one pair per request.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { boot, EMAIL, itemAttributes, KEY, keylessAnswer, LOGGED_AT, memoryStore, network, ORG, type KeylessAnswer, type Layers, type Post, type Reply } from './rig.ts'

const keyless = { options: { devKeyless: true } }
const START = 1_800_000_000_000
const TICK = 5_000
/** Another organization and a person in it, whose records an earlier session left behind. */
const ORG_B = '0f8fad5b-d9cb-469f-a165-70867728950e'
const EMAIL_B = 'other@example.org'
const COMMON = { 'organization.id': ORG, 'user.email': EMAIL, 'user.id': 'device-1', 'session.id': 's-1', 'anthropic.provider': 'firstParty' }
const USAGE = { input_tokens: 1201, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const PATH = (url: string) => new URL(url).pathname

type Seen = { post: Post; answer: KeylessAnswer }

/**
 * The world without Mainwave's env block: Claude Code neither traces nor exports, its rows name no span, and the dev collector answers
 * as keyless ingest does. `answer` overrides it for a request.
 */
function world(on: On, opts: { refused?: Record<string, 'unclaimed' | 'email_domain'>; answer?: (a: KeylessAnswer, post: Post) => Reply | undefined; store?: Record<string, unknown>; layers?: Layers } = {}) {
  const clock = mock.clock(on, { now: START })
  const store = memoryStore(on, opts.store)
  const seen: Seen[] = []
  const posts = network(on, (_n, post) => {
    const answer = keylessAnswer(post, opts.refused)
    seen.push({ post, answer })
    return opts.answer?.(answer, post) ?? { status: answer.status, text: answer.text }
  })
  const rig = boot(on, { entrypoint: 'cli', layers: opts.layers, env: { OTEL_RESOURCE_ATTRIBUTES: 'mainwave.source=coding_agent.claude_code' } })
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: 'ok' }) as never)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'tool_use', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
  })
  on('tool.call', () => ({ result: { stdout: 'hi', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }) as never)
  return { clock, posts, seen, rig, store, logs }
}

/** Logs one collector row as Claude Code raises it without the beta: no span. */
async function row($: Engine, event: string, attributes: Record<string, unknown>, common: Record<string, unknown> = COMMON) {
  await $.telemetry.log({ to: 'collector', event, loggedAt: LOGGED_AT, attributes: { ...common, 'event.name': event, 'event.sequence': 1, ...attributes } } as never)
}

/** One main-loop turn: a prompt, a request that calls Bash, the call with its decision and result rows, and the turn's end. */
async function turn($: Engine) {
  await row($, 'user_prompt', { prompt: 'go', prompt_length: '2' })
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1 } as never)
  while (!(await stream.next()).done) {
    // Read to its end, as the engine does.
  }
  await row($, 'api_request', {
    model: 'claude-haiku-5-5', input_tokens: 1201, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.25,
    duration_ms: 10, ttft_ms: 4, request_id: 'req_1', speed: 'normal', query_source: 'sdk', effort: 'medium',
  })
  await $.tool.call({ tool: 'Bash', command: 'echo hi', description: 'x', tool_use_id: 'toolu_1' } as never)
  await row($, 'tool_decision', { decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_1' })
  await row($, 'tool_result', { tool_name: 'Bash', tool_use_id: 'toolu_1', success: 'true' })
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 40, isAborted: false, reason: 'answer' } as never)
}

/** A log row as an outbox keeps it, for the given organization and email. */
const keptRow = (org: string, email: string, seq: number) => ({ s: 'logs', r: 0, d: { event: 'api_request', loggedAt: LOGGED_AT, attributes: { 'organization.id': org, 'user.email': email, 'session.id': 's-0', 'event.name': 'api_request', 'event.sequence': seq } } })
/** An outbox an earlier session left a minute and more ago, so this session takes it over. */
const leftBehind = (items: unknown[]) => ({ v: 2, updatedAt: START - 120_000, resources: [JSON.stringify({ 'service.name': 'claude-code' })], items })

const emailsOf = (post: Post) => [...new Set(itemAttributes(post).map(a => a.find(kv => kv.key === 'user.email')?.value['stringValue']))]
const lastOutbox = (sets: { key: string; value: unknown }[]) => sets.filter(s => s.key.startsWith('outbox:')).at(-1)?.value as { items: { d: { attributes: Record<string, unknown> } }[] } | undefined

describe('a session without the env block, sending keyless', () => {
  test('its logs, spans and metrics reach all three paths with no Authorization header, each request one organization and email', keyless, async ($, on) => {
    const { seen } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(new Set(seen.map(s => PATH(s.post.url)))).toEqual(new Set(['/v1/logs', '/v1/traces', '/v1/metrics']))
    for (const { post, answer } of seen) {
      expect(Object.keys(post.headers).map(h => h.toLowerCase())).toEqual(['content-type'])
      expect(answer).toEqual(expect.objectContaining({ status: 200, identity: `${ORG} ${EMAIL}` }))
    }
  })

  test('its spans make one trace per turn: the interaction the root, the request and the call its children, the decision and the run the call\'s', keyless, async ($, on) => {
    const { seen } = world(on)
    await turn($)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    const spans: { name: string; traceId: string; spanId: string; parentSpanId?: string }[] = []
    for (const { post } of seen.filter(s => PATH(s.post.url) === '/v1/traces')) {
      for (const rs of JSON.parse(post.body).resourceSpans) for (const ss of rs.scopeSpans) spans.push(...ss.spans)
    }
    const by = (n: string) => spans.find(s => s.name === `claude_code.${n}`)!
    expect(spans.map(s => s.name).sort()).toEqual(['claude_code.interaction', 'claude_code.llm_request', 'claude_code.tool', 'claude_code.tool.blocked_on_user', 'claude_code.tool.execution'])
    expect(by('interaction').parentSpanId).toBeFalsy()
    expect(new Set(spans.map(s => s.traceId))).toEqual(new Set([by('interaction').traceId]))
    expect(by('llm_request').parentSpanId).toBe(by('interaction').spanId)
    expect(by('tool').parentSpanId).toBe(by('interaction').spanId)
    expect(by('tool.blocked_on_user').parentSpanId).toBe(by('tool').spanId)
    expect(by('tool.execution').parentSpanId).toBe(by('tool').spanId)
  })

  test('records that name no organization and email are held back: never sent, never kept', keyless, async ($, on) => {
    const { clock, posts, rig, store, logs } = world(on)
    // A session on an API key or a cloud provider: no organization, no email; or an organization alone, from OTEL_RESOURCE_ATTRIBUTES.
    await row($, 'api_request', { cost_usd: 0.1 }, { 'session.id': 's-1' })
    await row($, 'api_request', { cost_usd: 0.1 }, { 'organization.id': ORG, 'session.id': 's-1' })
    await row($, 'api_request', { cost_usd: 0.1 }, { ...COMMON, 'kiro.user.email': 'someone@example.com' })
    await clock.advance(3 * TICK)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(rig.rows.length).toBe(3)
    expect(posts).toEqual([])
    expect(lastOutbox(store.sets)?.items ?? []).toEqual([])
    expect(logs.join('')).toContain('held back (no organization and email)')
  })

  test('records an earlier session kept go in requests of their own organization and email, never mixed', keyless, async ($, on) => {
    const { clock, seen } = world(on, { store: { 'outbox:old': leftBehind([keptRow(ORG_B, EMAIL_B, 1), keptRow(ORG, EMAIL, 2), keptRow(ORG_B, EMAIL_B, 3)]) } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await row($, 'user_prompt', { prompt: 'go', prompt_length: '2' })
    await clock.advance(TICK)
    const logs = seen.filter(s => PATH(s.post.url) === '/v1/logs')
    expect(logs.map(s => s.answer.status)).toEqual([200, 200])
    expect(logs.map(s => emailsOf(s.post))).toEqual([[EMAIL_B], [EMAIL]])
    expect(logs.map(s => itemAttributes(s.post).length)).toEqual([2, 2])
  })

  test('a refused organization (403 unclaimed) is not sent again this load and its records are kept; another goes on', keyless, async ($, on) => {
    const { clock, seen, store } = world(on, { refused: { [ORG_B]: 'unclaimed' }, store: { 'outbox:old': leftBehind([keptRow(ORG_B, EMAIL_B, 1)]) } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await row($, 'user_prompt', { prompt: 'one', prompt_length: '3' })
    await clock.advance(TICK)
    await row($, 'user_prompt', { prompt: 'two', prompt_length: '3' })
    await clock.advance(5 * TICK)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    const logs = seen.filter(s => PATH(s.post.url) === '/v1/logs')
    expect(logs.filter(s => s.answer.status === 403).length).toBe(1)
    expect(logs.filter(s => s.answer.status === 200).flatMap(s => itemAttributes(s.post)).length).toBe(2)
    expect(lastOutbox(store.sets)!.items.map(i => i.d.attributes['user.email'])).toEqual([EMAIL_B])
  })

  test("the session's own refusal (403 email_domain) stops its sending and keeps its records", keyless, async ($, on) => {
    const { clock, posts, store } = world(on, { refused: { [ORG]: 'email_domain' } })
    await row($, 'user_prompt', { prompt: 'one', prompt_length: '3' })
    await clock.advance(TICK)
    await row($, 'user_prompt', { prompt: 'two', prompt_length: '3' })
    await clock.advance(5 * TICK)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(posts.length).toBe(1)
    expect(lastOutbox(store.sets)!.items.length).toBe(2)
  })

  test("a request refused as malformed (400) drops that organization and email's batch alone", keyless, async ($, on) => {
    const { clock, seen } = world(on, {
      store: { 'outbox:old': leftBehind([keptRow(ORG_B, EMAIL_B, 1)]) },
      answer: a => (a.identity === `${ORG_B} ${EMAIL_B}` ? { status: 400, text: '{"error":"refused in test"}' } : undefined),
    })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await row($, 'user_prompt', { prompt: 'go', prompt_length: '2' })
    await clock.advance(3 * TICK)
    const logs = seen.filter(s => PATH(s.post.url) === '/v1/logs')
    expect(logs.map(s => emailsOf(s.post))).toEqual([[EMAIL_B], [EMAIL]])
  })

  test('any other refusal (a 403 that names no reason) stops sending for the load', keyless, async ($, on) => {
    const { clock, posts } = world(on, { store: { 'outbox:old': leftBehind([keptRow(ORG_B, EMAIL_B, 1)]) }, answer: () => ({ status: 403, text: '{"error":"forbidden"}' }) })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await row($, 'user_prompt', { prompt: 'go', prompt_length: '2' })
    await clock.advance(5 * TICK)
    expect(posts.length).toBe(1)
  })
})

describe('the keyless option', () => {
  test('off, with no key: nothing is sent', async ($, on) => {
    const { clock, posts } = world(on)
    await turn($)
    await clock.advance(3 * TICK)
    expect(posts).toEqual([])
  })

  test('with a key set too, the key wins: a bearer token, and records with no email go as well', { options: { devKeyless: true, devIngestKey: KEY } }, async ($, on) => {
    const { clock, posts } = world(on)
    await row($, 'api_request', { cost_usd: 0.1 }, { 'organization.id': ORG, 'session.id': 's-1' })
    await clock.advance(TICK)
    const logs = posts.filter(p => PATH(p.url) === '/v1/logs')
    expect(logs.length).toBe(1)
    expect(logs[0]!.headers['authorization']).toBe(`Bearer ${KEY}`)
  })

  test("a repository's settings that name it stop the copy", keyless, async ($, on) => {
    const { clock, posts } = world(on, { layers: { project: { pluginConfigs: { mainwave: { options: { devKeyless: true } } } } } })
    await turn($)
    await clock.advance(3 * TICK)
    expect(posts).toEqual([])
  })
})
