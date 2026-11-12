// The plugin's hooks module. Report-only for now: it stamps the telemetry rows Claude Code exports to the organization's collector
// (where the organization configured one) and keeps the identity those rows carry for the session. It sends nothing of its own,
// draws nothing and registers no command or tool.
//
// Fail open: a hook that throws never holds up a row or the session. A row whose stamping failed goes on without any key the plugin
// owns, as Claude Code wrote it otherwise.

import { atom, update } from 'claude-code'
import type { CatchHandler, EngineInterface, Frozen, Hook, Next, Register, SettingsSource, TelemetryLogResult, TelemetryRecordEntry } from 'claude-code'

import type { RowIdentity } from '../types'
import { endSession } from './http.ts'
import { identityOf, mergeIdentity } from './identity.ts'
import { reportingSwitch, type Layer } from './settings.ts'
import { applyStamps, entrypointOf, PLUGIN_NAME, stripOwned } from './stamps.ts'
import { VERSION } from './version.ts'

export { VERSION }

// The hook stands on the collector stream only ({ to: 'collector' }), so its event and next are the collector record's.
type CollectorNext = Next<'telemetry.log', TelemetryRecordEntry, TelemetryLogResult, { 'telemetry.log': TelemetryRecordEntry }>
type CollectorHook = ($: EngineInterface, e: Frozen<TelemetryRecordEntry>, next: CollectorNext) => TelemetryLogResult | Promise<TelemetryLogResult>
type RowParams = Parameters<CollectorHook>
type RowCatchParams = Parameters<CatchHandler<CollectorHook>>
type SessionEndParams = Parameters<Hook<'session.end'>>

/** The session's identity as its rows say (types/index.d.ts). */
const identityAtom = atom({ plugin: 'mainwave', key: 'identity' } as const, {})

// Per load of the module: a reload starts these over. `$.state` outlives a reload, so the first row after one writes the identity again.
let entrypoint: Promise<string> | null = null
let held: RowIdentity = {}

/** One settings layer; a read that fails, for any reason, is `unreadable`. */
async function readLayer($: EngineInterface, source: SettingsSource): Promise<Layer> {
  try {
    return await $.settings.read({ source })
  } catch {
    return 'unreadable'
  }
}

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

/**
 * Stamps one collector row. The switch is read on every row: nothing that allows stamping is cached, so an organization that turns
 * reporting off stops it at the next row. Off, the row goes on without any key the plugin owns. On, it carries the plugin's name,
 * version, entry point and where the switch's answer came from.
 */
export async function stampRow($: RowParams[0], e: RowParams[1], next: RowParams[2]): Promise<TelemetryLogResult> {
  entrypoint ??= readEntrypoint($)
  const [policy, flag, user, ep] = await Promise.all([readLayer($, 'policy'), readLayer($, 'flag'), readLayer($, 'user'), entrypoint])
  const reporting = reportingSwitch({ policy, flag, user }, e.attributes['organization.id'])
  if (!reporting.on) return next({ ...e, attributes: stripOwned(e.attributes) })
  try {
    await noteIdentity($, e.attributes)
  } catch {
    // The identity is the session's to keep, not the row's: a failed write never holds the row.
  }
  const stamps = {
    'mainwave.mod.name': PLUGIN_NAME,
    'mainwave.mod.version': VERSION,
    'mainwave.mod.entrypoint': ep,
    'mainwave.telemetry.source': reporting.source,
  }
  return next({ ...e, attributes: applyStamps(e.attributes, stamps) })
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

export const register: Register = on => {
  entrypoint = null
  held = {}

  on('telemetry.log', { to: 'collector' }, stampRow).catch(rowCatch)

  on('session.end', sessionEnd)
}

/** Requests still waiting for the ending session answer `stopped` (http.ts); the event goes on unchanged. */
export function sessionEnd(_$: SessionEndParams[0], e: SessionEndParams[1], next: SessionEndParams[2]) {
  endSession()
  return next(e)
}
