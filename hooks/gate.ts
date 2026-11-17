// The gate: the one place that decides, per data point (catalog.ts), what the plugin sends. Pure functions, and the gate in force for
// this load (`currentGate`), which the hooks read as they capture and the sender reads again as it sends.
//
// Each data point is `on`, `off`, or `claude`:
//   on      sent, by the plugin's own reading where Claude Code's row or span leaves it out.
//   off     never sent: removed from every record, or `<REDACTED>` where Claude Code marks withheld text so.
//   claude  sent exactly where Claude Code sends it under the session's own settings, and nowhere more.
// With no organization settings, each takes its default (catalog.ts, `DEFAULTS`); a Claude Code switch the session's environment
// sets to `0` (`false`, `no`, `off`) turns the data points it governs to `claude`, so an admin who turned a capture off in Mainwave's
// org-wide setup keeps that choice. An explicit setting for a data point (`setOverrides`, for organization settings) wins over both.
// Required data points are always sent.
//
// Whatever the gate says, every identifier and content value goes through the always-on protections (protect.ts) before it is queued.

import type { TelemetryAttribute } from 'claude-code'

import { CATALOG, DATA_POINTS, DEFAULTS, OUTPUT_OWNERS, ownerOf, PARAMETER_OWNERS, sensitive, TOOL_OUTPUT_EVENT, type DataPointId, type Switch } from './catalog.ts'
import type { BuiltSpan, CopiedRow, MetricPoint } from './otlp.ts'
import { CONTENT_MAX_LENGTH, cut, redact } from './protect.ts'
import { COUNT_RULES, REDACTION_COUNT } from './stamps.ts'

export type Setting = 'on' | 'off' | 'claude'
export type Gate = { settings: ReadonlyMap<DataPointId, Setting | 'required'>; limit: number }
export type Overrides = Partial<Record<DataPointId, Setting>>


/** Whether a switch's value turns it off, as Claude Code reads a false value. */
export const switchedOff = (raw: string | undefined): boolean => ['0', 'false', 'no', 'off'].includes((raw ?? '').trim().toLowerCase())

/** The settings in force: overrides, else the default, turned to `claude` where the session's environment switched it off. */
export function resolveGate(env: Readonly<Partial<Record<Switch, string | undefined>>>, overrides: Overrides = {}, limit = CONTENT_MAX_LENGTH): Gate {
  const settings = new Map<DataPointId, Setting | 'required'>()
  const value = (s: Switch) => (s === 'OTEL_LOG_ASSISTANT_RESPONSES' ? env.OTEL_LOG_ASSISTANT_RESPONSES ?? env.OTEL_LOG_USER_PROMPTS : env[s])
  for (const d of CATALOG) {
    if (d.required) {
      settings.set(d.id, 'required')
      continue
    }
    const explicit = overrides[d.id]
    const byDefault = DEFAULTS[d.id as keyof typeof DEFAULTS]
    settings.set(d.id, explicit ?? (byDefault === 'on' && d.switch !== undefined && switchedOff(value(d.switch)) ? 'claude' : byDefault))
  }
  return { settings, limit }
}

/**
 * Whether a data point goes out at one place: `claude` says whether Claude Code sends it there under the session's settings (on its
 * row, it is there; on a span the plugin rebuilds, Claude Code's own rule). A data point that holds others goes only where they all do.
 */
export function allows(gate: Gate, id: DataPointId, claude: boolean): boolean {
  const s = gate.settings.get(id)
  const own = s === 'required' || s === 'on' || (s === 'claude' && claude)
  return own && (DATA_POINTS.get(id)?.holds ?? []).every(h => allows(gate, h, claude))
}

// ── The gate in force ─────────────────────────────────────────────────────────

let env: Partial<Record<Switch, string | undefined>> = {}
let overrides: Overrides = {}
let limit = CONTENT_MAX_LENGTH
let current: Gate = resolveGate(env, overrides, limit)

/** The gate in force for this load. */
export const currentGate = (): Gate => current

/** The session's switches and length limit, read once per load. */
export function configureGate(switches: Partial<Record<Switch, string | undefined>>, contentLimit: number = CONTENT_MAX_LENGTH): void {
  env = { ...switches }
  limit = contentLimit
  current = resolveGate(env, overrides, limit)
}

/** Explicit settings per data point, over the defaults: for organization settings, and for tests. */
export function setOverrides(next: Overrides): void {
  overrides = { ...next }
  current = resolveGate(env, overrides, limit)
}

/**
 * Where explicit settings per data point are kept, in the plugin's store: `{ "<data point>": "on" | "off" | "claude" }`. Nothing
 * writes it yet: the organization's settings will be kept here. A file the person can edit, so a convenience, not a control.
 */
export const OVERRIDES_KEY = 'dataPoints'

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

// ── Records ───────────────────────────────────────────────────────────────────

type Attrs = Record<string, TelemetryAttribute>

/** What the plugin read itself for a row Claude Code may have withheld it from: attributes, and keys of `tool_parameters`. */
export type RowFill = { attributes?: Readonly<Attrs>; parameters?: Readonly<Record<string, unknown>> }

const put = (out: Attrs, key: string, value: TelemetryAttribute) => Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** `tool_parameters`, its keys gated one by one and what the plugin read added; undefined when nothing is left. */
function gateParameters(gate: Gate, raw: TelemetryAttribute | undefined, fill: Readonly<Record<string, unknown>> | undefined): string | undefined {
  let parsed: Record<string, unknown> | undefined
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw) as unknown
      parsed = isObject(p) ? p : undefined
    } catch {
      parsed = undefined
    }
    // Not an object Claude Code would write: it goes whole, or not at all, as tool input.
    if (parsed === undefined) return allows(gate, 'tool.input', true) ? raw : undefined
  }
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [k, v] of Object.entries(parsed ?? {})) {
    const id = PARAMETER_OWNERS[k]
    if (id === undefined || allows(gate, id, true)) out[k] = v
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
 * The always-on protections on one record's attributes: secrets replaced in every identifier and content value, and a value past the
 * limit cut, with `<key>_truncated` and `<key>_original_length` beside it. Answers how many secrets were replaced.
 */
export function protect(gate: Gate, record: string, attributes: Attrs, all = false): { attributes: Attrs; count: number } {
  const out: Attrs = {}
  let count = 0
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== 'string' || !(all || protectedKey(record, key))) {
      put(out, key, value)
      continue
    }
    const r = redact(value)
    count += r.count
    const c = cut(r.text, gate.limit)
    put(out, key, c.text)
    if (c.truncated) {
      put(out, `${key}_truncated`, true)
      put(out, `${key}_original_length`, r.text.length)
    }
  }
  return { attributes: out, count }
}

/** Adds the count of secrets replaced to a record's own, if any were. */
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
export function gateAttributes(gate: Gate, record: string, attributes: Readonly<Attrs>, fill: RowFill = {}): Attrs {
  const out: Attrs = {}
  const mcpOff = !allows(gate, 'tool.mcp', true)
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'tool_parameters') {
      const p = gateParameters(gate, value, fill.parameters)
      if (p !== undefined) put(out, key, p)
      continue
    }
    if (key === 'tool_input') {
      if (allows(gate, 'tool.input', true)) put(out, key, value)
      continue
    }
    // An MCP tool's name names its server and tool: with those off, it reads as Claude Code writes it when it withholds them.
    if (mcpOff && (key === 'tool_name' || (key === 'gen_ai.tool.name' && attributes['anthropic.mcp.server.name'] !== undefined)) && typeof value === 'string' && (value.startsWith('mcp__') || key === 'gen_ai.tool.name')) {
      if (allows(gate, 'tool.call', true)) put(out, key, 'mcp_tool')
      continue
    }
    const owner = ownerOf(record, key)
    if (owner === undefined || allows(gate, owner.id, true)) put(out, key, value)
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
  const { attributes: safe, count } = protect(gate, record, out)
  return withCount(safe, count)
}

/** A span event through the gate: its attributes, or null when its data point is off. A tool's output is all content. */
export function gateEvent(gate: Gate, event: { name: string; timeMs: number; attributes: Readonly<Attrs> }): { event: typeof event; count: number } | null {
  if (event.name !== TOOL_OUTPUT_EVENT) return { event, count: 0 }
  if (!allows(gate, 'tool.result', true)) return null
  const kept: Attrs = {}
  for (const [key, value] of Object.entries(event.attributes)) {
    const base = key.replace(/_(truncated|original_length)$/, '')
    const id = OUTPUT_OWNERS[base]
    if (id === undefined || allows(gate, id, true)) put(kept, key, value)
  }
  const { attributes, count } = protect(gate, event.name, kept, true)
  return { event: { ...event, attributes }, count }
}

/** Metric points a data point counts: none of them is sent while it is off. */
const COUNTED_BY: Readonly<Record<string, DataPointId>> = { 'claude_code.commit.count': 'bash.outcome', 'claude_code.pull_request.count': 'bash.outcome' }

/** Whether a metric's points may go at all. */
export const metricAllowed = (gate: Gate, name: string): boolean => COUNTED_BY[name] === undefined || allows(gate, COUNTED_BY[name]!, true)

/**
 * A span the plugin rebuilt, through the gate: its attributes and events, and its status message, which repeats a failed run's
 * `error`. A run's error text is a tool result: with those off, the run keeps only the error's class, as Claude Code's does.
 */
export function gateSpan(gate: Gate, span: BuiltSpan): BuiltSpan {
  let attributes = gateAttributes(gate, span.name, span.attributes)
  let status = span.status
  if (span.name === 'claude_code.tool.execution' && !allows(gate, 'tool.result', true) && attributes['error'] !== undefined && attributes['error'] !== attributes['error_class']) {
    const { error: _text, ...rest } = attributes
    const cls = attributes['error_class']
    attributes = cls === undefined ? rest : gateAttributes(gate, span.name, { ...attributes, error: cls })
    if (status?.message !== undefined) status = typeof cls === 'string' ? { ...status, message: cls } : { code: status.code }
  } else if (status?.message !== undefined) {
    // The message repeats the error: the protections apply to it as to the attribute.
    status = { ...status, message: cut(redact(status.message).text, gate.limit).text }
  }
  let count = 0
  const events: NonNullable<BuiltSpan['events']> = []
  for (const e of span.events ?? []) {
    const g = gateEvent(gate, e)
    if (g === null) continue
    events.push(g.event)
    count += g.count
  }
  return { ...span, attributes: withCount(attributes, count), ...(span.events ? { events } : {}), ...(status ? { status } : {}) }
}

/** A copied row through the gate again, as it is sent: nothing is added, only what the gate in force now holds back is removed. */
export function gateRow(gate: Gate, row: CopiedRow): CopiedRow {
  return { ...row, attributes: gateAttributes(gate, row.event, row.attributes) }
}

/** A metric point through the gate: null when its metric's data point is off. */
export function gatePoint(gate: Gate, point: MetricPoint): MetricPoint | null {
  return metricAllowed(gate, point.name) ? { ...point, attributes: gateAttributes(gate, point.name, point.attributes) } : null
}
