// What the plugin may put on a telemetry row, and the check that keeps everything else of ours off it. Pure: tests call it directly.
//
// Every key under an owned prefix is the plugin's alone. A row reaches the hook from Claude Code, but anything upstream of it (another
// plugin, an older copy of this one, an OTEL setting a repository controls) could already have written keys that look like ours, so
// they are removed before the plugin adds its own. What the plugin adds passes a shape check per key: a key without a rule, or a value
// that fails its rule, is dropped, never sent.

import { DEFAULTS } from './catalog.ts'
import { COMMAND_COUNTS, COMMAND_REFS, type CommandCount, type CommandRef } from './derive.ts'

/** The plugin's name on every row it stamps. */
export const PLUGIN_NAME = 'mainwave'

/** Where the plugin stamps what a shell command did on the command's `claude_code.tool` span (`commandStamps`). */
export const COMMAND_PREFIX = 'mainwave.command.'

/**
 * Key prefixes the plugin owns. Any key under one of them that the plugin did not write this time is removed from the row.
 * `mainwave.mod.` is where earlier Mainwave plugins, and this one before it named its stamps `mainwave.plugin.*`, put theirs: the
 * plugin writes nothing there, and strips it so no row carries an old-named stamp beside its own.
 */
export const OWNED_PREFIXES: readonly string[] = ['mainwave.plugin.', 'mainwave.telemetry.', 'mainwave.redaction.', 'mainwave.mod.', COMMAND_PREFIX]

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

/**
 * The codes of what the plugin found wrong with the session's telemetry setup (setup.ts), on its own `plugin_status` row alone: a list
 * of these, each once, in this order. A fixed list, never free text: Mainwave reads each code as one cause and what fixes it.
 */
export const ISSUES_STAMP = 'mainwave.telemetry.issues'
export const ISSUE_CODES = [
  'rows_skipped', 'cli_hooks_no_exporter', 'exporter_no_endpoint', 'exporter_no_key', 'exporter_elsewhere', 'settings_unavailable',
  'redaction_unreadable', 'redaction_unknown_pack', 'copy_dropped',
] as const
export type IssueCode = (typeof ISSUE_CODES)[number]

/** The value the issues stamp may carry: one or more known codes, each once, in `ISSUE_CODES`' order. */
export const ISSUES_RULE = (v: unknown): v is IssueCode[] => {
  if (!Array.isArray(v) || v.length === 0 || v.length > ISSUE_CODES.length) return false
  const at = v.map(c => (ISSUE_CODES as readonly unknown[]).indexOf(c))
  return at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]!))
}

/** The issues stamp for a list of codes: `{}` when there are none, or the list fails its rule. */
export function issuesStamp(codes: readonly string[]): Record<string, string[]> {
  return codes.length > 0 && ISSUES_RULE([...codes]) ? { [ISSUES_STAMP]: [...codes] } : {}
}

/** The count of secrets the always-on protections replaced in a record's values (gate.ts), under Mainwave's SDKs' name for it. */
export const REDACTION_COUNT = 'mainwave.redaction.count'

/** The keys the plugin writes with a number, and the value each may carry. */
export const COUNT_RULES: Readonly<Record<typeof REDACTION_COUNT, (value: number) => boolean>> = {
  [REDACTION_COUNT]: v => Number.isInteger(v) && v >= 1 && v <= 1_000_000,
}

/** On every shell command's span while its outcomes go: the plugin read the command, so a span with no count made none. */
export const COMMAND_COUNTED = `${COMMAND_PREFIX}counted`
/** A count's key, and a ref's. */
export const commandKey = (name: CommandCount | CommandRef): string => `${COMMAND_PREFIX}${name}`
/** Each ref's key, with the key of the count it goes beside: a ref goes only where its count does. */
export const COMMAND_REF_KEYS: ReadonlyMap<string, string> = new Map(Object.entries(COMMAND_REFS).map(([ref, count]) => [commandKey(ref as CommandRef), commandKey(count)]))
/** Every key under the command prefix the plugin writes. */
export const COMMAND_KEYS: readonly string[] = [COMMAND_COUNTED, ...COMMAND_COUNTS.map(commandKey), ...COMMAND_REF_KEYS.keys()]

/**
 * A ref as the plugin sends it: what the ref's pattern captured, at most 256 characters, no space or control character. The pattern
 * reads RE2's six ASCII spaces as spaces; a ref holding another space, such as U+00A0, is left off.
 */
const REF_SHAPE = /^[^\s\x00-\x20\x7f]{1,256}$/

/** The value each command key may carry: `counted` and `branches_opened` 1, the other counts a positive integer Mainwave reads (16 bits), a ref its shape. */
export const COMMAND_RULES: Readonly<Record<string, (value: unknown) => boolean>> = Object.fromEntries([
  [COMMAND_COUNTED, (v: unknown) => v === 1],
  ...COMMAND_COUNTS.map(c => [commandKey(c), c === 'branches_opened' ? (v: unknown) => v === 1 : (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65_535] as const),
  ...[...COMMAND_REF_KEYS.keys()].map(k => [k, (v: unknown) => typeof v === 'string' && REF_SHAPE.test(v)] as const),
])

/**
 * The stamps for one shell command's span: `counted`, and for a command that succeeded (`found`), each count above 0, and with
 * `refs` each ref beside its count. A value that fails its rule is dropped, and a ref whose count is not sent with it.
 */
export function commandStamps(found: { counts: Partial<Record<CommandCount, number>>; refs: Partial<Record<CommandRef, string>> } | undefined, refs: boolean): Record<string, number | string> {
  const out: Record<string, number | string> = { [COMMAND_COUNTED]: 1 }
  const put = (key: string, value: unknown) => {
    if (COMMAND_RULES[key]?.(value)) out[key] = value as number | string
  }
  for (const c of COMMAND_COUNTS) put(commandKey(c), found?.counts[c])
  if (refs) for (const [key, count] of COMMAND_REF_KEYS) if (out[count] !== undefined) put(key, found?.refs[key.slice(COMMAND_PREFIX.length) as CommandRef])
  return out
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
