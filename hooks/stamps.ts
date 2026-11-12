// What the plugin may put on a telemetry row, and the check that keeps everything else of ours off it. Pure: tests call it directly.
//
// Every key under an owned prefix is the plugin's alone. A row reaches the hook from Claude Code, but anything upstream of it (another
// plugin, an older copy of this one, an OTEL setting a repository controls) could already have written keys that look like ours, so
// they are removed before the plugin adds its own. What the plugin adds passes a shape check per key: a key without a rule, or a value
// that fails its rule, is dropped, never sent.

/** The plugin's name on every row it stamps. */
export const PLUGIN_NAME = 'mainwave'

/** Key prefixes the plugin owns. Any key under one of them that the plugin did not write this time is removed from the row. */
export const OWNED_PREFIXES: readonly string[] = ['mainwave.mod.', 'mainwave.telemetry.']

/** Every key the plugin stamps. */
export type StampKey = 'mainwave.mod.name' | 'mainwave.mod.version' | 'mainwave.mod.entrypoint' | 'mainwave.telemetry.source'

/** `CLAUDE_CODE_ENTRYPOINT` values the plugin reports as they are; anything else is reported as `other`. */
export const ENTRYPOINTS: readonly string[] = [
  'cli', 'sdk-cli', 'sdk-ts', 'sdk-py', 'mcp', 'claude-vscode', 'claude-desktop', 'claude-desktop-3p', 'local-agent', 'remote',
  'remote_baku', 'remote_cowork', 'remote_cowork_trigger', 'remote_trigger', 'remote_desktop', 'remote_mobile', 'remote_projects',
  'ssh-remote', 'claude-in-slack', 'claude_in_slack', 'claude-in-teams', 'claude-coworker', 'claude-coworker-terminal',
  'claude-code-github-action', 'claude-security', 'other',
]

/** Where the reporting switch's answer came from (settings.ts). */
export const SWITCH_SOURCES: readonly string[] = ['policy', 'user', 'default']

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** One rule per key: the value the key may carry. */
export const STAMP_RULES: Readonly<Record<StampKey, (value: string) => boolean>> = {
  'mainwave.mod.name': v => v === PLUGIN_NAME,
  'mainwave.mod.version': v => v.length <= 64 && SEMVER.test(v),
  'mainwave.mod.entrypoint': v => ENTRYPOINTS.includes(v),
  'mainwave.telemetry.source': v => SWITCH_SOURCES.includes(v),
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
