// The engine beneath the plugin for the end-to-end tests. Not a test file: the runner loads only *.test.ts.
//
// Written independently of hooks/: it imports nothing from the plugin, so a change to the plugin's rules can never also change what
// the tests expect.

import type { On } from 'claude-code'

/** Any customer's Claude organization, and another account in it (arbitrary IDs). */
export const ORG = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
export const ACCOUNT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
export const EMAIL = 'dev@example.com'
export const DEVICE = '9b2c8f0e4d1a7c3b5e6f8a9d0c1b2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d'
export const LOGGED_AT = '2026-11-12T00:00:00.000Z'

/** Every key the plugin may put on a row, with the shape its value must have. */
export const CONTRACT: Record<string, (v: string) => boolean> = {
  'mainwave.mod.name': v => v === 'mainwave',
  'mainwave.mod.version': v => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v),
  'mainwave.mod.entrypoint': v => /^[a-z0-9_-]+$/.test(v),
  'mainwave.telemetry.route': v => v === 'exporter' || v === 'plugin',
}
export const STAMPED = Object.keys(CONTRACT).sort()
export const isOwned = (k: string) => k.startsWith('mainwave.mod.') || k.startsWith('mainwave.telemetry.')

/** A settings layer as the test answers it: an object, or `reject` for a read that fails. */
export type Answer = Record<string, unknown> | 'reject'
export type Layers = Partial<Record<'policy' | 'flag' | 'user' | 'project' | 'local', Answer>>
export type Rig = { rows: { event: string; attributes: Record<string, unknown> }[]; reads: string[] }

/** The plugin's dev key option in a settings layer, under the given plugin id. */
export const keyOption = (value: unknown, id = 'mainwave@mainwave'): Record<string, unknown> => ({ pluginConfigs: { [id]: { options: { devIngestKey: value } } } })

/** A dev ingest key, as a person would set it. */
export const KEY = 'mw_dev_example_key_0001'
/** Where the copy may go, and nowhere else. */
export const DEV_URL = 'https://collector.dev.mainwave.com/v1/logs'
/** The collector's shape for an `idempotency-key` header: 1 to 128 of these characters. */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/

/** Hooks that stand for the engine: settings layers, the environment, and the collector, which records each row it receives. */
export function boot(on: On, opts: { layers?: Layers; entrypoint?: string; env?: Record<string, string> } = {}): Rig & { envReads: string[] } {
  const rig: Rig & { envReads: string[] } = { rows: [], reads: [], envReads: [] }
  on('settings.read', async (_$, e) => {
    const source = String((e as { source?: string }).source)
    rig.reads.push(source)
    const answer = (opts.layers as Record<string, Answer | undefined> | undefined)?.[source] ?? {}
    if (answer === 'reject') throw new Error(`settings.read ${source} refused in test`)
    return { value: answer } as never
  })
  on('env.get', async (_$, e) => {
    const name = (e as unknown as { name: string }).name
    rig.envReads.push(name)
    return { value: name === 'CLAUDE_CODE_ENTRYPOINT' ? opts.entrypoint : opts.env?.[name] } as never
  })
  on('session.version', async () => ({ value: { version: '2.1.322', base: '2.1.322' } }) as never)
  on('telemetry.log', async (_$, e) => {
    const row = e as unknown as { event: string; attributes: Record<string, unknown> }
    rig.rows.push({ event: row.event, attributes: { ...row.attributes } })
    return { value: undefined } as never
  })
  return rig
}

/** Records each value the plugin writes to its `identity` in `$.state`, then lets the kit store it. */
export function watchIdentity(on: On): unknown[] {
  const writes: unknown[] = []
  on('state.set', (_$, e, next) => {
    const w = e as unknown as { plugin: string; key: string; value: unknown }
    if (w.plugin === 'mainwave' && w.key === 'identity') writes.push(w.value)
    return next(e)
  })
  return writes
}

type Engine = { telemetry: { log: (a: never) => Promise<unknown> } }

/** Logs one collector row and answers its attributes as the collector received them. */
export async function log(rig: Rig, $: Engine, attributes: Record<string, unknown>, event = 'api_request') {
  const before = rig.rows.length
  await $.telemetry.log({ to: 'collector', event, attributes, loggedAt: LOGGED_AT } as never)
  if (rig.rows.length !== before + 1) throw new Error(`expected exactly one delivered row, got ${rig.rows.length - before}`)
  return rig.rows[rig.rows.length - 1]!.attributes
}

/** The owned keys on a row, sorted. */
export const ownedKeys = (attributes: Record<string, unknown>) => Object.keys(attributes).filter(isOwned).sort()

/** Why the row's owned keys break the contract; empty when they keep it. */
export function contractViolations(attributes: Record<string, unknown>): string[] {
  const bad: string[] = []
  for (const key of ownedKeys(attributes)) {
    const rule = CONTRACT[key]
    const value = attributes[key]
    if (rule === undefined) bad.push(`unknown owned key ${key}`)
    else if (typeof value !== 'string' || !rule(value)) bad.push(`${key}=${JSON.stringify(value)} fails its shape`)
  }
  return bad
}

/** One request the plugin made, as the network received it. */
export type Post = { url: string; method?: string; headers: Record<string, string>; body: string }
/** How the network answers the nth request (1-based): a status, `reject` (no network), or `hang` (no answer). */
export type Reply = { status: number; text?: string } | 'reject' | 'hang'

/**
 * The network beneath the plugin: records every request and answers each as `reply` says (200 when not given). With `only`, a
 * request to any other URL is answered 200 and kept in `others` instead, so `posts` and `reply`'s count see the named URLs alone.
 */
export function network(on: On, reply: (n: number, post: Post) => Reply = () => ({ status: 200 }), only?: (url: string) => boolean): Post[] & { others: Post[] } {
  const posts = Object.assign([] as Post[], { others: [] as Post[] })
  on('http.fetch', async (_$, e) => {
    const req = e as unknown as { url: string; init?: { method?: string; headers?: Record<string, string>; body?: unknown } }
    const post: Post = { url: req.url, method: req.init?.method, headers: { ...(req.init?.headers ?? {}) }, body: String(req.init?.body ?? '') }
    if (only && !only(req.url)) {
      posts.others.push(post)
      return { value: { status: 200, ok: true, headers: {}, text: '{"partialSuccess":{}}' } } as never
    }
    posts.push(post)
    const r = reply(posts.length, post)
    if (r === 'reject') throw new Error('network refused in test')
    if (r === 'hang') return new Promise<never>(() => undefined)
    return { value: { status: r.status, ok: r.status >= 200 && r.status < 300, headers: {}, text: r.text ?? '' } } as never
  })
  return posts
}

/** One log record of a request body, with its resource, attributes read back to plain values. */
export type SentRecord = { resource: Record<string, unknown>; scope: { name?: string; version?: string }; body: unknown; time: string; traceId?: string; spanId?: string; attributes: Record<string, unknown> }

/** An OTLP/JSON AnyValue as a plain value: ints as numbers, arrays as arrays. */
export function plain(v: Record<string, unknown>): unknown {
  if ('stringValue' in v) return v['stringValue']
  if ('boolValue' in v) return v['boolValue']
  if ('intValue' in v) return Number(v['intValue'])
  if ('doubleValue' in v) return v['doubleValue']
  if ('arrayValue' in v) return ((v['arrayValue'] as { values?: Record<string, unknown>[] }).values ?? []).map(plain)
  throw new Error(`unknown AnyValue ${JSON.stringify(v)}`)
}

const kvs = (list: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const { key, value } of (list as { key: string; value: Record<string, unknown> }[]) ?? []) out[key] = plain(value)
  return out
}

/** Every log record a request carried, in order. */
export function records(post: Post): SentRecord[] {
  const out: SentRecord[] = []
  const body = JSON.parse(post.body) as { resourceLogs: { resource: { attributes: unknown }; scopeLogs: { scope: { name?: string; version?: string }; logRecords: Record<string, unknown>[] }[] }[] }
  for (const rl of body.resourceLogs) {
    const resource = kvs(rl.resource.attributes)
    for (const sl of rl.scopeLogs) {
      for (const r of sl.logRecords) {
        out.push({
          resource,
          scope: sl.scope,
          body: plain(r['body'] as Record<string, unknown>),
          time: String(r['timeUnixNano']),
          traceId: r['traceId'] as string | undefined,
          spanId: r['spanId'] as string | undefined,
          attributes: kvs(r['attributes']),
        })
      }
    }
  }
  return out
}

/** `$.store` beneath the plugin: a map in memory that records each write. */
export function memoryStore(on: On, entries: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(entries))
  const sets: { key: string; value: unknown }[] = []
  const deletes: string[] = []
  on('store.get', async (_$, e) => ({ value: data.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', async (_$, e) => {
    const w = e as unknown as { key: string; value: unknown }
    const value = JSON.parse(JSON.stringify(w.value)) as unknown
    sets.push({ key: w.key, value })
    data.set(w.key, value)
    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    const key = (e as unknown as { key: string }).key
    deletes.push(key)
    data.delete(key)
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: [...data.keys()] }) as never)
  return { data, sets, deletes }
}

// ── Keyless ingest ────────────────────────────────────────────────────────────
// The dev collector's rules for a request with no key, as its owners wrote them: routed by the `organization.id` and `user.email`
// on every item (a log record, a span, a metric data point), never the resource's.

type KeyValues = { key: string; value: Record<string, unknown> }[]

/** Each item's own attributes in an OTLP/JSON request body of any signal, in order. */
export function itemAttributes(post: Post): KeyValues[] {
  const body = JSON.parse(post.body) as Record<string, unknown[]>
  const out: KeyValues[] = []
  for (const rl of (body['resourceLogs'] ?? []) as { scopeLogs: { logRecords: { attributes?: KeyValues }[] }[] }[]) {
    for (const sl of rl.scopeLogs) for (const r of sl.logRecords) out.push(r.attributes ?? [])
  }
  for (const rs of (body['resourceSpans'] ?? []) as { scopeSpans: { spans: { attributes?: KeyValues }[] }[] }[]) {
    for (const ss of rs.scopeSpans) for (const s of ss.spans) out.push(s.attributes ?? [])
  }
  for (const rm of (body['resourceMetrics'] ?? []) as { scopeMetrics: { metrics: Record<string, { dataPoints?: { attributes?: KeyValues }[] }>[] }[] }[]) {
    for (const sm of rm.scopeMetrics) {
      for (const m of sm.metrics) {
        for (const kind of ['sum', 'gauge', 'histogram', 'exponentialHistogram', 'summary']) for (const p of m[kind]?.dataPoints ?? []) out.push(p.attributes ?? [])
      }
    }
  }
  return out
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What keyless ingest answers a request, and whose it took it to be. */
export type KeylessAnswer = { status: number; text: string; identity?: string }

/**
 * Keyless ingest's answer: 401 for a request with any Authorization header (it takes the key path); 400 for an `idempotency-key`
 * header of the wrong shape (the collector also takes the value in double quotes; the plugin never sends it so); 400 when an item lacks
 * `organization.id` or `user.email`, carries either twice or carries `kiro.user.email`, when the items name more than one pair, or
 * when the pair has not the shape; 403 with the reason for an organization `refused` names; else 200.
 */
export function keylessAnswer(post: Post, refused: Record<string, 'unclaimed' | 'email_domain'> = {}): KeylessAnswer {
  if (Object.keys(post.headers).some(h => h.toLowerCase() === 'authorization')) return { status: 401, text: '{"error":"unauthorized"}' }
  const idempotencyKey = Object.entries(post.headers).find(([h]) => h.toLowerCase() === 'idempotency-key')?.[1]
  if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) return { status: 400, text: '{"error":"idempotency-key"}' }
  let seen: string | undefined
  for (const attrs of itemAttributes(post)) {
    if (attrs.some(a => a.key === 'kiro.user.email')) return { status: 400, text: '{"error":"kiro.user.email"}' }
    const orgs = attrs.filter(a => a.key === 'organization.id')
    const emails = attrs.filter(a => a.key === 'user.email')
    if (orgs.length !== 1 || emails.length !== 1) return { status: 400, text: '{"error":"organization.id and user.email once on every item"}' }
    const pair = `${orgs[0]!.value['stringValue']} ${emails[0]!.value['stringValue']}`
    if (seen !== undefined && seen !== pair) return { status: 400, text: '{"error":"one organization.id and user.email per request"}' }
    seen = pair
  }
  if (seen === undefined) return { status: 200, text: '{}' }
  const [org, email] = seen.split(' ') as [string, string]
  if (!UUID_SHAPE.test(org) || !/^[^@\s]+@[^@\s]+$/.test(email)) return { status: 400, text: '{"error":"shape"}', identity: seen }
  const reason = refused[org]
  if (reason) return { status: 403, text: JSON.stringify({ error: 'not accepted', reason }), identity: seen }
  return { status: 200, text: '{"partialSuccess":{}}', identity: seen }
}
