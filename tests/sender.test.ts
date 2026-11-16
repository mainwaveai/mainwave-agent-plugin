// End to end: the plugin's copy of each row to the dev collector, driven through $.telemetry.log and a clock the test moves, with the
// engine beneath (settings, environment, store, network) played by rig.ts and the kit's mocks.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { boot, DEV_URL, IDEMPOTENCY_KEY, KEY, keyOption, log, LOGGED_AT, memoryStore, network, ORG, ownedKeys, records, STAMPED, type Layers, type Post, type Reply } from './rig.ts'

const withKey = { options: { devIngestKey: KEY } }
const SPAN = { traceId: '7d2fa3029813d71c9ad4ef05815fa7d5', spanId: 'e4a76fb0fca33a96', traceFlags: 1 }
const START = 1_800_000_000_000
const TICK = 5_000

const row = (seq: number, extra: Record<string, unknown> = {}) => ({
  'organization.id': ORG,
  'session.id': 's-1',
  'event.name': 'api_request',
  'event.sequence': seq,
  'event.timestamp': LOGGED_AT,
  cost_usd: 0.0001241,
  input_tokens: 1171,
  ...extra,
})

/** The world beneath the plugin for a copying test: a clock at START, a store, the network, and the rig. */
function world(on: On, opts: { layers?: Layers; env?: Record<string, string>; reply?: (n: number) => Reply; store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: START })
  const { sets, data } = memoryStore(on, opts.store ?? {})
  // The log rows' copy alone: the spans and metrics rebuilt beside them have tests of their own.
  const posts = network(on, opts.reply, url => url === DEV_URL)
  const rig = boot(on, { entrypoint: 'cli', layers: opts.layers, env: opts.env })
  // The engine's own steps beneath the plugin's session hooks, and its debug log.
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  return { clock, posts, rig, sets, data, logs }
}

/** Logs one collector row with its span, as Claude Code raises it. */
async function logRow($: Engine, rig: ReturnType<typeof boot>, attributes: Record<string, unknown>, event = 'api_request') {
  const before = rig.rows.length
  await $.telemetry.log({ to: 'collector', event, attributes, loggedAt: LOGGED_AT, span: SPAN } as never)
  if (rig.rows.length !== before + 1) throw new Error('the exporter did not get the row')
  return rig.rows[rig.rows.length - 1]!.attributes
}

/** The `event.sequence` of each log row an outbox the store holds keeps, in order. */
const outboxSequences = (box: unknown) => {
  const b = box as { v: number; items: { s: string; d: { attributes: Record<string, unknown> } }[] }
  expect(b.v).toBe(3)
  return b.items.filter(i => i.s === 'logs').map(i => i.d.attributes['event.sequence'])
}

const sentSequences = (posts: readonly Post[]) => posts.flatMap(p => (p.url === DEV_URL ? records(p).map(r => r.attributes['event.sequence']) : []))

describe('without a key, rows that name no email', () => {
  test('are held back: the plugin sends nothing and writes nothing', async ($, on) => {
    const { clock, posts, rig, sets } = world(on)
    await logRow($, rig, row(1))
    await clock.advance(10 * TICK)
    expect(posts).toEqual([])
    expect(sets).toEqual([])
    expect(rig.rows[0]!.attributes['mainwave.telemetry.route']).toBe('exporter')
  })
})

describe('the copy', () => {
  test("the exporter's row goes on as it would without a key; the copy waits for the timer", withKey, async ($, on) => {
    const { clock, posts, rig } = world(on)
    const a = await logRow($, rig, row(1))
    expect(ownedKeys(a)).toEqual(STAMPED)
    expect(a['mainwave.telemetry.route']).toBe('exporter')
    expect(posts).toEqual([])
    await clock.advance(TICK)
    expect(posts.length).toBe(1)
  })

  test('goes to the dev collector alone, as OTLP/JSON, with the key as a bearer token', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on)
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    expect(posts.map(p => p.url)).toEqual([DEV_URL])
    expect(posts[0]!.method).toBe('POST')
    expect(posts[0]!.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'idempotency-key': expect.stringMatching(IDEMPOTENCY_KEY) })
  })

  test("each record is the exporter's row: same attributes, time, event and span, with route plugin", withKey, async ($, on) => {
    const { clock, posts, rig } = world(on)
    const exported = await logRow($, rig, row(39, { model: 'claude-haiku-5-5', 'anthropic.custom_base_url': false, tags: ['a', 'b'] }))
    await clock.advance(TICK)
    const [r] = records(posts[0]!)
    expect(r!.body).toBe('claude_code.api_request')
    expect(r!.time).toBe(`${Date.parse(LOGGED_AT)}000000`)
    expect(r!.traceId).toBe(SPAN.traceId)
    expect(r!.spanId).toBe(SPAN.spanId)
    expect(r!.attributes).toEqual({ ...exported, 'mainwave.telemetry.route': 'plugin' })
    expect(r!.attributes['event.sequence']).toBe(39)
    expect(r!.attributes['cost_usd']).toBe(0.0001241)
  })

  test("the resource is the exporter's: service name and version, then OTEL_RESOURCE_ATTRIBUTES", withKey, async ($, on) => {
    const env = { OTEL_RESOURCE_ATTRIBUTES: 'mainwave.source=coding_agent.claude_code,deployment.environment=production' }
    const { clock, posts, rig } = world(on, { env })
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    const [r] = records(posts[0]!)
    expect(r!.resource).toEqual({ 'service.name': 'claude-code', 'service.version': '2.1.322', 'mainwave.source': 'coding_agent.claude_code', 'deployment.environment': 'production' })
    expect(r!.scope).toEqual({ name: 'com.anthropic.claude_code.events', version: '2.1.322' })
  })

  test('a row with no organization is copied too, carrying only its route', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on)
    const a = await logRow($, rig, { 'session.id': 's-1', 'event.sequence': 1 })
    expect(ownedKeys(a)).toEqual([])
    await clock.advance(TICK)
    const [r] = records(posts[0]!)
    expect(ownedKeys(r!.attributes)).toEqual(['mainwave.telemetry.route'])
  })

  test('rows go in batches of at most 200, every row once, in order', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on)
    for (let i = 1; i <= 450; i++) await logRow($, rig, row(i))
    await clock.advance(TICK)
    expect(posts.map(p => records(p).length)).toEqual([200, 200, 50])
    expect(sentSequences(posts)).toEqual(Array.from({ length: 450 }, (_, i) => i + 1))
  })

  test("a row too big for a batch is not copied; the exporter's goes on", withKey, async ($, on) => {
    const { clock, posts, rig } = world(on)
    const a = await logRow($, rig, row(1, { tool_output: 'x'.repeat(1_100_000) }))
    expect(a['tool_output']).toBeDefined()
    await logRow($, rig, row(2))
    await clock.advance(TICK)
    expect(sentSequences(posts)).toEqual([2])
  })

  test('past 1 MB of queued rows the oldest go first', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on, { reply: n => (n === 1 ? { status: 503 } : { status: 200 }) })
    const big = (i: number) => ({ 'event.sequence': i, padding: 'p'.repeat(100_000) })
    await logRow($, rig, big(1))
    await clock.advance(TICK)
    for (let i = 2; i <= 12; i++) await logRow($, rig, big(i))
    for (let i = 0; i < 6; i++) await clock.advance(TICK)
    const sent = sentSequences(posts.slice(1))
    expect(sent).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  test("the exporter's row never waits on the network", withKey, async ($, on) => {
    const { clock, rig } = world(on, { reply: () => 'hang' })
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    await logRow($, rig, row(2))
    expect(rig.rows.length).toBe(2)
  })
})

describe('retry', () => {
  for (const [name, first] of [['a busy collector (503)', { status: 503 }], ['no network', 'reject'], ['a refused rate (429)', { status: 429 }]] as const) {
    test(`after ${name}, the same rows are sent again, once`, withKey, async ($, on) => {
      const { clock, posts, rig } = world(on, { reply: n => (n === 1 ? first : { status: 200 }) })
      await logRow($, rig, row(1))
      await logRow($, rig, row(2))
      await clock.advance(TICK)
      expect(posts.length).toBe(1)
      await clock.advance(TICK)
      expect(posts.length).toBe(2)
      await clock.advance(4 * TICK)
      expect(posts.length).toBe(2)
      expect(records(posts[1]!).map(r => r.attributes['event.sequence'])).toEqual([1, 2])
    })
  }

  test('a request that never answers is given up after its limit and sent again', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on, { reply: n => (n === 1 ? 'hang' : { status: 200 }) })
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    await clock.advance(10_000)
    await clock.advance(2 * TICK)
    expect(posts.length).toBe(2)
    expect(sentSequences(posts)).toEqual([1, 1])
  })

  test('the wait between tries grows while the collector stays down', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on, { reply: () => ({ status: 503 }) })
    await logRow($, rig, row(1))
    await clock.advance(TICK) // try 1 fails: wait 5 s
    await clock.advance(TICK) // try 2 fails: wait 10 s
    await clock.advance(TICK)
    expect(posts.length).toBe(2)
    await clock.advance(TICK)
    expect(posts.length).toBe(3)
  })

  test('a batch the collector refuses as malformed is dropped; later rows still go', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on, { reply: n => (n === 1 ? { status: 400 } : { status: 200 }) })
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    await logRow($, rig, row(2))
    await clock.advance(TICK)
    expect(sentSequences(posts)).toEqual([1, 2])
    expect(records(posts[1]!).length).toBe(1)
  })

  test('a refused key stops sending for the load and keeps the rows', withKey, async ($, on) => {
    const { clock, posts, rig, sets } = world(on, { reply: () => ({ status: 401 }) })
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    await logRow($, rig, row(2))
    await clock.advance(10 * TICK)
    expect(posts.length).toBe(1)
    expect(outboxSequences(sets.filter(s => s.key.startsWith('outbox:')).at(-1)!.value)).toEqual([1, 2])
  })
})

describe('the idempotency key', () => {
  const keyOf = (p: Post) => p.headers['idempotency-key']!
  const seqs = (p: Post) => records(p).map(r => r.attributes['event.sequence'])
  const resources = [JSON.stringify({ 'service.name': 'claude-code', 'service.version': '2.1.300' })]
  const kept = (seq: number, b?: number) => ({ s: 'logs', r: 0, ...(b !== undefined ? { b } : {}), d: { event: 'api_request', loggedAt: LOGGED_AT, attributes: row(seq) } })

  test('a batch retried after a timeout is the same rows under the same key, though more were queued meanwhile', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on, { reply: n => (n === 1 ? 'hang' : { status: 200 }) })
    await logRow($, rig, row(1))
    await logRow($, rig, row(2))
    await clock.advance(TICK)
    await logRow($, rig, row(3))
    await clock.advance(10_000)
    await clock.advance(2 * TICK)
    expect(posts.map(seqs)).toEqual([[1, 2], [1, 2], [3]])
    expect(keyOf(posts[1]!)).toBe(keyOf(posts[0]!))
    expect(keyOf(posts[2]!)).not.toBe(keyOf(posts[0]!))
  })

  test('a batch retried after a 503 is the same rows under the same key; a row queued meanwhile goes in a batch of its own', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on, { reply: n => (n === 1 ? { status: 503 } : { status: 200 }) })
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    await logRow($, rig, row(2))
    await clock.advance(TICK)
    expect(posts.map(seqs)).toEqual([[1], [1], [2]])
    expect(keyOf(posts[1]!)).toBe(keyOf(posts[0]!))
    expect(keyOf(posts[2]!)).not.toBe(keyOf(posts[0]!))
  })

  test('a batch after one that was settled has a new key; every key has the shape the collector takes', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on)
    for (let i = 1; i <= 450; i++) await logRow($, rig, row(i))
    await clock.advance(TICK)
    await logRow($, rig, row(451))
    await clock.advance(TICK)
    expect(posts.map(p => seqs(p).length)).toEqual([200, 200, 50, 1])
    for (const p of posts) expect(keyOf(p)).toMatch(IDEMPOTENCY_KEY)
    expect(new Set(posts.map(keyOf)).size).toBe(4)
  })

  test('the outbox keeps the key of a batch still in flight at session end, each key once', withKey, async ($, on) => {
    const { clock, posts, rig, data } = world(on, { reply: () => 'hang' })
    await logRow($, rig, row(1))
    await logRow($, rig, row(2))
    await clock.advance(TICK)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    const box = [...data.entries()].find(([k]) => k.startsWith('outbox:'))![1] as { v: number; batches: string[]; items: { s: string; b?: number }[] }
    expect(box.v).toBe(3)
    expect(box.batches).toEqual([keyOf(posts[0]!)])
    expect(box.items.filter(i => i.s === 'logs').map(i => i.b)).toEqual([0, 0])
  })

  test('an outbox taken over sends the same batches under the same keys, and adds no new row to them', withKey, async ($, on) => {
    const k1 = '5f0c3f8e-2b7a-4d2c-9a51-1d7c4b2e8f01'
    const k2 = 'a3b1c9d7-6e5f-4a2b-8c1d-0e9f8a7b6c5d'
    const box = { v: 3, updatedAt: START - 120_000, resources, batches: [k1, k2], items: [kept(7, 0), kept(8, 0), kept(10, 1)] }
    const { clock, posts, rig } = world(on, { store: { 'outbox:gone': box } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await logRow($, rig, row(9))
    await clock.advance(TICK)
    expect(posts.map(p => [keyOf(p), seqs(p)])).toEqual([[k1, [7, 8]], [k2, [10]], [expect.stringMatching(IDEMPOTENCY_KEY), [9]]])
    expect([k1, k2]).not.toContain(keyOf(posts[2]!))
  })

  test('a version 2 outbox, with no keys, is still sent: its rows get a new key, kept on the retry', withKey, async ($, on) => {
    const box = { v: 2, updatedAt: START - 120_000, resources, items: [kept(7), kept(8)] }
    const { clock, posts, sets } = world(on, { store: { 'outbox:gone': box }, reply: n => (n === 1 ? { status: 503 } : { status: 200 }) })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(TICK)
    await clock.advance(TICK)
    expect(posts.map(seqs)).toEqual([[7, 8], [7, 8]])
    expect(keyOf(posts[0]!)).toMatch(IDEMPOTENCY_KEY)
    expect(keyOf(posts[1]!)).toBe(keyOf(posts[0]!))
    // Taken over, it is this load's, written as this version's.
    expect((sets.find(s => s.key.startsWith('outbox:') && s.key !== 'outbox:gone')!.value as { v: number }).v).toBe(3)
  })

  test('a stored key of the wrong shape is let go, and its row still goes, under a new key', withKey, async ($, on) => {
    const good = 'c0ffee00-1234-4abc-8def-0123456789ab'
    const box = { v: 3, updatedAt: START - 120_000, resources, batches: ['has a space', 'x'.repeat(120), good, 7], items: [kept(1, 0), kept(2, 1), kept(3, 2), kept(4, 9), kept(5, 3)] }
    const { clock, posts } = world(on, { store: { 'outbox:gone': box } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(TICK)
    expect(posts.map(seqs)).toEqual([[1, 2, 4, 5], [3]])
    expect(keyOf(posts[1]!)).toBe(good)
    expect(keyOf(posts[0]!)).toMatch(IDEMPOTENCY_KEY)
    expect(['has a space', 'x'.repeat(120), good]).not.toContain(keyOf(posts[0]!))
  })
})

describe('across sessions', () => {
  const resume = { id: 's-1' }

  test('session end sends what is queued', withKey, async ($, on) => {
    const { posts, rig } = world(on)
    await logRow($, rig, row(1))
    await logRow($, rig, row(2))
    await $.session.end({ reason: 'other', sessionId: 's-1', resume } as never)
    expect(sentSequences(posts)).toEqual([1, 2])
  })

  test('what session end cannot send is kept in the store, never with the key', withKey, async ($, on) => {
    const { posts, rig, sets, logs } = world(on, { reply: () => ({ status: 503 }) })
    await logRow($, rig, row(1))
    await $.session.end({ reason: 'other', sessionId: 's-1', resume } as never)
    expect(posts.length).toBe(1)
    expect(logs.length).toBe(1)
    // The row's own copy is kept; its request's span and its cost and token points went to their own paths.
    expect(logs[0]).toContain('3 sent, 0 dropped, 1 kept for a later session')
    expect(logs.join('')).not.toContain(KEY)
    expect(outboxSequences(sets.filter(s => s.key.startsWith('outbox:')).at(-1)!.value)).toEqual([1])
    expect(JSON.stringify(sets)).not.toContain(KEY)
  })

  test('after a /clear, the next row starts sending again', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on)
    await logRow($, rig, row(1))
    await $.session.end({ reason: 'clear', sessionId: 's-1', resume } as never)
    await logRow($, rig, row(2, { 'session.id': 's-2' }))
    await clock.advance(TICK)
    expect(sentSequences(posts)).toEqual([1, 2])
  })

  test("an outbox no load has touched for a minute is sent by the next session; a live one is left to its owner", withKey, async ($, on) => {
    const resources = [JSON.stringify({ 'service.name': 'claude-code', 'service.version': '2.1.300' })]
    const box = (updatedAt: number, seq: number) => ({ v: 1, updatedAt, resources, rows: [{ r: 0, event: 'api_request', loggedAt: LOGGED_AT, attributes: row(seq) }] })
    const { clock, posts } = world(on, { store: { 'outbox:gone': box(START - 120_000, 7), 'outbox:live': box(START - 1_000, 8), unrelated: 1 } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(TICK)
    expect(sentSequences(posts)).toEqual([7])
    expect(records(posts[0]!)[0]!.resource['service.version']).toBe('2.1.300')
  })

  test("a later session sends what an outbox kept of each signal to that signal's path", withKey, async ($, on) => {
    const resources = [JSON.stringify({ 'service.name': 'claude-code', 'service.version': '2.1.300' })]
    const span = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'claude_code.tool', startMs: 1, endMs: 2, attributes: { tool_name: 'Bash' } }
    const point = { name: 'claude_code.commit.count', startMs: 1, timeMs: 2, value: 1, attributes: {} }
    const box = { v: 2, updatedAt: START - 120_000, resources, items: [
      { s: 'logs', r: 0, d: { event: 'api_request', loggedAt: LOGGED_AT, attributes: row(7) } },
      { s: 'traces', r: 0, d: span },
      { s: 'metrics', r: 0, d: point },
      { s: 'traces', r: 0, d: { name: 'not a span' } },
      { s: 'elsewhere', r: 0, d: span },
    ] }
    const clock = mock.clock(on, { now: START })
    memoryStore(on, { 'outbox:gone': box })
    const all = network(on)
    boot(on, { entrypoint: 'cli' })
    on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(TICK)
    expect(all.map(p => p.url).sort()).toEqual([DEV_URL, 'https://collector.dev.mainwave.com/v1/metrics', 'https://collector.dev.mainwave.com/v1/traces'])
    const traces = JSON.parse(all.find(p => p.url.endsWith('/traces'))!.body)
    expect(traces.resourceSpans[0].scopeSpans[0].spans.map((x: { spanId: string }) => x.spanId)).toEqual(['b'.repeat(16)])
  })

  test('an outbox of the wrong shape is cleared, not sent', withKey, async ($, on) => {
    const { clock, posts, rig, data } = world(on, { store: { 'outbox:bad': { v: 1, rows: 'x' } } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    expect(sentSequences(posts)).toEqual([1])
    expect(data.has('outbox:bad')).toBe(false)
  })

  test('an outbox a later version wrote is left alone', withKey, async ($, on) => {
    const later = { v: 4, updatedAt: 0, anything: ['new'] }
    const { clock, posts, data } = world(on, { store: { 'outbox:later': later } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(20 * TICK)
    expect(posts).toEqual([])
    expect(data.get('outbox:later')).toEqual(later)
  })

  test("a session a repository refuses takes over no other session's outbox", withKey, async ($, on) => {
    const resources = [JSON.stringify({ 'service.name': 'claude-code' })]
    const gone = { v: 1, updatedAt: START - 120_000, resources, rows: [{ r: 0, event: 'api_request', loggedAt: LOGGED_AT, attributes: row(7) }] }
    const { clock, posts, data } = world(on, { store: { 'outbox:gone': gone }, layers: { local: 'reject' } })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(20 * TICK)
    expect(posts).toEqual([])
    expect(data.get('outbox:gone')).toEqual(gone)
  })

  test('a batch still in flight at session end is kept, so a later session sends it', withKey, async ($, on) => {
    const { clock, rig, data } = world(on, { reply: () => 'hang' })
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume } as never)
    const boxes = [...data.entries()].filter(([k]) => k.startsWith('outbox:')).map(([, v]) => v)
    expect(boxes.flatMap(outboxSequences)).toEqual([1])
  })

  test('after a /clear, rows the end could not send go on being sent, with no new row', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on, { reply: n => (n <= 2 ? { status: 503 } : { status: 200 }) })
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    await $.session.end({ reason: 'clear', sessionId: 's-1', resume } as never)
    await clock.advance(20 * TICK)
    expect(sentSequences(posts).at(-1)).toBe(1)
    expect(posts.length).toBe(3)
  })
})

describe('hostile settings', () => {
  for (const [name, layers] of [
    ["a repository's settings name the key option", { project: keyOption('mw_dev_attacker_key_01') }],
    ["a repository's local settings name it", { local: keyOption('mw_dev_attacker_key_01', 'mainwave@synced') }],
    ["a repository's settings cannot be read", { project: 'reject' }],
  ] as const) {
    test(`${name}: nothing is sent and nothing kept`, withKey, async ($, on) => {
      const { clock, posts, rig, sets } = world(on, { layers: layers as Layers })
      await logRow($, rig, row(1))
      await clock.advance(5 * TICK)
      await logRow($, rig, row(2))
      await clock.advance(5 * TICK)
      expect(posts).toEqual([])
      expect(sets.filter(s => s.key.startsWith('outbox:'))).toEqual([])
      expect(rig.rows.length).toBe(2)
    })
  }

  test("the organization's collector settings are never read or used: the copy goes to dev with the person's key alone", withKey, async ($, on) => {
    const orgEnv = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer org_key_example_0001' }
    const { clock, posts, rig } = world(on, {
      env: orgEnv,
      layers: { policy: { env: orgEnv }, user: { env: orgEnv }, project: { env: { ...orgEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://evil.example.com' } } },
    })
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    expect(posts.map(p => [p.url, p.headers['authorization']])).toEqual([[DEV_URL, `Bearer ${KEY}`]])
    expect(JSON.stringify(posts)).not.toContain('org_key_example_0001')
    expect(rig.envReads.filter(n => n.startsWith('OTEL_EXPORTER_'))).toEqual([])
  })

  test('the key never reaches a row', withKey, async ($, on) => {
    const { clock, posts, rig } = world(on)
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    expect(JSON.stringify(rig.rows)).not.toContain(KEY)
    expect(posts.map(p => p.body).join('')).not.toContain(KEY)
  })
})

describe('the key option', () => {
  test('a key of the wrong shape copies nothing', { options: { devIngestKey: 'has a space' } }, async ($, on) => {
    const { clock, posts, rig } = world(on)
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    expect(posts).toEqual([])
  })

  test("a key pasted with 'Bearer ' in front is sent once, not twice", { options: { devIngestKey: `Bearer ${KEY}` } }, async ($, on) => {
    const { clock, posts, rig } = world(on)
    await logRow($, rig, row(1))
    await clock.advance(TICK)
    expect(posts[0]!.headers['authorization']).toBe(`Bearer ${KEY}`)
  })
})

test('a row with no span is copied without ids', withKey, async ($, on) => {
  const { clock, posts, rig } = world(on)
  await log(rig, $, row(1))
  await clock.advance(TICK)
  const [r] = records(posts[0]!)
  expect(r!.traceId).toBeUndefined()
})
