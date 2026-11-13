// The plugin's own path to Mainwave: a copy of each Claude Code log row, sent to Mainwave's dev collector while Claude Code's exporter
// goes on sending the original wherever the organization pointed it. The two land in different places, so nothing is counted twice,
// and the copy can be compared with the original row for row.
//
// The row's hook only queues (`enqueue`): it never waits on the network. A timer sends the queue in batches every few seconds, and
// `session.end` sends one more within its short bound. A batch that fails for a reason that can pass (no network, a timeout, the
// collector busy) goes back to the head of the queue and the timer waits longer before the next try. A batch the collector refuses
// as malformed is dropped. A refused key stops sending until the plugin loads again, keeping the queue.
//
// The queue is kept in `$.store` under this load's own key, so rows left at the end of a session, or by a process that died, are
// sent by a later one: an outbox no load has touched for a minute is taken over by the next load that looks.
//
// Fail open: nothing here holds a row, a tool call or the session. Every outcome is caught.

import type { EngineInterface, PluginOptions, Timer } from 'claude-code'

import { fetchWithin, type FetchOutcome } from './http.ts'
import { logsBody, resourceOf, type CopiedRow } from './otlp.ts'
import { ingestKeyOf, KEY_OPTION, namesOption, type Layer } from './settings.ts'

/** The one place the copy goes. Nothing reads another URL from settings or the environment. */
export const DEV_LOGS_URL = 'https://collector.dev.mainwave.com/v1/logs'

export const FLUSH_MS = 5_000
export const SEND_TIMEOUT_MS = 10_000
export const BACKOFF_MAX_MS = 60_000
/** A batch: at most this many rows and about this many bytes of JSON. */
export const BATCH_ROWS = 200
export const BATCH_BYTES = 1_000_000
/** The queue: at most this many rows and bytes; past either, the oldest go. Well under `$.store`'s 4 MiB, with two loads' outboxes. */
export const QUEUE_ROWS = 5_000
export const QUEUE_BYTES = 1_500_000
/** Batches one timer tick may send. */
export const BATCHES_PER_TICK = 5
/** An outbox untouched this long belongs to a load that has gone, and may be taken over. */
export const STALE_MS = 60_000
/** How long `session.end` leaves itself after its last send. */
export const END_MARGIN_MS = 500
export const END_TIMEOUT_MS = 3_000

export const OUTBOX_PREFIX = 'outbox:'

type Queued = CopiedRow & { resource: string; size: number }
/** What the store keeps: each row's resource as an index into `resources`. */
type Outbox = { v: 1; updatedAt: number; resources: string[]; rows: (CopiedRow & { r: number })[] }

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
 * Queues the copy of one row. Called from the row's hook: it waits on nothing but the resource, read once per load, and starts the
 * timer if none runs (after a /clear the session goes on without a `session.start`).
 */
export async function enqueue($: EngineInterface, row: CopiedRow): Promise<void> {
  if (!isCopying()) return
  resource ??= readResource($)
  const res = await resource
  const size = JSON.stringify(row).length
  if (size > BATCH_BYTES) {
    counts.dropped += 1
    return
  }
  queue.push({ ...row, resource: res, size })
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

function takeBatch(): Queued[] {
  const batch: Queued[] = []
  let bytes = 0
  while (queue.length > 0 && batch.length < BATCH_ROWS) {
    const head = queue[0]!
    if (batch.length > 0 && bytes + head.size > BATCH_BYTES) break
    batch.push(head)
    bytes += head.size
    queue.shift()
  }
  queuedBytes -= bytes
  return batch
}

function putBack(batch: Queued[]): void {
  queue = [...batch, ...queue]
  queuedBytes += batch.reduce((n, r) => n + r.size, 0)
  dropOldest()
}

function groups(batch: readonly Queued[]) {
  const out: { resource: string; rows: CopiedRow[] }[] = []
  for (const { resource: res, size: _size, ...row } of batch) {
    const last = out[out.length - 1]
    if (last !== undefined && last.resource === res) last.rows.push(row)
    else out.push({ resource: res, rows: [row] })
  }
  return out
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

/** Sends up to `maxBatches` batches, each within `timeoutMs`. Never throws; never runs twice at once. */
export async function flush($: EngineInterface, opts: { timeoutMs: number; maxBatches: number }): Promise<void> {
  if (sending || !isCopying() || stopped || queue.length === 0) return
  sending = true
  try {
    if (await repositoryNamesKey($)) return
    for (let i = 0; i < opts.maxBatches && queue.length > 0 && !stopped; i++) {
      const now = await $.clock.now()
      if (now < nextTryAt) break
      const batch = takeBatch()
      inflight = batch
      let outcome: FetchOutcome
      try {
        outcome = await fetchWithin($, DEV_LOGS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: logsBody(groups(batch), scopeVersion, now),
          timeoutMs: opts.timeoutMs,
        })
      } catch {
        outcome = { ok: false, reason: 'failed' }
      }
      inflight = []
      dirty = true
      const verdict = verdictOf(outcome)
      if (verdict === 'sent') {
        counts.sent += batch.length
        backoffMs = 0
        nextTryAt = 0
      } else if (verdict === 'drop') {
        counts.dropped += batch.length
      } else {
        putBack(batch)
        // A request cut off by the session's end says nothing about the collector: the next session tries again at once.
        if (verdict === 'stop') stopped = true
        else if (outcome.ok || outcome.reason !== 'stopped') {
          backoffMs = Math.min(Math.max(backoffMs * 2, FLUSH_MS), BACKOFF_MAX_MS)
          nextTryAt = now + backoffMs
        }
        break
      }
    }
  } catch {
    // A fault in sending never reaches the caller: the rows stay queued.
  } finally {
    if (inflight.length > 0) putBack(inflight)
    inflight = []
    sending = false
  }
}

const isRow = (v: unknown): v is CopiedRow & { r: number } => {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['event'] === 'string' && typeof o['loggedAt'] === 'string' && typeof o['r'] === 'number'
    && o['attributes'] !== null && typeof o['attributes'] === 'object' && !Array.isArray(o['attributes'])
}

/** An outbox as the store holds it, or `null` when it does not have the shape. */
export function readOutbox(v: unknown): { updatedAt: number; rows: Queued[] } | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Partial<Outbox>
  if (o.v !== 1 || typeof o.updatedAt !== 'number' || !Array.isArray(o.resources) || !Array.isArray(o.rows)) return null
  const resources = o.resources.filter((r): r is string => typeof r === 'string')
  if (resources.length !== o.resources.length) return null
  const rows: Queued[] = []
  for (const raw of o.rows) {
    if (!isRow(raw)) continue
    const res = resources[raw.r]
    if (res === undefined) continue
    const { r: _r, ...row } = raw
    rows.push({ ...row, resource: res, size: JSON.stringify(row).length })
  }
  return { updatedAt: o.updatedAt, rows }
}

/** The rows as the store keeps them, each resource once. */
export function writeOutbox(rows: readonly Queued[], updatedAt: number): Outbox {
  const resources: string[] = []
  const index = new Map<string, number>()
  const out: Outbox['rows'] = []
  for (const { resource: res, size: _size, ...row } of rows) {
    let r = index.get(res)
    if (r === undefined) {
      r = resources.push(res) - 1
      index.set(res, r)
    }
    out.push({ ...row, r })
  }
  return { v: 1, updatedAt, resources, rows: out }
}

/** Writes this load's outbox: the batch in flight and the queue, or removes it when both are empty. */
export async function persist($: EngineInterface, force = false): Promise<void> {
  try {
    const now = await $.clock.now()
    const rows = [...inflight, ...queue]
    if (rows.length === 0) {
      if (dirty || force) await $.store.delete(outboxKey)
    } else if (dirty || force || now - persistedAt >= STALE_MS / 3) {
      await $.store.set(outboxKey, writeOutbox(rows, now))
    } else return
    dirty = false
    persistedAt = now
  } catch {
    // The store refused (full, or gone): the queue in memory still sends.
  }
}

/** Takes over every other load's outbox that nobody has touched for `STALE_MS`, oldest rows first. */
export async function adopt($: EngineInterface): Promise<void> {
  if (!isCopying()) return
  try {
    const now = await $.clock.now()
    adoptedAt = now
    for (const k of await $.store.keys()) {
      if (!k.startsWith(OUTBOX_PREFIX) || k === outboxKey) continue
      const box = readOutbox(await $.store.get(k))
      if (box !== null && now - box.updatedAt < STALE_MS) continue
      await $.store.delete(k)
      if (box === null || box.rows.length === 0) continue
      queue = [...box.rows, ...queue]
      queuedBytes += box.rows.reduce((n, r) => n + r.size, 0)
      dirty = true
      dropOldest()
    }
    // What was taken over is this load's to keep from now on, before anything else can go wrong.
    if (dirty) await persist($)
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

/** At `session.end`: stop the timer, keep the queue, send one batch if the bound leaves room, and keep what is left. */
export async function finish($: EngineInterface, remainingMs: number): Promise<void> {
  timer?.cancel()
  timer = null
  if (!isCopying()) return
  await persist($, true)
  const room = remainingMs - END_MARGIN_MS
  if (room >= 1_000 && !sending) {
    await flush($, { timeoutMs: Math.min(room, END_TIMEOUT_MS), maxBatches: 1 })
    await persist($, true)
  }
}
