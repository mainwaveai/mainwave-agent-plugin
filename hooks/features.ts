// The extension point. A feature is a small addition that rides the plugin's own hooks instead of registering its own: the engine loads
// one hooks module per plugin and hooks each event once per plugin, so a feature can't be a second module. Pure: tests call it directly.
//
// A feature lives in `hooks/features/<name>/` and is listed in `FEATURES` below. It registers nothing. The plugin's hooks hand it:
// - every collector row, before the plugin's own stamps (`observe`): where a feature learns the session's identity or anything else rows say;
// - each event of the hooks named in `StepHookName`, before the plugin's own work (`steps`);
// - and, on a row that names a valid organization (where the plugin stamps), the feature's own stamps (`stamps`), under its own prefix.
// Every call is in its own `try`: a feature that throws is skipped for that call, and the plugin runs as if it were absent.
//
// A step that needs `$` can't be one of `steps`: the engine lets `$` pass only to a top-level function declaration named at the call site.
// Such a step is an exported top-level function of the feature, `export async function tagsTurnStart($, e)`, that register.ts calls by name
// inside the hook, in exactly this shape (scripts/check-features.sh holds every such call to it):
//
//   if (featureOn('tags')) try { await tagsTurnStart($, e) } catch {}

import type { PluginOptions, TelemetryAttribute } from 'claude-code'

/** The hooks whose event a feature's pure steps receive. */
export type StepHookName =
  | 'session.start' | 'turn.start' | 'turn.step' | 'turn.complete' | 'tool.call' | 'command.run' | 'prompt.submit' | 'agent.spawn' | 'skill.prompt' | 'session.end'

export type Feature = {
  /** kebab-case, unique. */
  name: string
  /** The attribute prefix the feature owns, `mainwave.<name>.`: every key under it is stripped from every row, the feature on or off. */
  prefix: string
  /** Whether the feature runs in this load, from the plugin's options (a `userConfig` field of its own, read once per load). */
  enabled: (options: Readonly<PluginOptions>) => boolean
  /** One rule per key the feature may stamp. A key without a rule, outside the prefix, or with a value that fails its rule is dropped. */
  rules: Readonly<Record<string, (value: TelemetryAttribute) => boolean>>
  steps?: Partial<Record<StepHookName, (e: unknown) => unknown>>
  observe?: (attributes: Readonly<Record<string, unknown>>, event: string) => void
  stamps?: (attributes: Readonly<Record<string, unknown>>, event: string) => Readonly<Record<string, TelemetryAttribute>>
  /** Called at every load, before `enabled`: the feature's memory starts over, as the module's does. */
  reset?: () => void
}

/** The prefixes the plugin itself owns (stamps.ts): no feature may take one, or one inside one. */
const CORE_PREFIXES = ['mainwave.plugin.', 'mainwave.telemetry.', 'mainwave.redaction.', 'mainwave.mod.']

/** The plugin's features, in the order they run. Adding one: its folder, one entry here, and its `userConfig` flag in plugin.json. */
export const FEATURES: readonly Feature[] = []

let all: readonly Feature[] = FEATURES
let active: readonly Feature[] = []
let on: ReadonlySet<string> = new Set()

const PREFIX_RULE = /^mainwave\.[a-z][a-z0-9_]*\.$/

/** Whether a feature list is well formed: unique names, each prefix of the `mainwave.<name>.` shape, unique, and no core prefix. */
export function validFeatures(list: readonly Feature[]): boolean {
  const names = new Set(list.map(f => f.name))
  const prefixes = new Set(list.map(f => f.prefix))
  return names.size === list.length && prefixes.size === list.length &&
    list.every(f => /^[a-z][a-z0-9-]*$/.test(f.name) && PREFIX_RULE.test(f.prefix) && !CORE_PREFIXES.some(c => c.startsWith(f.prefix) || f.prefix.startsWith(c)))
}

/**
 * Runs at every load (register.ts), with the plugin's options: each feature resets, then those enabled are on for this load. A list that
 * is not well formed runs no feature at all. `list` is for tests; the plugin passes nothing.
 */
export function configureFeatures(options: Readonly<PluginOptions>, list: readonly Feature[] = FEATURES): void {
  all = validFeatures(list) ? list : []
  for (const f of all) {
    try {
      f.reset?.()
    } catch {
      // Its memory may be stale; it is still asked whether it is enabled.
    }
  }
  active = all.filter(f => {
    try {
      return f.enabled(options) === true
    } catch {
      return false
    }
  })
  on = new Set(active.map(f => f.name))
}

/** Whether the named feature runs in this load: the guard of each call that hands a feature `$`. */
export const featureOn = (name: string): boolean => on.has(name)

/** Every prefix a feature owns, whether or not it is on: the plugin strips them all from every row (stamps.ts). */
export const featurePrefixes = (): readonly string[] => all.map(f => f.prefix)

/** Each active feature's step for this hook, each in its own `try`. Never throws or rejects. */
export async function runSteps(hook: StepHookName, e: unknown): Promise<void> {
  for (const f of active) {
    try {
      await f.steps?.[hook]?.(e)
    } catch {
      // Skipped: the plugin's hook runs as if the feature were absent.
    }
  }
}

/** Each active feature learns from a row, as it came. Never throws. */
export function observeFeatures(attributes: Readonly<Record<string, unknown>>, event: string): void {
  for (const f of active) {
    try {
      f.observe?.(attributes, event)
    } catch {
      // This feature learns nothing from this row.
    }
  }
}

/** The active features' stamps for a row that names an organization: each key inside its feature's prefix and passing its rule. Never throws. */
export function featureStamps(attributes: Readonly<Record<string, unknown>>, event: string): Record<string, TelemetryAttribute> {
  const out: Record<string, TelemetryAttribute> = {}
  for (const f of active) {
    let add: Readonly<Record<string, TelemetryAttribute>> | undefined
    try {
      add = f.stamps?.(attributes, event)
    } catch {
      continue
    }
    if (add === undefined || add === null || typeof add !== 'object') continue
    for (const [key, value] of Object.entries(add)) {
      if (!key.startsWith(f.prefix) || !Object.prototype.hasOwnProperty.call(f.rules, key)) continue
      let ok = false
      try {
        ok = f.rules[key]!(value) === true
      } catch {
        ok = false
      }
      if (ok) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
    }
  }
  return out
}
