// What the plugin may put on a telemetry row, and the check that keeps everything else of ours off it. Pure: tests call it directly.
//
// Every key under an owned prefix is the plugin's alone. A row reaches the hook from Claude Code, but anything upstream of it (another
// plugin, an older copy of this one, an OTEL setting a repository controls) could already have written keys that look like ours, so
// they are removed before the plugin adds its own. What the plugin adds passes a shape check per key: a key without a rule, or a value
// that fails its rule, is dropped, never sent.

import { DEFAULTS } from './catalog.ts'

/** The plugin's name on every row it stamps. */
export const PLUGIN_NAME = 'mainwave'

/**
 * Key prefixes the plugin owns. Any key under one of them that the plugin did not write this time is removed from the row.
 * `mainwave.mod.` is where earlier Mainwave plugins, and this one before it named its stamps `mainwave.plugin.*`, put theirs: the
 * plugin writes nothing there, and strips it so no row carries an old-named stamp beside its own.
 */
export const OWNED_PREFIXES: readonly string[] = ['mainwave.plugin.', 'mainwave.telemetry.', 'mainwave.redaction.', 'mainwave.mod.']

/** Every key the plugin stamps. */
export type StampKey = 'mainwave.plugin.name' | 'mainwave.plugin.version' | 'mainwave.plugin.entrypoint' | 'mainwave.telemetry.route' | 'mainwave.telemetry.opt_in'

/**
 * On the plugin's own copy alone (gate.ts): the data points the person's opt-in turned on for the record, comma-separated, so an admin
 * can see why that data is there.
 */
export const OPT_IN_STAMP = 'mainwave.telemetry.opt_in'
/** The data points a person can opt in to: those off by default. */
export const OPT_IN_IDS: readonly string[] = Object.entries(DEFAULTS).filter(([, d]) => d === 'off').map(([id]) => id)

/** `CLAUDE_CODE_ENTRYPOINT` values the plugin reports as they are; anything else is reported as `other`. */
export const ENTRYPOINTS: readonly string[] = [
  'cli', 'sdk-cli', 'sdk-ts', 'sdk-py', 'mcp', 'claude-vscode', 'claude-desktop', 'claude-desktop-3p', 'local-agent', 'remote',
  'remote_baku', 'remote_cowork', 'remote_cowork_trigger', 'remote_trigger', 'remote_desktop', 'remote_mobile', 'remote_projects',
  'ssh-remote', 'claude-in-slack', 'claude_in_slack', 'claude-in-teams', 'claude-coworker', 'claude-coworker-terminal',
  'claude-code-github-action', 'claude-security', 't3-code', 'other',
]

/** Which path a row took to Mainwave: Claude Code's own exporter, or the plugin's copy (sender.ts). */
export const ROUTES: readonly string[] = ['exporter', 'plugin']

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** One rule per key: the value the key may carry. */
export const STAMP_RULES: Readonly<Record<StampKey, (value: string) => boolean>> = {
  'mainwave.plugin.name': v => v === PLUGIN_NAME,
  'mainwave.plugin.version': v => v.length <= 64 && SEMVER.test(v),
  'mainwave.plugin.entrypoint': v => ENTRYPOINTS.includes(v),
  'mainwave.telemetry.route': v => ROUTES.includes(v),
  [OPT_IN_STAMP]: v => {
    const ids = v.split(',')
    return new Set(ids).size === ids.length && ids.every(id => OPT_IN_IDS.includes(id))
  },
}

/** The count of secrets the always-on protections replaced in a record's values (gate.ts), under Mainwave's SDKs' name for it. */
export const REDACTION_COUNT = 'mainwave.redaction.count'

/** The keys the plugin writes with a number, and the value each may carry. */
export const COUNT_RULES: Readonly<Record<typeof REDACTION_COUNT, (value: number) => boolean>> = {
  [REDACTION_COUNT]: v => Number.isInteger(v) && v >= 1 && v <= 1_000_000,
}

/** `CLAUDE_CODE_ENTRYPOINT`, normalized to the list above. */
export function entrypointOf(raw: unknown): string {
  return typeof raw === 'string' && ENTRYPOINTS.includes(raw) ? raw : 'other'
}

const owned = (key: string) => OWNED_PREFIXES.some(prefix => key.startsWith(prefix))

/** The attributes without any key under an owned prefix, in their order. A key named `__proto__` stays a plain key. */
export function stripOwned<V>(attributes: Readonly<Record<string, V>>): Record<string, V> {
  const out: Record<string, V> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (owned(key)) continue
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return out
}

/** The stamps that pass their rule; the rest are dropped by key. */
export function filterStamps(stamps: Readonly<Record<string, unknown>>): { kept: Partial<Record<StampKey, string>>; dropped: string[] } {
  const kept: Partial<Record<StampKey, string>> = {}
  const dropped: string[] = []
  for (const [key, value] of Object.entries(stamps)) {
    const rule = Object.prototype.hasOwnProperty.call(STAMP_RULES, key) ? STAMP_RULES[key as StampKey] : undefined
    if (rule === undefined || typeof value !== 'string' || value.length > 256 || !rule(value)) {
      dropped.push(key)
      continue
    }
    kept[key as StampKey] = value
  }
  return { kept, dropped }
}

/** The row's attributes with every owned key removed and the stamps that pass their rules added. */
export function applyStamps<V>(attributes: Readonly<Record<string, V>>, stamps: Readonly<Record<string, unknown>>): Record<string, V | string> {
  return { ...stripOwned(attributes), ...filterStamps(stamps).kept }
}
