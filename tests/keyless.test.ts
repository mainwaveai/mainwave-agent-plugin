// End to end: the copy sent without a key (the default), as a session without Mainwave's env block runs. The engine beneath is played by rig.ts and
// the kit's mocks, and the network by keyless ingest's own rules (rig.ts `keylessAnswer`): no Authorization header, the organization
// and email on every record, span and data point, one pair per request.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { whoHash } from '../hooks/sender.ts'
import { boot, CAPTURES_ON, EMAIL, IDEMPOTENCY_KEY, itemAttributes, KEY, keylessAnswer, LOGGED_AT, memoryStore, network, optInOption, ORG, type KeylessAnswer, type Layers, type Post, type Reply } from './rig.ts'

/** No options: the plugin's defaults, so no key, so keyless. */
const keyless = { options: {} }
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

/** A request's span an outbox keeps, with its thinking, as a load whose gate let thinking go queued it. */
const keptThinking = () => ({
  s: 'traces', r: 0,
  d: { name: 'claude_code.llm_request', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), startMs: START - 200_000, endMs: START - 199_000, attributes: { 'organization.id': ORG, 'user.email': EMAIL, 'session.id': 's-0', 'response.thinking': 'An earlier thought.' } },
})

const sequencesOf = (post: Post) => itemAttributes(post).map(a => Number(Object.values(a.find(kv => kv.key === 'event.sequence')?.value ?? {})[0]))
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
      expect(Object.keys(post.headers).map(h => h.toLowerCase())).toEqual(['content-type', 'idempotency-key'])
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
    // The copied rows carry the ids of the span each ran in, as Claude Code's rows do when it traces.
    const rows: Record<string, { traceId?: string; spanId?: string }> = {}
    for (const { post } of seen.filter(s => PATH(s.post.url) === '/v1/logs')) {
      for (const rl of JSON.parse(post.body).resourceLogs) {
        for (const sl of rl.scopeLogs) {
          for (const r of sl.logRecords) rows[r.attributes.find((a: { key: string }) => a.key === 'event.name').value.stringValue] = { traceId: r.traceId, spanId: r.spanId }
        }
      }
    }
    const at = (n: string) => ({ traceId: by(n).traceId, spanId: by(n).spanId })
    expect(rows).toEqual({ user_prompt: at('interaction'), api_request: at('interaction'), tool_decision: at('tool.blocked_on_user'), tool_result: at('interaction') })
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

  test("the session's own refusal (403 email_domain) stops its sending, keeps what was queued, and queues no more", keyless, async ($, on) => {
    const { clock, posts, store, logs } = world(on, { refused: { [ORG]: 'email_domain' }, store: { dataPoints: CAPTURES_ON } })
    await row($, 'user_prompt', { prompt: 'one', prompt_length: '3' })
    await clock.advance(TICK)
    for (let i = 0; i < 20; i++) await row($, 'user_prompt', { prompt: 'two', prompt_length: '3' })
    await clock.advance(5 * TICK)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(posts.length).toBe(1)
    expect(lastOutbox(store.sets)!.items.map(i => i.d.attributes['prompt'])).toEqual(['one'])
    expect(logs.join('')).toContain('20 held back')
  })

  test("records an earlier session kept go through this load's opt-in: thinking goes, and says so, only while the person opts in to it", keyless, async ($, on) => {
    const { clock, posts } = world(on, { store: { 'outbox:old': leftBehind([keptThinking()]) }, layers: { user: optInOption(['response.thinking']) } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await row($, 'user_prompt', { prompt: 'go', prompt_length: '2' })
    await clock.advance(TICK)
    const traces = posts.filter(p => PATH(p.url) === '/v1/traces').map(p => p.body).join('')
    expect(traces).toContain('An earlier thought.')
    expect(traces).toContain('mainwave.telemetry.opt_in')
  })

  test('records an earlier session kept lose what this load does not opt in to', keyless, async ($, on) => {
    const { clock, posts } = world(on, { store: { 'outbox:old': leftBehind([keptThinking()]) } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await row($, 'user_prompt', { prompt: 'go', prompt_length: '2' })
    await clock.advance(TICK)
    const traces = posts.filter(p => PATH(p.url) === '/v1/traces').map(p => p.body)
    expect(traces.length).toBeGreaterThan(0)
    expect(traces.join('')).not.toContain('An earlier thought.')
    expect(traces.join('')).not.toContain('mainwave.telemetry.opt_in')
  })

  test('a session with no outbox to take over reads no settings for it', keyless, async ($, on) => {
    const { rig } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    // The person's own settings, read once per load for the data points they opt in to; no repository's.
    expect(rig.reads).toEqual(['user'])
  })

  test('with every record refused, a tick makes no request and reads no settings', keyless, async ($, on) => {
    const { clock, posts, rig } = world(on, { refused: { [ORG]: 'unclaimed' } })
    await row($, 'user_prompt', { prompt: 'one', prompt_length: '3' })
    await clock.advance(TICK)
    const reads = rig.reads.length
    await row($, 'user_prompt', { prompt: 'two', prompt_length: '3' })
    await clock.advance(5 * TICK)
    expect(posts.length).toBe(1)
    expect(rig.reads.length).toBe(reads)
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

describe('the idempotency key, keyless', () => {
  const keyOf = (p: Post) => p.headers['idempotency-key']!
  const HASH = whoHash(`${ORG} ${EMAIL}`)

  test('the hash is 64-bit FNV-1a, in 16 hex digits', () => {
    expect(whoHash('')).toBe('cbf29ce484222325')
    expect(whoHash('a')).toBe('af63dc4c8601ec8c')
    expect(whoHash(`${ORG} ${EMAIL}`)).toMatch(/^[0-9a-f]{16}$/)
  })

  test("is the batch's stored key, its organization and email's hash in it, the same on a retry", keyless, async ($, on) => {
    const { clock, seen, store } = world(on, { answer: (_a, post) => (seen.length === 1 && PATH(post.url) === '/v1/logs' ? { status: 503 } : undefined) })
    await row($, 'user_prompt', { prompt: 'go', prompt_length: '2' })
    await clock.advance(TICK)
    const box = store.sets.filter(s => s.key.startsWith('outbox:')).at(-1)!.value as { batches: string[] }
    await clock.advance(TICK)
    const logs = seen.filter(s => PATH(s.post.url) === '/v1/logs').map(s => s.post)
    expect(logs.length).toBe(2)
    expect(box.batches.length).toBe(1)
    expect(box.batches[0]!.endsWith(`.${HASH}`)).toBe(true)
    expect(keyOf(logs[0]!)).toBe(box.batches[0])
    expect(keyOf(logs[0]!)).toMatch(IDEMPOTENCY_KEY)
    expect(keyOf(logs[1]!)).toBe(keyOf(logs[0]!))
  })

  test('a batch formed keyless and taken over keyless goes under its stored key, with no second hash', keyless, async ($, on) => {
    const k = `5f0c3f8e-2b7a-4d2c-9a51-1d7c4b2e8f01.${HASH}`
    const box = { ...leftBehind([keptRow(ORG, EMAIL, 1), keptRow(ORG, EMAIL, 2)].map(i => ({ ...i, b: 0 }))), v: 3, batches: [k] }
    const { clock, seen } = world(on, { store: { 'outbox:old': box } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(TICK)
    const logs = seen.filter(s => PATH(s.post.url) === '/v1/logs')
    expect(logs.map(s => [keyOf(s.post), s.answer.status])).toEqual([[k, 200]])
  })

  test('a batch formed with a key over two people goes keyless as one batch each, each under a key of its own', keyless, async ($, on) => {
    const k = '5f0c3f8e-2b7a-4d2c-9a51-1d7c4b2e8f01'
    const box = { ...leftBehind([keptRow(ORG_B, EMAIL_B, 1), keptRow(ORG, EMAIL, 2), keptRow(ORG_B, EMAIL_B, 3)].map(i => ({ ...i, b: 0 }))), v: 3, batches: [k] }
    const { clock, seen } = world(on, { store: { 'outbox:old': box } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(TICK)
    const logs = seen.filter(s => PATH(s.post.url) === '/v1/logs')
    expect(logs.map(s => s.answer.status)).toEqual([200, 200])
    expect(logs.map(s => emailsOf(s.post))).toEqual([[EMAIL_B], [EMAIL]])
    expect(logs.map(s => itemAttributes(s.post).length)).toEqual([2, 1])
    const [a, b] = logs.map(s => keyOf(s.post))
    expect(a).toBe(`${k}.${whoHash(`${ORG_B} ${EMAIL_B}`)}`)
    expect(b).toBe(`${k}.${HASH}`)
    for (const key of [a, b]) expect(key).toMatch(IDEMPOTENCY_KEY)
  })

  test('a stored key of 111 characters goes keyless with its hash at exactly 128; one of 112 is let go and its record goes under a new key', keyless, async ($, on) => {
    const k111 = 'a'.repeat(111)
    // Not a hex digit, so no fresh key can start with it.
    const k112 = 'g'.repeat(112)
    const box = { ...leftBehind([{ ...keptRow(ORG, EMAIL, 1), b: 0 }, { ...keptRow(ORG, EMAIL, 2), b: 1 }]), v: 3, batches: [k111, k112] }
    const { clock, seen } = world(on, { store: { 'outbox:old': box } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(TICK)
    const logs = seen.filter(s => PATH(s.post.url) === '/v1/logs')
    expect(logs.map(s => s.answer.status)).toEqual([200, 200])
    expect(logs.map(s => sequencesOf(s.post))).toEqual([[1], [2]])
    const [a, b] = logs.map(s => keyOf(s.post))
    expect(a).toBe(`${k111}.${HASH}`)
    expect(a!.length).toBe(128)
    expect(b).toMatch(IDEMPOTENCY_KEY)
    expect(b).not.toContain(k112.slice(0, 8))
    expect(b!.endsWith(`.${HASH}`)).toBe(true)
  })

  test('past the queue caps, a batch formed with a key over two people loses only the oldest record; the rest go under new keys', keyless, async ($, on) => {
    const k = '5f0c3f8e-2b7a-4d2c-9a51-1d7c4b2e8f01'
    const pad = 'x'.repeat(400_000)
    const big = (org: string, email: string, seq: number) => {
      const r = keptRow(org, email, seq)
      return { ...r, b: 0, d: { ...r.d, attributes: { ...r.d.attributes, pad } } }
    }
    const box = { ...leftBehind([big(ORG_B, EMAIL_B, 1), big(ORG, EMAIL, 2), big(ORG_B, EMAIL_B, 3)]), v: 3, batches: [k] }
    const { clock, seen } = world(on, { store: { 'outbox:old': box } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(TICK)
    const logs = seen.filter(s => PATH(s.post.url) === '/v1/logs')
    expect(logs.map(s => s.answer.status)).toEqual([200, 200])
    expect(logs.map(s => emailsOf(s.post))).toEqual([[EMAIL], [EMAIL_B]])
    expect(logs.map(s => itemAttributes(s.post).length)).toEqual([1, 1])
    const [a, b] = logs.map(s => keyOf(s.post))
    expect(a!.startsWith(k)).toBe(false)
    expect(b!.startsWith(k)).toBe(false)
    expect(a!.endsWith(`.${HASH}`)).toBe(true)
    expect(b!.endsWith(`.${whoHash(`${ORG_B} ${EMAIL_B}`)}`)).toBe(true)
  })
})

describe('the key option', () => {
  test('unset, the copy goes keyless with no option at all', async ($, on) => {
    const { seen } = world(on)
    await turn($)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(seen.length).toBeGreaterThan(0)
    for (const { post, answer } of seen) {
      expect(Object.keys(post.headers).map(h => h.toLowerCase())).toEqual(['content-type', 'idempotency-key'])
      expect(answer.status).toBe(200)
    }
  })

  test('a key of the wrong shape sends nothing, keyless or not, and the debug log says why without the value', { options: { devIngestKey: 'has a space' } }, async ($, on) => {
    const { clock, posts, logs } = world(on)
    await turn($)
    await clock.advance(3 * TICK)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(posts).toEqual([])
    expect(logs.join('')).toContain('copy off: the devIngestKey option holds a key of the wrong shape')
    expect(logs.join('')).not.toContain('has a space')
  })

  test('set, the key is used instead: a bearer token, and records with no email go as well', { options: { devIngestKey: KEY } }, async ($, on) => {
    // The collector's key path: any key is taken here.
    const { clock, posts } = world(on, { answer: () => ({ status: 200 }) })
    await row($, 'api_request', { cost_usd: 0.1 }, { 'organization.id': ORG, 'session.id': 's-1' })
    await clock.advance(TICK)
    const logs = posts.filter(p => PATH(p.url) === '/v1/logs')
    expect(logs.length).toBe(1)
    expect(logs[0]!.headers['authorization']).toBe(`Bearer ${KEY}`)
  })

  test("a repository's settings that name the key stop the copy, keyless included", keyless, async ($, on) => {
    const { clock, posts } = world(on, { layers: { project: { pluginConfigs: { mainwave: { options: { devIngestKey: 'mw_dev_attacker_key_01' } } } } } })
    await turn($)
    await clock.advance(3 * TICK)
    expect(posts).toEqual([])
  })
})
