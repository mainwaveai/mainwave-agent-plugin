// The plugin's own path to Mainwave: a copy of each Claude Code log row, and the spans and metrics the plugin rebuilds beside them
// (spans.ts, metrics.ts), sent to Mainwave's dev collector while Claude Code's exporter goes on sending the originals wherever the
// organization pointed it. The two land in different places, so nothing is counted twice, and the copy can be compared with the
// original record for record.
//
// The hooks only queue (`enqueue`): they never wait on the network. One queue holds all three signals, each entry tagged with its own,
// so they share the caps, the outbox and the end of the session. A timer sends the queue in batches every few seconds, each batch one
// signal to that signal's path, and `session.end` sends one more batch of each signal at once within its short bound. A batch that fails for a reason that can pass (no network, a timeout, the
// collector busy) goes back to the head of the queue and the timer waits longer before the next try. A batch the collector refuses
// as malformed is dropped. A refused key stops sending until the plugin loads again, keeping the queue.
//
// The queue is kept in `$.store` under this load's own key, so rows left at the end of a session, or by a process that died, are
// sent by a later one: an outbox no load has touched for a minute is taken over by the next load that looks.
//
// Fail open: nothing here holds a row, a tool call or the session. Every outcome is caught.

import type { EngineInterface, PluginOptions, Timer } from 'claude-code'

import { fetchWithin, type FetchOutcome } from './http.ts'
import { logsBody, metricsBody, resourceOf, tracesBody, type BuiltSpan, type CopiedRow, type MetricPoint } from './otlp.ts'
import { ingestKeyOf, KEY_OPTION, namesOption, type Layer } from './settings.ts'

/** The one place the copy goes, a path per signal. Nothing reads another URL from settings or the environment. */
export const DEV_COLLECTOR = 'https://collector.dev.mainwave.com'
export type Signal = 'logs' | 'traces' | 'metrics'
export const SIGNALS: readonly Signal[] = ['logs', 'traces', 'metrics']
export const DEV_URLS: Readonly<Record<Signal, string>> = {
  logs: `${DEV_COLLECTOR}/v1/logs`,
  traces: `${DEV_COLLECTOR}/v1/traces`,
  metrics: `${DEV_COLLECTOR}/v1/metrics`,
}
export const DEV_LOGS_URL = DEV_URLS.logs

export const FLUSH_MS = 5_000
export const SEND_TIMEOUT_MS = 10_000
export const BACKOFF_MAX_MS = 60_000
/** A batch: at most this many records of one signal and about this many bytes of JSON. */
export const BATCH_ROWS = 200
export const BATCH_BYTES = 1_000_000
/** The queue, all signals together: at most this many records and characters of JSON; past either, the oldest go. Three loads' outboxes fit `$.store`'s 4 MiB. */
export const QUEUE_ROWS = 5_000
export const QUEUE_BYTES = 1_000_000
/** New rows are saved at most this often (session end and taking over an outbox save at once): a crash loses at most this much. */
export const PERSIST_MS = 10_000
/** Batches one timer tick may send. */
export const BATCHES_PER_TICK = 5
/** An outbox untouched this long belongs to a load that has gone, and may be taken over. */
export const STALE_MS = 60_000
/**
 * `session.end`'s whole chain shares one short bound (1.5 s by default). The queue is saved first, then one batch of each signal is sent
 * at once with what is left, less a margin for the save after it. Under `END_MIN_MS` there is no point starting a request.
 */
export const END_MARGIN_MS = 150
export const END_MIN_MS = 250
export const END_TIMEOUT_MS = 3_000

export const OUTBOX_PREFIX = 'outbox:'

/** One record to send: a log row's copy, a rebuilt span, or a metric data point, tagged with its signal. */
export type Item = { s: 'logs'; d: CopiedRow } | { s: 'traces'; d: BuiltSpan } | { s: 'metrics'; d: MetricPoint }
type Queued = Item & { resource: string; size: number }
/** What the store keeps: each record's resource as an index into `resources`. Version 1 held log rows alone, as `rows`. */
export const OUTBOX_VERSION = 2
type Outbox = { v: 2; updatedAt: number; resources: string[]; items: { s: Signal; r: number; d: unknown }[] }

export type Verdict = 'sent' | 'retry' | 'drop' | 'stop'

/** What becomes of a batch after one try. */
export function verdictOf(outcome: FetchOutcome): Verdict {
  if (outcome.ok) return 'sent'
  if (outcome.reason !== 'status') return 'retry'
  if (outcome.status === 401 || outcome.status === 403) return 'stop'
  if (outcome.status === 400 || outcome.status === 413 || outcome.status === 422) return 'drop'
  return 'retry'
}

// Per load of the module; `configure` starts them over.
let key: string | null = null
let outboxKey = ''
let queue: Queued[] = []
let queuedBytes = 0
let inflight: Queued[] = []
let sending = false
let ticking = false
let stopped = false
let refused = false
let backoffMs = 0
let nextTryAt = 0
let timer: Timer | null = null
let resource: Promise<string> | null = null
let scopeVersion: string | undefined
let dirty = false
let persistedAt = 0
let adoptedAt = Number.NEGATIVE_INFINITY
let counts = { sent: 0, dropped: 0 }

function newId(): string {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

/** Starts the sender over for a load of the module, with the key from the plugin's options. */
export function configure(options: PluginOptions | undefined): void {
  timer?.cancel()
  key = ingestKeyOf(options?.[KEY_OPTION])
  outboxKey = `${OUTBOX_PREFIX}${newId()}`
  queue = []
  queuedBytes = 0
  inflight = []
  sending = false
  ticking = false
  stopped = false
  refused = false
  backoffMs = 0
  nextTryAt = 0
  timer = null
  resource = null
  scopeVersion = undefined
  dirty = false
  persistedAt = 0
  adoptedAt = Number.NEGATIVE_INFINITY
  counts = { sent: 0, dropped: 0 }
}

/** Whether rows are copied at all: a key of the right shape, and no repository naming it. */
export const isCopying = (): boolean => key !== null && !refused

/** What the sender holds now, for tests and the end-of-session debug line. Never the key. */
export function snapshot() {
  return { queued: queue.length, inflight: inflight.length, sent: counts.sent, dropped: counts.dropped, stopped, refused, backoffMs }
}

async function readResource($: EngineInterface): Promise<string> {
  const get = async (read: () => Promise<string | undefined>) => {
    try {
      return await read()
    } catch {
      return undefined
    }
  }
  const [resourceAttributes, serviceName, version] = await Promise.all([
    get(() => $.env.get('OTEL_RESOURCE_ATTRIBUTES')),
    get(() => $.env.get('OTEL_SERVICE_NAME')),
    get(async () => (await $.session.version()).version),
  ])
  scopeVersion = version
  return JSON.stringify(resourceOf({ resourceAttributes, serviceName, version }))
}

function dropOldest(): void {
  while (queue.length > QUEUE_ROWS || queuedBytes > QUEUE_BYTES) {
    const gone = queue.shift()
    if (gone === undefined) break
    queuedBytes -= gone.size
    counts.dropped += 1
  }
}

/**
 * Queues one record. Called from the hooks: it waits on nothing but the resource, read once per load, and starts the timer if none
 * runs (after a /clear the session goes on without a `session.start`).
 */
export async function enqueue($: EngineInterface, item: Item): Promise<void> {
  if (!isCopying()) return
  resource ??= readResource($)
  const res = await resource
  const size = JSON.stringify(item.d).length
  if (size > BATCH_BYTES) {
    counts.dropped += 1
    return
  }
  queue.push({ ...item, resource: res, size } as Queued)
  queuedBytes += size
  dirty = true
  dropOldest()
  ensureTimer($)
}

/** Starts the send timer if it is not running. */
export function ensureTimer($: EngineInterface): void {
  if (timer !== null || !isCopying()) return
  try {
    timer = $.clock.every(FLUSH_MS, () => void tick($))
  } catch {
    timer = null
  }
}

/** The oldest records of one signal (the oldest record's, unless named), in order; the rest of the queue keeps its order. */
function takeBatch(signal: Signal | undefined = queue[0]?.s): Queued[] {
  const batch: Queued[] = []
  const rest: Queued[] = []
  let bytes = 0
  let full = false
  for (const item of queue) {
    if (full || item.s !== signal || batch.length >= BATCH_ROWS || (batch.length > 0 && bytes + item.size > BATCH_BYTES)) {
      if (item.s === signal) full = true
      rest.push(item)
      continue
    }
    batch.push(item)
    bytes += item.size
  }
  queue = rest
  queuedBytes -= bytes
  return batch
}

function putBack(batch: Queued[]): void {
  queue = [...batch, ...queue]
  queuedBytes += batch.reduce((n, r) => n + r.size, 0)
  dropOldest()
}

function groups<T>(batch: readonly Queued[]): { resource: string; items: T[] }[] {
  const out: { resource: string; items: T[] }[] = []
  for (const { resource: res, d } of batch) {
    const last = out[out.length - 1]
    if (last !== undefined && last.resource === res) last.items.push(d as T)
    else out.push({ resource: res, items: [d as T] })
  }
  return out
}

/** A batch of one signal as that signal's request body. */
function bodyOf(batch: readonly Queued[], nowMs: number): string {
  const signal = batch[0]?.s ?? 'logs'
  if (signal === 'traces') return tracesBody(groups<BuiltSpan>(batch))
  if (signal === 'metrics') return metricsBody(groups<MetricPoint>(batch), scopeVersion)
  return logsBody(groups<CopiedRow>(batch).map(g => ({ resource: g.resource, rows: g.items })), scopeVersion, nowMs)
}

async function readLayer($: EngineInterface, source: 'project' | 'local'): Promise<Layer> {
  try {
    return await $.settings.read({ source })
  } catch {
    return 'unreadable'
  }
}

/** A repository that names the key option stops the copy for this load, and what was queued for it is let go. */
async function repositoryNamesKey($: EngineInterface): Promise<boolean> {
  const [project, local] = await Promise.all([readLayer($, 'project'), readLayer($, 'local')])
  if (!namesOption(project) && !namesOption(local)) return false
  refused = true
  queue = []
  queuedBytes = 0
  dirty = true
  timer?.cancel()
  timer = null
  return true
}

/** Sends one batch to its signal's path within `limit`. Never throws: a fault is an outcome. */
async function send($: EngineInterface, batch: readonly Queued[], limit: number, now: number): Promise<FetchOutcome> {
  try {
    return await fetchWithin($, DEV_URLS[batch[0]!.s], {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: bodyOf(batch, now),
      timeoutMs: limit,
    })
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/** Settles one batch's outcome: counted, dropped, or put back with the wait before the next try. False when sending should stop now. */
function settle(batch: Queued[], outcome: FetchOutcome, now: number): boolean {
  dirty = true
  const verdict = verdictOf(outcome)
  if (verdict === 'sent') {
    counts.sent += batch.length
    backoffMs = 0
    nextTryAt = 0
    return true
  }
  if (verdict === 'drop') {
    counts.dropped += batch.length
    return true
  }
  putBack(batch)
  // A request cut off by the session's end says nothing about the collector: the next session tries again at once.
  if (verdict === 'stop') stopped = true
  else if (outcome.ok || outcome.reason !== 'stopped') {
    backoffMs = Math.min(Math.max(backoffMs * 2, FLUSH_MS), BACKOFF_MAX_MS)
    nextTryAt = now + backoffMs
  }
  return false
}

/**
 * Sends up to `maxBatches` batches, one after another, each within `timeoutMs`, read again before each request (at session end it is
 * what the bound has left); a limit under `END_MIN_MS` sends nothing more. With `together`, sends one batch of each signal at once
 * instead. Never throws; never runs twice at once.
 */
export async function flush($: EngineInterface, opts: { timeoutMs: number | (() => number); maxBatches: number; together?: boolean }): Promise<void> {
  if (sending || !isCopying() || stopped || queue.length === 0) return
  sending = true
  try {
    if (await repositoryNamesKey($)) return
    const limitNow = () => (typeof opts.timeoutMs === 'function' ? opts.timeoutMs() : opts.timeoutMs)
    if (opts.together) {
      const now = await $.clock.now()
      const limit = limitNow()
      if (now < nextTryAt || !(limit >= END_MIN_MS)) return
      const batches = SIGNALS.map(sig => takeBatch(sig)).filter(b => b.length > 0)
      inflight = batches.flat()
      const outcomes = await Promise.all(batches.map(b => send($, b, limit, now)))
      inflight = []
      batches.forEach((b, i) => settle(b, outcomes[i]!, now))
      return
    }
    for (let i = 0; i < opts.maxBatches && queue.length > 0 && !stopped; i++) {
      const now = await $.clock.now()
      if (now < nextTryAt) break
      const limit = limitNow()
      if (!(limit >= END_MIN_MS)) break
      const batch = takeBatch()
      inflight = batch
      const outcome = await send($, batch, limit, now)
      inflight = []
      if (!settle(batch, outcome, now)) break
    }
  } catch {
    // A fault in sending never reaches the caller: the records stay queued.
  } finally {
    if (inflight.length > 0) putBack(inflight)
    inflight = []
    sending = false
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isAttrs = (v: unknown) => isObject(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Whether a stored record has the shape its signal sends. */
function fits(s: unknown, d: unknown): s is Signal {
  if (!isObject(d)) return false
  if (s === 'logs') return typeof d['event'] === 'string' && typeof d['loggedAt'] === 'string' && isAttrs(d['attributes'])
  if (s === 'traces') {
    return typeof d['traceId'] === 'string' && typeof d['spanId'] === 'string' && typeof d['name'] === 'string' && isNum(d['startMs']) && isNum(d['endMs'])
      && isAttrs(d['attributes']) && (d['events'] === undefined || Array.isArray(d['events']))
  }
  if (s === 'metrics') return typeof d['name'] === 'string' && isNum(d['startMs']) && isNum(d['timeMs']) && isNum(d['value']) && isAttrs(d['attributes'])
  return false
}

/** An outbox as the store holds it (this version's, or a version 1 one of log rows alone), or `null` when it does not have the shape. */
export function readOutbox(v: unknown): { updatedAt: number; items: Queued[] } | null {
  if (!isObject(v) || typeof v['updatedAt'] !== 'number' || !Array.isArray(v['resources'])) return null
  const raws = v['v'] === 1 ? v['rows'] : v['v'] === OUTBOX_VERSION ? v['items'] : undefined
  if (!Array.isArray(raws)) return null
  const resources = (v['resources'] as unknown[]).filter((r): r is string => typeof r === 'string')
  if (resources.length !== (v['resources'] as unknown[]).length) return null
  const items: Queued[] = []
  for (const raw of raws as unknown[]) {
    if (!isObject(raw) || typeof raw['r'] !== 'number') continue
    const res = resources[raw['r']]
    if (res === undefined) continue
    let s: unknown = raw['s']
    let d: unknown = raw['d']
    if (v['v'] === 1) {
      const { r: _r, ...row } = raw
      s = 'logs'
      d = row
    }
    if (!fits(s, d)) continue
    items.push({ s, d, resource: res, size: JSON.stringify(d).length } as Queued)
  }
  return { updatedAt: v['updatedAt'] as number, items }
}

/** The records as the store keeps them, each resource once. */
export function writeOutbox(items: readonly Queued[], updatedAt: number): Outbox {
  const resources: string[] = []
  const index = new Map<string, number>()
  const out: Outbox['items'] = []
  for (const { s, d, resource: res } of items) {
    let r = index.get(res)
    if (r === undefined) {
      r = resources.push(res) - 1
      index.set(res, r)
    }
    out.push({ s, r, d })
  }
  return { v: OUTBOX_VERSION, updatedAt, resources, items: out }
}

/** Writes this load's outbox: the batches in flight and the queue, or removes it when both are empty. */
export async function persist($: EngineInterface, force = false): Promise<void> {
  try {
    const now = await $.clock.now()
    const due = force || now - persistedAt >= PERSIST_MS
    const rows = [...inflight, ...queue]
    // Marked clean before the write: a row queued while it is under way marks it dirty again, and is saved by the next one.
    if (rows.length === 0) {
      if (!(dirty || force)) return
      dirty = false
      await $.store.delete(outboxKey)
    } else if ((dirty && due) || force || now - persistedAt >= STALE_MS / 3) {
      dirty = false
      await $.store.set(outboxKey, writeOutbox(rows, now))
    } else return
    persistedAt = now
  } catch {
    // The store refused (full, or gone): the queue in memory still sends, and the next save tries again.
    dirty = true
  }
}

/** Takes over every other load's outbox that nobody has touched for `STALE_MS`, oldest rows first. */
export async function adopt($: EngineInterface): Promise<void> {
  if (!isCopying()) return
  try {
    // A load a repository refuses takes over nothing: other sessions' rows stay where they are for a load that may send them.
    if (await repositoryNamesKey($)) return
    const now = await $.clock.now()
    adoptedAt = now
    for (const k of await $.store.keys()) {
      if (!k.startsWith(OUTBOX_PREFIX) || k === outboxKey) continue
      const raw = await $.store.get(k)
      // An outbox a later version wrote is left for that version to send.
      if (isObject(raw) && typeof raw['v'] === 'number' && raw['v'] > OUTBOX_VERSION) continue
      const box = readOutbox(raw)
      if (box !== null && now - box.updatedAt < STALE_MS) continue
      await $.store.delete(k)
      if (box === null || box.items.length === 0) continue
      queue = [...box.items, ...queue]
      queuedBytes += box.items.reduce((n, r) => n + r.size, 0)
      dirty = true
      dropOldest()
    }
    // What was taken over is this load's to keep from now on, before anything else can go wrong.
    if (dirty) await persist($, true)
    if (queue.length > 0) ensureTimer($)
  } catch {
    // An outbox that cannot be read now is looked at again later.
  }
}

/** One timer tick: send, now and then look for outboxes left behind, and keep this load's own up to date. */
export async function tick($: EngineInterface): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    await flush($, { timeoutMs: SEND_TIMEOUT_MS, maxBatches: BATCHES_PER_TICK })
    if ((await $.clock.now()) - adoptedAt >= STALE_MS) await adopt($)
    await persist($)
  } catch {
    // Next tick.
  } finally {
    ticking = false
  }
}

/**
 * At `session.end`: keep the queue, then send one batch of each signal at once if the bound leaves room, sized by what is left just
 * before the requests, and keep what is left. The timer goes on: after a /clear or a resume the process goes on, and so does sending.
 */
export async function finish($: EngineInterface, budget: { readonly remainingMs: number }): Promise<void> {
  if (!isCopying()) return
  await persist($, true)
  if (sending) return
  await flush($, { timeoutMs: () => Math.min(budget.remainingMs - END_MARGIN_MS, END_TIMEOUT_MS), maxBatches: 1, together: true })
  await persist($, true)
}
