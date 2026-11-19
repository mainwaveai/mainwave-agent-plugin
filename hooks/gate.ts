// The gate: the one place that decides, per data point (catalog.ts), what the plugin sends. Pure functions, and the gate in force for
// this load (`currentGate`), which the hooks read as they capture and the sender reads again as it sends.
//
// Each data point is `on`, `off`, or `claude`:
//   on      sent, by the plugin's own reading where Claude Code's row or span leaves it out.
//   off     never sent: removed from every record, or `<REDACTED>` where Claude Code marks withheld text so.
//   claude  sent exactly where Claude Code sends it under the session's own settings, and nowhere more.
// With no organization settings, each takes its default (catalog.ts, `DEFAULTS`: metadata on, identifiers and content off). Once the
// organization's settings from Mainwave are in force (orgsettings.ts), each data point they name in force takes that instead
// (`setOverrides`, its second argument: what Mainwave's settings page shows, its catalog defaults included), so the plugin sends what the
// page shows; a data point they don't name keeps the plugin's default. A Claude Code switch the session's environment sets to `0`
// (`false`, `no`, `off`) turns the data points it governs that are on by default (or in force by default) to `claude`, so an admin who
// turned a capture off in Mainwave's org-wide setup keeps that choice. The person can opt in to data points still at a default of `off`
// (`setOptIn`, from their own user settings): each turns `on`. An explicit setting for a data point (`setOverrides`, its first argument:
// the data points the organization set itself on Mainwave's settings page) wins over all three, and the opt-in never raises a data point
// a switch at `0` governs (thinking counts as governed by the responses' switch, for this). It only adds: it never turns anything off.
// Required data points are always sent.
//
// Whatever the gate says, every identifier and content value goes through the always-on protections (protect.ts) before it is queued,
// with the redaction packs in force (packs.ts): those the organization chose (`setOrgPacks`: its managed settings and its data
// collection settings from Mainwave, orgsettings.ts), else the default, `DEFAULT_PACKS`; and those the person adds from their own user
// settings (`setPersonPacks`). The person's add to the organization's, never take from them. A choice that can't be read, or that names
// a pack the plugin does not have, holds every identifier and content value back (the record still goes): redaction that was asked for
// never silently turns off.

import type { TelemetryAttribute } from 'claude-code'

import { CATALOG, DATA_POINTS, DEFAULTS, METRIC_OWNERS, OUTPUT_OWNERS, OWN_ROWS, ownerOf, PARAMETER_OWNERS, sensitive, SKILL_PROMPT_ROW, TOOL_OUTPUT_EVENT, type DataPointId, type Switch } from './catalog.ts'
import type { BuiltSpan, CopiedRow, MetricPoint } from './otlp.ts'
import { DEFAULT_PACKS, EXEMPT_KEYS, PACK_NAMES, type PackName } from './packs.ts'
import { CONTENT_MAX_LENGTH, cut, redact } from './protect.ts'
import { MARKER_KEYS } from './markers.ts'
import { COMMAND_PREFIX, COMMAND_REF_KEYS, COUNT_RULES, filterStamps, OPT_IN_STAMP, REDACTION_COUNT } from './stamps.ts'

export type Setting = 'on' | 'off' | 'claude'
/**
 * The redaction in force: the packs that run, `secrets` always among them, in the order they run; or `held`, when a choice of packs
 * can't be read or names a pack the plugin does not have, and no identifier or content value is sent. `held` says which, never the
 * value.
 */
export type Redaction = { packs: readonly PackName[] } | { held: 'unreadable' | 'unknown pack' }
/** `optedIn`: the data points that are `on` because the person opted in, in catalog order. */
export type Gate = { settings: ReadonlyMap<DataPointId, Setting | 'required'>; limit: number; optedIn: readonly DataPointId[]; redaction: Redaction }
export type Overrides = Partial<Record<DataPointId, Setting>>


/**
 * For the opt-in alone, the switch a data point with none of its own follows: thinking is the model's output, as its responses are, so
 * a session that turned responses off (`OTEL_LOG_ASSISTANT_RESPONSES`, else `OTEL_LOG_USER_PROMPTS`) gets no thinking by opt-in. An
 * explicit setting for it is unchanged.
 */
const OPT_IN_SWITCH: Readonly<Partial<Record<DataPointId, Switch>>> = { 'response.thinking': 'OTEL_LOG_ASSISTANT_RESPONSES' }

/** Whether a switch's value turns it off, as Claude Code reads a false value. */
export const switchedOff = (raw: string | undefined): boolean => ['0', 'false', 'no', 'off'].includes((raw ?? '').trim().toLowerCase())

/**
 * The settings in force, in this order: an explicit setting; else, where the session's environment switched the data point's switch
 * off, `claude` for one on by default (one off by default stays off); else `on` for one off by default that the person opted in to;
 * else the default. The default is the organization's in force (`inForce`, Mainwave's reading of its settings with its catalog's
 * defaults) where it names the data point, else the plugin's own (`DEFAULTS`). The opt-in raises only a data point off by both, so
 * it lists only data points the person can opt in to (stamps.ts, `OPT_IN_IDS`). `optedIn` lists those the opt-in turned on that can
 * go somewhere: not one the data point it adds detail to keeps from going.
 */
export function resolveGate(
  env: Readonly<Partial<Record<Switch, string | undefined>>>,
  overrides: Overrides = {},
  limit = CONTENT_MAX_LENGTH,
  optIn: Iterable<DataPointId> = [],
  redaction: Redaction = resolveRedaction(undefined, undefined),
  inForce: Overrides = {},
): Gate {
  const settings = new Map<DataPointId, Setting | 'required'>()
  const wanted = new Set(optIn)
  const raised: DataPointId[] = []
  const value = (s: Switch) => (s === 'OTEL_LOG_ASSISTANT_RESPONSES' ? env.OTEL_LOG_ASSISTANT_RESPONSES ?? env.OTEL_LOG_USER_PROMPTS : env[s])
  for (const d of CATALOG) {
    if (d.required) {
      settings.set(d.id, 'required')
      continue
    }
    const explicit = overrides[d.id]
    const own = DEFAULTS[d.id as keyof typeof DEFAULTS]
    const byDefault = inForce[d.id] ?? own
    const switched = d.switch !== undefined && switchedOff(value(d.switch))
    const follows = OPT_IN_SWITCH[d.id]
    if (explicit !== undefined) settings.set(d.id, explicit)
    else if (switched) settings.set(d.id, byDefault === 'on' ? 'claude' : byDefault)
    else if (byDefault === 'off' && own === 'off' && wanted.has(d.id) && !(follows !== undefined && switchedOff(value(follows)))) {
      settings.set(d.id, 'on')
      raised.push(d.id)
    } else settings.set(d.id, byDefault)
  }
  const gate: Gate = { settings, limit, optedIn: [], redaction }
  return { ...gate, optedIn: raised.filter(id => allows(gate, id, false)) }
}

/**
 * A gate with every data point on, the length limit of the gate in force: what the rebuild builds records with while the organization's
 * settings have yet to first answer (register.ts), so nothing is left out that the answer may turn on. Nothing it builds is sent
 * through it: each record waits for the answer, then goes through the gate in force, strictly.
 */
export function openGate(): Gate {
  const all: Overrides = Object.fromEntries(CATALOG.filter(d => !d.required).map(d => [d.id, 'on']))
  return { ...resolveGate({}, all, current.limit), optedIn: [] }
}

// ── Redaction packs ───────────────────────────────────────────────────────────

/**
 * What one source says of the packs: the names it lists, as written; `unreadable` for a value of the wrong type or a source that
 * can't be read; undefined when it says nothing.
 */
export type PackChoice = readonly string[] | 'unreadable' | undefined

/**
 * The packs a value of the packs option lists: a list of names, or one string of names separated by commas or spaces. Unset (or
 * `null`) says nothing; any other value, or a list holding anything but strings, is `unreadable`. Names are checked in
 * `resolveRedaction`, not here.
 */
export function packsOf(raw: unknown): PackChoice {
  if (raw === undefined || raw === null) return undefined
  const items = typeof raw === 'string' ? raw.split(/[\s,]+/) : Array.isArray(raw) && raw.every(v => typeof v === 'string') ? (raw as string[]) : undefined
  if (items === undefined) return 'unreadable'
  return items.map(v => v.trim()).filter(v => v !== '')
}

/** Several sources of one party as one choice: `unreadable` if any is, else every name any lists; undefined when none says anything. */
export function combinePacks(choices: Iterable<PackChoice>): PackChoice {
  let out: string[] | undefined
  for (const c of choices) {
    if (c === 'unreadable') return 'unreadable'
    if (c !== undefined) out = [...(out ?? []), ...c]
  }
  return out
}

/**
 * The redaction in force from the organization's choice and the person's: the organization's packs, or `DEFAULT_PACKS` where it chose
 * none, with the person's added, and `secrets` always; in the order the packs run. `held` when either can't be read or names a pack
 * the plugin does not have.
 */
export function resolveRedaction(org: PackChoice, person: PackChoice): Redaction {
  if (org === 'unreadable' || person === 'unreadable') return { held: 'unreadable' }
  const named = new Set<string>([...(org ?? DEFAULT_PACKS), ...(person ?? []), 'secrets'])
  if ([...named].some(n => !(PACK_NAMES as readonly string[]).includes(n))) return { held: 'unknown pack' }
  return { packs: PACK_NAMES.filter(p => named.has(p)) }
}

/**
 * Whether a data point goes out at one place: `claude` says whether Claude Code sends it there under the session's settings (on its
 * row, it is there; on a span the plugin rebuilds, Claude Code's own rule). A data point that holds others goes only where they all do,
 * and one that adds detail to another only where that one goes.
 */
export function allows(gate: Gate, id: DataPointId, claude: boolean): boolean {
  const s = gate.settings.get(id)
  const own = s === 'required' || s === 'on' || (s === 'claude' && claude)
  const d = DATA_POINTS.get(id)
  return own && (d?.holds ?? []).every(h => allows(gate, h, claude)) && (d?.needs === undefined || allows(gate, d.needs, claude))
}

// ── The gate in force ─────────────────────────────────────────────────────────

let env: Partial<Record<Switch, string | undefined>> = {}
let overrides: Overrides = {}
let inForce: Overrides = {}
let limit = CONTENT_MAX_LENGTH
let optIn: readonly DataPointId[] = []
/** The organization's choice of packs by where it came from: its data collection settings (`settings`), its managed settings. */
let orgPacks: Partial<Record<'settings' | 'managed', PackChoice>> = {}
let personPacks: PackChoice = undefined
let current: Gate = resolveGate(env, overrides, limit, optIn)

const refresh = () => {
  current = resolveGate(env, overrides, limit, optIn, resolveRedaction(combinePacks(Object.values(orgPacks)), personPacks), inForce)
}

/** The gate in force for this load. */
export const currentGate = (): Gate => current

/** The session's switches and length limit, read once per load. */
export function configureGate(switches: Partial<Record<Switch, string | undefined>>, contentLimit: number = CONTENT_MAX_LENGTH): void {
  env = { ...switches }
  limit = contentLimit
  refresh()
}

/**
 * The organization's settings per data point: `next`, the explicit settings, over everything else; `org`, what is in force for the
 * organization (Mainwave's `in_force`), in place of the plugin's defaults for each data point it names. For tests, too.
 */
export function setOverrides(next: Overrides, org: Overrides = {}): void {
  overrides = { ...next }
  inForce = { ...org }
  refresh()
}

/** The data points the person opts in to (`optInOf`), from their own user settings: read once per load, and again before each send. */
export function setOptIn(next: readonly DataPointId[]): void {
  optIn = [...next]
  refresh()
}

/**
 * The organization's choice of packs from one source: `settings`, its data collection settings, as the plugin keeps them (`PACKS_KEY`);
 * `managed`, the packs option in its managed settings. Every source's packs apply.
 */
export function setOrgPacks(from: 'settings' | 'managed', choice: PackChoice): void {
  orgPacks = { ...orgPacks, [from]: choice }
  refresh()
}

/** The packs the person adds, from their own user settings: read once per load, and again before each send. */
export function setPersonPacks(choice: PackChoice): void {
  personPacks = choice
  refresh()
}

/** The choices of packs of an earlier load stand for nothing: the default until this one reads its own. */
export function resetPacks(): void {
  orgPacks = {}
  personPacks = undefined
  refresh()
}

/**
 * Where explicit settings per data point are kept, in the plugin's store: `{ "<data point>": "on" | "off" | "claude" }`, written by
 * hand: it applies while the store keeps no answer from Mainwave (orgsettings.ts, `SETTINGS_KEY`). A file the person can edit, so a
 * convenience, not a control.
 */
export const OVERRIDES_KEY = 'dataPoints'

/**
 * Where the organization's choice of packs is kept, in the plugin's store, beside `OVERRIDES_KEY`: a value of the packs option's shape
 * (`packsOf`), written by hand: it applies while the store keeps no answer from Mainwave, whose packs apply instead (orgsettings.ts). It
 * is read once per load and again before each send (sender.ts, `readOptions`), so a value written mid-session applies to records
 * already queued.
 */
export const PACKS_KEY = 'redactionPacks'

const SETTINGS: readonly string[] = ['on', 'off', 'claude']

/** Explicit settings as the store keeps them: each known, switchable data point with a known setting; anything else ignored. */
export function overridesOf(raw: unknown): Overrides {
  const out: Overrides = {}
  if (!isObject(raw)) return out
  for (const [id, setting] of Object.entries(raw)) {
    const d = DATA_POINTS.get(id as DataPointId)
    if (d !== undefined && !d.required && typeof setting === 'string' && SETTINGS.includes(setting)) out[d.id] = setting as Setting
  }
  return out
}

/**
 * The data points a value of the opt-in option lists: a list of IDs, or one string of IDs separated by commas or spaces. Each known
 * data point that has a setting, once, in catalog order; anything else (an unknown ID, a required data point, a value of another
 * type) is ignored. A data point on by default may be listed: it changes nothing.
 */
export function optInOf(raw: unknown): DataPointId[] {
  const items = typeof raw === 'string' ? raw.split(/[\s,]+/) : Array.isArray(raw) ? raw : []
  const named = new Set(items.filter((v): v is string => typeof v === 'string').map(v => v.trim()))
  return CATALOG.filter(d => !d.required && named.has(d.id)).map(d => d.id)
}

// ── Records ───────────────────────────────────────────────────────────────────

type Attrs = Record<string, TelemetryAttribute>

/** What the plugin read itself for a row Claude Code may have withheld it from: attributes, and keys of `tool_parameters`. */
export type RowFill = { attributes?: Readonly<Attrs>; parameters?: Readonly<Record<string, unknown>> }

const put = (out: Attrs, key: string, value: TelemetryAttribute) => Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** `tool_parameters`, its keys gated one by one and what the plugin read added; undefined when nothing is left. */
function gateParameters(gate: Gate, raw: TelemetryAttribute | undefined, fill: Readonly<Record<string, unknown>> | undefined, sent = true): string | undefined {
  let parsed: Record<string, unknown> | undefined
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw) as unknown
      parsed = isObject(p) ? p : undefined
    } catch {
      parsed = undefined
    }
    // Not an object Claude Code would write: it goes whole, or not at all, as tool input.
    if (parsed === undefined) return allows(gate, 'tool.input', sent) ? raw : undefined
  }
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [k, v] of Object.entries(parsed ?? {})) {
    const id = PARAMETER_OWNERS[k]
    if (id === undefined || allows(gate, id, sent)) out[k] = v
    else changed = true
  }
  for (const [k, v] of Object.entries(fill ?? {})) {
    const id = PARAMETER_OWNERS[k]
    if (k in out || v === undefined || id === undefined || !allows(gate, id, false)) continue
    out[k] = v
    changed = true
  }
  if (Object.keys(out).length === 0) return undefined
  return changed || typeof raw !== 'string' ? JSON.stringify(out) : raw
}

/** Whether an attribute's value is an identifier or content: the protections apply. */
function protectedKey(record: string, key: string): boolean {
  if (key === 'tool_parameters' || key === 'tool_input' || key === 'error') return true
  const owner = ownerOf(record, key)
  return owner !== undefined && sensitive(owner.id)
}

/**
 * One identifier or content value through the protections: secrets replaced, then the packs in force, unless `key` is one no pack
 * scans (packs.ts, `EXEMPT_KEYS`). Null when it must not be sent: the redaction is `held`, or the value could not be scanned.
 */
export function protectText(gate: Gate, text: string, key?: string): { text: string; count: number } | null {
  const exempt = key !== undefined && EXEMPT_KEYS.has(key)
  if ('held' in gate.redaction && !exempt) return null
  try {
    return redact(text, exempt || 'held' in gate.redaction ? [] : gate.redaction.packs)
  } catch {
    return null
  }
}

/**
 * The always-on protections on one record's attributes: in every identifier and content value (each string of a list too), secrets
 * replaced and the packs in force run, and a value past the limit cut first, with `<key>_truncated` and `<key>_original_length` beside
 * it. A value the protections can't clear is left out (`protectText`); the record goes without it. Answers how many matches were
 * replaced.
 */
export function protect(gate: Gate, record: string, attributes: Attrs, all = false): { attributes: Attrs; count: number } {
  const out: Attrs = {}
  let count = 0
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'number' || typeof value === 'boolean' || !(all || protectedKey(record, key))) {
      put(out, key, value)
      continue
    }
    if (Array.isArray(value)) {
      const items: string[] = []
      for (const item of value) {
        const r = typeof item === 'string' ? protectText(gate, cut(item, gate.limit).text, key) : null
        if (r === null) break
        items.push(r.text)
        count += r.count
      }
      if (items.length === value.length) put(out, key, items)
      continue
    }
    if (typeof value !== 'string') continue
    // Cut first, so the rules read a value of bounded length. A command stamp (a ref) goes whole or not at all: a ref cut short
    // names another ref.
    const c = cut(value, gate.limit)
    if (c.truncated && key.startsWith(COMMAND_PREFIX)) continue
    const r = protectText(gate, c.text, key)
    if (r === null) continue
    count += r.count
    put(out, key, r.text)
    if (c.truncated) {
      put(out, `${key}_truncated`, true)
      put(out, `${key}_original_length`, value.length)
    }
  }
  return { attributes: out, count }
}

/** Adds the count of matches replaced to a record's own, if any were. */
function withCount(attributes: Attrs, count: number): Attrs {
  if (count === 0) return attributes
  const before = typeof attributes[REDACTION_COUNT] === 'number' ? (attributes[REDACTION_COUNT] as number) : 0
  const total = Math.min(before + count, 1_000_000)
  return COUNT_RULES[REDACTION_COUNT](total) ? { ...attributes, [REDACTION_COUNT]: total } : attributes
}

/**
 * One record's attributes through the gate, in their order: each attribute of a data point that may not go there removed (or
 * `<REDACTED>` where Claude Code marks withheld text so), Claude Code's `tool_parameters` and `tool_input` gated by what they hold,
 * what the plugin read added where its data point is on, then the protections. `record` is a row's event, or a span's or a metric's
 * name.
 */
export function gateAttributes(gate: Gate, record: string, attributes: Readonly<Attrs>, fill: RowFill = {}, strict = false): Attrs {
  const out: Attrs = {}
  // What is there goes where Claude Code would have sent it; `strict`, for a record whose capture this load did not see, only where
  // the data point is on.
  const sent = !strict
  const mcpOff = !allows(gate, 'tool.mcp', sent)
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'tool_parameters') {
      const p = gateParameters(gate, value, fill.parameters, sent)
      if (p !== undefined) put(out, key, p)
      continue
    }
    if (key === 'tool_input') {
      if (allows(gate, 'tool.input', sent)) put(out, key, value)
      continue
    }
    // An MCP tool's name names its server and tool: with those off, it reads as Claude Code writes it when it withholds them.
    const mcpName = typeof value === 'string' && (value.startsWith('mcp__') || (key === 'gen_ai.tool.name' && attributes['anthropic.mcp.server.name'] !== undefined))
    if (mcpOff && mcpName && (key === 'tool_name' || key === 'gen_ai.tool.name' || key === 'tool_name_safe')) {
      if (allows(gate, 'tool.call', sent)) put(out, key, key === 'tool_name_safe' ? 'mcp_other' : 'mcp_tool')
      continue
    }
    const owner = ownerOf(record, key)
    // Claude Code writes no command stamp, so one goes only where its data point is on.
    if (owner === undefined || allows(gate, owner.id, sent && !key.startsWith(COMMAND_PREFIX))) put(out, key, value)
    else if (owner.redact) put(out, key, '<REDACTED>')
  }
  // What the plugin read, where Claude Code left it out or withheld it, and its data point is on.
  for (const [key, value] of Object.entries(fill.attributes ?? {})) {
    const have = out[key]
    if (have !== undefined && have !== '<REDACTED>') continue
    const ok = key === 'tool_input' ? allows(gate, 'tool.input', false) : (() => {
      const owner = ownerOf(record, key)
      return owner !== undefined && allows(gate, owner.id, false)
    })()
    if (ok) put(out, key, value)
  }
  if (fill.parameters !== undefined && !('tool_parameters' in out)) {
    const p = gateParameters(gate, undefined, fill.parameters)
    if (p !== undefined) put(out, 'tool_parameters', p)
  }
  // A command's ref goes only beside its count: with `bash.outcome` off, the ref goes too.
  for (const [ref, count] of COMMAND_REF_KEYS) if (ref in out && !(count in out)) delete out[ref]
  // A skill's text with its arguments filled in holds words the person typed: it goes only where prompts do, else it is held back.
  if (record === SKILL_PROMPT_ROW && out['skill.has_arguments'] === true && out['skill.text'] !== undefined && !allows(gate, 'prompt.text', false)) {
    delete out['skill.text']
    put(out, 'skill.text_held_back', true)
  }
  const { attributes: safe, count } = protect(gate, record, out)
  return withCount(safe, count)
}

/** A span event through the gate: its attributes, or null when its data point is off. A tool's output is all content. */
export function gateEvent(gate: Gate, event: { name: string; timeMs: number; attributes: Readonly<Attrs> }, strict = false): { event: typeof event; count: number } | null {
  if (event.name !== TOOL_OUTPUT_EVENT) return { event, count: 0 }
  if (!allows(gate, 'tool.result', !strict)) return null
  const kept: Attrs = {}
  for (const [key, value] of Object.entries(event.attributes)) {
    const base = key.replace(/_(truncated|original_length)$/, '')
    const id = OUTPUT_OWNERS[base]
    if (id === undefined || allows(gate, id, !strict)) put(kept, key, value)
  }
  const { attributes, count } = protect(gate, event.name, kept, true)
  return { event: { ...event, attributes }, count }
}

/**
 * A record's resource (JSON, as the sender keeps it) through the protections: each string value but those of the keys no pack scans,
 * as the CLI hooks scan a resource, since `OTEL_RESOURCE_ATTRIBUTES` can hold anything. A value the protections can't clear is left
 * out. The resource carries no count.
 */
export function gateResource(gate: Gate, resource: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(resource)
  } catch {
    // Not one the sender wrote: nothing in it is sent.
    return '{}'
  }
  if (!isObject(parsed)) return resource
  const out: Attrs = {}
  let changed = false
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || EXEMPT_KEYS.has(key)) {
      put(out, key, value as TelemetryAttribute)
      continue
    }
    const r = protectText(gate, cut(value, gate.limit).text, key)
    if (r !== null) put(out, key, r.text)
    if (r === null || r.text !== value) changed = true
  }
  return changed ? JSON.stringify(out) : resource
}

/** Whether a metric's points may go at all: none of a metric's a data point counts (catalog.ts, `METRIC_OWNERS`) while it is off. */
export const metricAllowed = (gate: Gate, name: string, strict = false): boolean => METRIC_OWNERS[name] === undefined || allows(gate, METRIC_OWNERS[name]!, !strict)

/**
 * A record's attributes stamped with the gate it went through: `mainwave.telemetry.opt_in` lists the data points the person's opt-in
 * turned on, and is left off where it turned none on. Re-stamped each time a record goes through the gate, so a record sent carries
 * the opt-in it was sent under.
 */
function withOptIn(gate: Gate, attributes: Attrs): Attrs {
  const out: Attrs = {}
  for (const [key, value] of Object.entries(attributes)) if (key !== OPT_IN_STAMP) put(out, key, value)
  if (gate.optedIn.length === 0) return out
  const stamp = filterStamps({ [OPT_IN_STAMP]: gate.optedIn.join(',') }).kept[OPT_IN_STAMP]
  if (stamp !== undefined) put(out, OPT_IN_STAMP, stamp)
  return out
}

/**
 * A span the plugin rebuilt, through the gate: its attributes and events, and its status message, which repeats a failed run's
 * `error`. A run's error text is a tool result: with those off, the run keeps only the error's class, as Claude Code's does.
 */
export function gateSpan(gate: Gate, span: BuiltSpan, strict = false): BuiltSpan {
  let attributes = gateAttributes(gate, span.name, span.attributes, {}, strict)
  let status = span.status
  // A failed run's error text can repeat what the call read and ran: it goes with tool results and tool input alone.
  const errorText = allows(gate, 'tool.result', !strict) && allows(gate, 'tool.input', !strict)
  let count = 0
  if (span.name === 'claude_code.tool.execution' && !errorText && attributes['error'] !== undefined && attributes['error'] !== attributes['error_class']) {
    const { error: _text, ...rest } = attributes
    const cls = attributes['error_class']
    attributes = cls === undefined ? rest : gateAttributes(gate, span.name, { ...attributes, error: cls })
    if (status?.message !== undefined) status = typeof cls === 'string' ? { ...status, message: cls } : { code: status.code }
  } else if (status?.message !== undefined) {
    // The message repeats the error: the protections apply to it as to the attribute, cut first, and it is left out where the attribute
    // would be.
    const r = protectText(gate, cut(status.message, gate.limit).text)
    status = r === null ? { code: status.code } : { ...status, message: r.text }
    count += r?.count ?? 0
  }
  const events: NonNullable<BuiltSpan['events']> = []
  for (const e of span.events ?? []) {
    const g = gateEvent(gate, e, strict)
    if (g === null) continue
    events.push(g.event)
    count += g.count
  }
  return { ...span, attributes: withOptIn(gate, withCount(attributes, count)), ...(span.events ? { events } : {}), ...(status ? { status } : {}) }
}

/**
 * A span through the gate, a marker (markers.ts) among them: a marker goes only while the data point of its key is on and its key
 * comes through the gate; null otherwise. Any other span as `gateSpan` has it.
 */
export function gateMarker(gate: Gate, span: BuiltSpan, strict = false): BuiltSpan | null {
  const key = Object.prototype.hasOwnProperty.call(MARKER_KEYS, span.name) ? MARKER_KEYS[span.name] : undefined
  if (key === undefined) return gateSpan(gate, span, strict)
  if (key.point !== undefined && !allows(gate, key.point, false)) return null
  // Strict: Claude Code sends none of a marker's values, so a data point set to as Claude Code sends it sends none of them either.
  const gated = gateSpan(gate, span, true)
  return gated.attributes[key.attribute] === undefined ? null : gated
}

/**
 * A row through the gate, as it is queued and again as it is sent: no data is added, only what the gate in force now holds back is
 * removed, and the row stamped with the opt-in of that gate. A row the plugin makes itself (catalog.ts, `OWN_ROWS`) goes only while
 * its data point is on: null otherwise.
 */
export function gateRow(gate: Gate, row: CopiedRow, strict = false): CopiedRow | null {
  const own = OWN_ROWS[row.event]
  if (own !== undefined && !allows(gate, own, false)) return null
  return { ...row, attributes: withOptIn(gate, gateAttributes(gate, row.event, row.attributes, {}, strict)) }
}

/** A metric point through the gate: null when its metric's data point is off. */
export function gatePoint(gate: Gate, point: MetricPoint, strict = false): MetricPoint | null {
  return metricAllowed(gate, point.name, strict) ? { ...point, attributes: gateAttributes(gate, point.name, point.attributes, {}, strict) } : null
}
