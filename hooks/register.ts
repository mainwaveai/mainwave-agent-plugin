// The plugin's hooks module. It stamps the telemetry rows Claude Code exports to the organization's collector (where the organization
// configured one), keeps the identity those rows carry for the session, and, where the person set a dev ingest key, sends its own
// copy of each row to Mainwave's dev collector (sender.ts), with the spans and metrics it rebuilds beside them (rebuild.ts, meter.ts).
// It draws nothing and registers no command or tool.
//
// The exporter's row always goes on: the copy is queued beside it, never in its place. Fail open: a hook that throws never holds up a
// row, a turn, a tool call or the session. A row whose stamping failed goes on without any key the plugin owns, as Claude Code wrote
// it otherwise. The hooks that watch turns, model requests, tool calls, slash commands and spawns only observe: each passes its event on
// unchanged, and its result back unchanged.

import { atom, update } from 'claude-code'
import type { CatchHandler, EngineInterface, Frozen, Hook, Next, Register, StreamHook, TelemetryAttribute, TelemetryLogResult, TelemetryRecordEntry, Timer } from 'claude-code'

import type { RowIdentity } from '../types'
import { endSession } from './http.ts'
import { identityOf, isOrgId, mergeIdentity } from './identity.ts'
import { add, collect, newMeter, type Meter } from './meter.ts'
import type { CopiedRow } from './otlp.ts'
import {
  agentSpawned, commandEnd, commandStart, newRebuild, observeRow, parseTraceparent, sessionStarted, stepEnd, stepStart, sweep, toolEnd, toolStart, turnComplete, turnStart, waits, type Emit, type Rebuild,
} from './rebuild.ts'
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
type TurnStartParams = Parameters<Hook<'turn.start'>>
type TurnCompleteParams = Parameters<Hook<'turn.complete'>>
type StepParams = Parameters<StreamHook<'turn.step'>>
type ToolCallParams = Parameters<Hook<'tool.call'>>
type ToolCatchParams = Parameters<CatchHandler<Hook<'tool.call'>>>
type CommandParams = Parameters<Hook<'command.run'>>
type CommandCatchParams = Parameters<CatchHandler<Hook<'command.run'>>>
type SpawnParams = Parameters<Hook<'agent.spawn'>>
type SpawnCatchParams = Parameters<CatchHandler<Hook<'agent.spawn'>>>

/** The session's identity as its rows say (types/index.d.ts). */
const identityAtom = atom({ plugin: 'mainwave', key: 'identity' } as const, {})
/** Whether this process has counted its session in `claude_code.session.count` (types/index.d.ts): once, whatever reloads. */
const sessionCountedAtom = atom({ plugin: 'mainwave', key: 'sessionCounted' } as const, false)

/** Claude Code's metric export interval when `OTEL_METRIC_EXPORT_INTERVAL` names none. */
export const METRIC_INTERVAL_MS = 60_000
/** How often records waiting for their pair are looked at. */
export const SWEEP_MS = 1_000
const ROUTE = filterStamps({ 'mainwave.telemetry.route': 'plugin' }).kept

// Per load of the module: a reload starts these over. `$.state` outlives a reload, so the first row after one writes the identity again.
let entrypoint: Promise<string> | null = null
let held: RowIdentity = {}
let rebuild: Promise<Rebuild> | null = null
let meter: Meter = newMeter()
let sweepTimer: Timer | null = null
let meterTimer: Timer | null = null

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

/** A whole number of milliseconds of at least 1 from an environment variable, or undefined. */
function positiveInt(raw: string | undefined): number | undefined {
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** An environment read that answers undefined when it fails. */
async function settle(read: Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await read
  } catch {
    return undefined
  }
}

/** The rebuild for this load, its settings read from the environment once. */
async function makeRebuild($: EngineInterface): Promise<Rebuild> {
  const [details, traceparent, spanLimit, anyLimit] = await Promise.all([
    settle($.env.get('OTEL_LOG_TOOL_DETAILS')),
    settle($.env.get('TRACEPARENT')),
    settle($.env.get('OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT')),
    settle($.env.get('OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT')),
  ])
  const limit = positiveInt(spanLimit) ?? positiveInt(anyLimit)
  return newRebuild({
    toolDetails: ['1', 'true', 'yes', 'on'].includes((details ?? '').trim().toLowerCase()),
    ...(parseTraceparent(traceparent) ? { traceparent: parseTraceparent(traceparent)! } : {}),
    ...(limit !== undefined ? { valueLengthLimit: limit } : {}),
  })
}

/** Starts the timers that send what waited too long for its pair and collect the metrics, if they are not running. */
async function ensureRebuildTimers($: EngineInterface): Promise<void> {
  if (sweepTimer === null) sweepTimer = $.clock.every(SWEEP_MS, () => void sweepNow($, false))
  if (meterTimer === null) {
    const interval = positiveInt(await settle($.env.get('OTEL_METRIC_EXPORT_INTERVAL'))) ?? METRIC_INTERVAL_MS
    meterTimer ??= $.clock.every(interval, () => void collectNow($))
  }
}

/** The rebuild, when the plugin copies at all; null otherwise, or when it cannot be had. */
async function rebuildOf($: EngineInterface): Promise<Rebuild | null> {
  if (!isCopying()) return null
  try {
    rebuild ??= makeRebuild($)
    const r = await rebuild
    await ensureRebuildTimers($)
    return r
  } catch {
    return null
  }
}

/** Queues what the rebuild produced: each span with route `plugin`, each measure added to its counter with route `plugin`. */
async function emit($: EngineInterface, out: Emit): Promise<void> {
  for (const m of out.measures) add(meter, { ...m, attributes: { ...m.attributes, ...ROUTE } })
  for (const span of out.spans) await enqueue($, { s: 'traces', d: { ...span, attributes: { ...span.attributes, ...ROUTE } } })
}

/** Sends what waited too long for its pair; at the end of a session, everything that has ended. */
async function sweepNow($: EngineInterface, final: boolean): Promise<void> {
  try {
    if (rebuild === null || !isCopying()) return
    const r = await rebuild
    if (!final && !waits(r)) return
    await emit($, sweep(r, await $.clock.now(), final))
  } catch {
    // Next sweep.
  }
}

/** One metric collection: a delta point per series measured since the last, queued. */
async function collectNow($: EngineInterface): Promise<void> {
  try {
    if (!isCopying()) return
    for (const d of collect(meter, await $.clock.now())) await enqueue($, { s: 'metrics', d })
  } catch {
    // The measures since are lost to the copy alone.
  }
}

/** Reads one row into the rebuild: the row's own attributes as Claude Code raised them, before any stamp. */
async function observe($: EngineInterface, e: Frozen<TelemetryRecordEntry>): Promise<void> {
  const r = await rebuildOf($)
  if (r === null) return
  const atMs = Date.parse(e.loggedAt)
  const span = e.span === undefined ? undefined : { traceId: e.span.traceId, spanId: e.span.spanId }
  await emit($, observeRow(r, { event: e.event, atMs: Number.isFinite(atMs) ? atMs : await $.clock.now(), ...(span ? { span } : {}), attributes: e.attributes }))
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
      await enqueue($, { s: 'logs', d: copyOf(e, attributes) })
      await observe($, e)
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

/**
 * Starts the send timer, takes over outboxes earlier sessions left, and counts the session once per process in
 * `claude_code.session.count`; the event goes on unchanged.
 */
export async function sessionStart($: SessionStartParams[0], e: SessionStartParams[1], next: SessionStartParams[2]) {
  if (isCopying()) {
    try {
      ensureTimer($)
      const r = await rebuildOf($)
      let first = false
      await update($, sessionCountedAtom, counted => ((first = counted !== true), true))
      if (first && r !== null) await emit($, sessionStarted(r, await $.clock.now()))
      await adopt($)
    } catch {
      // Sending starts with the next row instead.
    }
  }
  return next(e)
}

/** A main-loop turn began: an interaction opens. */
export async function turnStartHook($: TurnStartParams[0], e: TurnStartParams[1], next: TurnStartParams[2]) {
  try {
    const r = await rebuildOf($)
    if (r !== null) turnStart(r, e)
  } catch {
    // The turn's interaction is not rebuilt.
  }
  return next(e)
}

/** A turn ended: a main-loop interaction is sent. */
export async function turnCompleteHook($: TurnCompleteParams[0], e: TurnCompleteParams[1], next: TurnCompleteParams[2]) {
  try {
    const r = await rebuildOf($)
    if (r !== null) await emit($, turnComplete(r, e, await $.clock.now()))
  } catch {
    // The turn's interaction is not rebuilt.
  }
  return next(e)
}

/** One model request: its start, and its stop reason and usage once it is whole. The stream passes through untouched. */
export async function* stepHook($: StepParams[0], e: StepParams[1], next: StepParams[2]) {
  let r: Rebuild | null = null
  let startMs = 0
  try {
    r = await rebuildOf($)
    if (r !== null) {
      stepStart(r, e.agentId, e.model)
      startMs = await $.clock.now()
    }
  } catch {
    r = null
  }
  // A stream closed early (interrupted, or no longer read) leaves here and sends nothing: its row, if one comes, goes alone.
  const result = yield* next(e)
  if (r !== null) {
    try {
      await emit($, stepEnd(r, e.agentId, startMs, result, await $.clock.now()))
    } catch {
      // The request's span goes without its stop reason.
    }
  }
  return result
}

/** One tool call: when it began and ended, and what it did. The call and its result pass through untouched. */
export async function toolCallHook($: ToolCallParams[0], e: ToolCallParams[1], next: ToolCallParams[2]) {
  let r: Rebuild | null = null
  try {
    r = await rebuildOf($)
    if (r !== null) toolStart(r, e as never, await $.clock.now())
  } catch {
    r = null
  }
  const result = await next(e)
  if (r !== null) {
    try {
      await emit($, toolEnd(r, e.tool_use_id, result as never, await $.clock.now()))
    } catch {
      // The call's spans go with what the rows say.
    }
  }
  return result
}

/**
 * A slash command: when it ran, so one that asks no model (`/plugins`, `/cost`, `/exit`) is an interaction of its own, as Claude Code
 * counts it. The command and its result pass through untouched.
 */
export async function commandHook($: CommandParams[0], e: CommandParams[1], next: CommandParams[2]) {
  let r: Rebuild | null = null
  try {
    r = await rebuildOf($)
    if (r !== null) commandStart(r, await $.clock.now())
  } catch {
    r = null
  }
  const result = await next(e)
  if (r !== null) {
    try {
      await emit($, commandEnd(r, await $.clock.now()))
    } catch {
      // The command's interaction goes with what the rows say.
    }
  }
  return result
}

/** A command goes on whatever the hook did; once it has gone on, its result stands. */
export function commandCatch($: CommandCatchParams[0], e: CommandCatchParams[1], next: CommandCatchParams[2]) {
  return next(e)
}

/** A tool call goes on whatever the hook did; once it has gone on, its result stands. */
export function toolCatch($: ToolCatchParams[0], e: ToolCatchParams[1], next: ToolCatchParams[2]) {
  return next(e)
}

/** An Agent call started a subagent: which call, so the subagent's rows can name the call's execution span. */
export async function spawnHook($: SpawnParams[0], e: SpawnParams[1], next: SpawnParams[2]) {
  const result = await next(e)
  try {
    const r = await rebuildOf($)
    if (r !== null && result.deny === undefined && result.agentId) agentSpawned(r, e.tool_use_id, result.agentId, e.parentAgentId)
  } catch {
    // The subagent's execution span goes with an id of its own.
  }
  return result
}

/** A spawn goes on whatever the hook did; once it has gone on, its result stands. */
export function spawnCatch($: SpawnCatchParams[0], e: SpawnCatchParams[1], next: SpawnCatchParams[2]) {
  return next(e)
}

/**
 * Sends what it can of the queue within the session's end bound and keeps the rest for a later session. Requests still waiting for
 * the ending session then answer `stopped` (http.ts); the event goes on unchanged.
 */
export async function sessionEnd($: SessionEndParams[0], e: SessionEndParams[1], next: SessionEndParams[2]) {
  try {
    if (isCopying()) {
      await sweepNow($, true)
      // Claude Code's meter collects once more as the process ends; after a /clear or a resume the process goes on, and so does it.
      if (e.reason !== 'clear' && e.reason !== 'resume') await collectNow($)
    }
    await finish($, next.budget)
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
  rebuild = null
  meter = newMeter()
  sweepTimer?.cancel()
  meterTimer?.cancel()
  sweepTimer = null
  meterTimer = null
  configure(options)

  on('session.start', sessionStart)

  on('telemetry.log', { to: 'collector' }, stampRow).catch(rowCatch)

  on('turn.start', turnStartHook)
  on('turn.step', stepHook)
  on('turn.complete', turnCompleteHook)
  on('tool.call', toolCallHook).catch(toolCatch)
  on('command.run', commandHook).catch(commandCatch)
  on('agent.spawn', spawnHook).catch(spawnCatch)

  on('session.end', sessionEnd)
}
