// The plugin's hooks module. It stamps the telemetry rows Claude Code exports to the organization's collector (where the organization
// configured one), keeps the identity those rows carry for the session, and, where the person set a dev ingest key, sends its own
// copy of each row to Mainwave's dev collector (sender.ts). It draws nothing and registers no command or tool.
//
// The exporter's row always goes on: the copy is queued beside it, never in its place. Fail open: a hook that throws never holds up a
// row or the session. A row whose stamping failed goes on without any key the plugin owns, as Claude Code wrote it otherwise.

import { atom, update } from 'claude-code'
import type { CatchHandler, EngineInterface, Frozen, Hook, Next, Register, TelemetryAttribute, TelemetryLogResult, TelemetryRecordEntry } from 'claude-code'

import type { RowIdentity } from '../types'
import { endSession } from './http.ts'
import { identityOf, isOrgId, mergeIdentity } from './identity.ts'
import type { CopiedRow } from './otlp.ts'
import { adopt, configure, enqueue, ensureTimer, finish, isCopying, snapshot } from './sender.ts'
import { applyStamps, entrypointOf, filterStamps, PLUGIN_NAME, stripOwned } from './stamps.ts'
import { VERSION } from './version.ts'

export { VERSION }

// The hook stands on the collector stream only ({ to: 'collector' }), so its event and next are the collector record's.
type CollectorNext = Next<'telemetry.log', TelemetryRecordEntry, TelemetryLogResult, { 'telemetry.log': TelemetryRecordEntry }>
type CollectorHook = ($: EngineInterface, e: Frozen<TelemetryRecordEntry>, next: CollectorNext) => TelemetryLogResult | Promise<TelemetryLogResult>
type RowParams = Parameters<CollectorHook>
type RowCatchParams = Parameters<CatchHandler<CollectorHook>>
type SessionStartParams = Parameters<Hook<'session.start'>>
type SessionEndParams = Parameters<Hook<'session.end'>>

/** The session's identity as its rows say (types/index.d.ts). */
const identityAtom = atom({ plugin: 'mainwave', key: 'identity' } as const, {})

// Per load of the module: a reload starts these over. `$.state` outlives a reload, so the first row after one writes the identity again.
let entrypoint: Promise<string> | null = null
let held: RowIdentity = {}

/** `CLAUDE_CODE_ENTRYPOINT`, normalized; `other` when it cannot be read. */
async function readEntrypoint($: EngineInterface): Promise<string> {
  try {
    return entrypointOf(await $.env.get('CLAUDE_CODE_ENTRYPOINT'))
  } catch {
    return 'other'
  }
}

/**
 * Keeps what the row says about who the session is, writing `$.state` only when the row adds something. The write merges into the
 * stored value, not this module's copy, so two rows that land together each keep their fields.
 */
async function noteIdentity($: EngineInterface, attributes: Readonly<Record<string, unknown>>): Promise<void> {
  const seen = identityOf(attributes)
  if (mergeIdentity(held, seen) === held) return
  let merged = held
  await update($, identityAtom, stored => (merged = mergeIdentity(stored, seen)))
  held = merged
}

/** The copy of a row the plugin sends: plain data, its route `plugin`. */
function copyOf(e: Frozen<TelemetryRecordEntry>, attributes: Record<string, TelemetryAttribute>): CopiedRow {
  const span = e.span === undefined ? undefined : { traceId: e.span.traceId, spanId: e.span.spanId, traceFlags: e.span.traceFlags }
  const route = filterStamps({ 'mainwave.telemetry.route': 'plugin' }).kept
  return { event: e.event, loggedAt: e.loggedAt, ...(span ? { span } : {}), attributes: { ...attributes, ...route } }
}

/**
 * Stamps one collector row and queues the plugin's copy of it. A row that names an organization carries the plugin's name, version,
 * entry point and route (`exporter`); one that does not goes on without any key the plugin owns. Either way the row goes on to the
 * exporter, and the copy, where the plugin copies at all, is queued with route `plugin`.
 */
export async function stampRow($: RowParams[0], e: RowParams[1], next: RowParams[2]): Promise<TelemetryLogResult> {
  let attributes: Record<string, TelemetryAttribute>
  if (isOrgId(e.attributes['organization.id'])) {
    entrypoint ??= readEntrypoint($)
    const ep = await entrypoint
    try {
      await noteIdentity($, e.attributes)
    } catch {
      // The identity is the session's to keep, not the row's: a failed write never holds the row.
    }
    attributes = applyStamps(e.attributes, {
      'mainwave.mod.name': PLUGIN_NAME,
      'mainwave.mod.version': VERSION,
      'mainwave.mod.entrypoint': ep,
      'mainwave.telemetry.route': 'exporter',
    })
  } else {
    attributes = stripOwned(e.attributes)
  }
  if (isCopying()) {
    try {
      await enqueue($, copyOf(e, attributes))
    } catch {
      // The copy is the plugin's own: a fault queueing it never holds the exporter's row.
    }
  }
  return next({ ...e, attributes })
}

/**
 * A row is always delivered. When stamping failed before the row went on, it goes on without any key the plugin owns; if even that
 * fails, as it came. When it had gone on already, the result it settled to is replayed and nothing beneath runs twice.
 */
export function rowCatch($: RowCatchParams[0], e: RowCatchParams[1], next: RowCatchParams[2]) {
  if (next.called) return next(e)
  let row = e
  try {
    row = { ...e, attributes: stripOwned(e.attributes) }
  } catch {
    // Not even the strip worked: the row goes on as it came.
  }
  return next(row)
}

/** Starts the send timer and takes over outboxes earlier sessions left; the event goes on unchanged. */
export async function sessionStart($: SessionStartParams[0], e: SessionStartParams[1], next: SessionStartParams[2]) {
  if (isCopying()) {
    try {
      ensureTimer($)
      await adopt($)
    } catch {
      // Sending starts with the next row instead.
    }
  }
  return next(e)
}

/**
 * Sends what it can of the queue within the session's end bound and keeps the rest for a later session. Requests still waiting for
 * the ending session then answer `stopped` (http.ts); the event goes on unchanged.
 */
export async function sessionEnd($: SessionEndParams[0], e: SessionEndParams[1], next: SessionEndParams[2]) {
  try {
    await finish($, next.budget.remainingMs)
    if (isCopying()) {
      const s = snapshot()
      $.ui.log(`mainwave: copy to dev: ${s.sent} sent, ${s.dropped} dropped, ${s.queued} kept for a later session`, { to: 'debug' })
    }
  } catch {
    // What could not be kept is lost to the copy alone: the exporter's rows went on.
  }
  endSession()
  return next(e)
}

export const register: Register = (on, options) => {
  entrypoint = null
  held = {}
  configure(options)

  on('session.start', sessionStart)

  on('telemetry.log', { to: 'collector' }, stampRow).catch(rowCatch)

  on('session.end', sessionEnd)
}
