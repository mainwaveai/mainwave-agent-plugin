// The plugin's copy of Claude Code's log rows as OTLP/JSON, shaped as Claude Code's own exporter sends them. Pure: tests call it.
//
// A row reaches the plugin's hook with every attribute the exporter sends (the session's identity, `event.name`, `event.sequence`
// and `event.timestamp` among them), the time it was logged and the span it belongs to. What the hook does not see is the
// exporter's resource, so it is rebuilt here the way the OpenTelemetry SDK builds it: `service.name` and `service.version` by
// default, then `OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME`. Of the SDK's host detectors, `host.arch` is read from the
// machine where Claude Code says what it is (`$.session.machine()`, 2.1.328 on); `os.type` and `os.version` the copy goes without.
//
// In Cowork, its host names the service through those variables (`service.name` `cowork`, `cowork.surface`), and its export is filed
// under Cowork by them. Where they name none (no Cowork export configured), the resource takes Cowork's names, so the copy is filed
// there all the same.

import type { TelemetryAttribute, TelemetrySpan } from 'claude-code'

/** One copied row: the collector record as the hook read it, its attributes already stamped. */
export type CopiedRow = {
  event: string
  loggedAt: string
  span?: TelemetrySpan
  attributes: Record<string, TelemetryAttribute>
}

/** The scope Claude Code's exporter names its log records under. */
export const SCOPE_NAME = 'com.anthropic.claude_code.events'

/** `service.name` when nothing names one. */
export const DEFAULT_SERVICE_NAME = 'claude-code'

/** `service.name` and `cowork.surface` as Cowork's host sets them, where no variable names them. Every Cowork session runs in the cloud. */
export const COWORK_SERVICE_NAME = 'cowork'
export const COWORK_SURFACE = 'remote'

/** Whether a variable is set to on, as Claude Code reads one (`1`, `true`, `yes`, `on`, any case). */
export const isTruthy = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase())

/** Whether the session is Cowork's, as Claude Code decides it: `CLAUDE_CODE_IS_COWORK` on, or the entry point `remote_cowork`. */
export function isCowork(env: { CLAUDE_CODE_IS_COWORK?: string | undefined; CLAUDE_CODE_ENTRYPOINT?: string | undefined }): boolean {
  return isTruthy(env.CLAUDE_CODE_IS_COWORK) || env.CLAUDE_CODE_ENTRYPOINT?.trim() === 'remote_cowork'
}

/**
 * `host.arch` as the OpenTelemetry SDK's host detector names it (`amd64`, `arm64`), from the hardware's name in `uname -m`'s words;
 * undefined for any other, which the plugin does not guess at.
 */
export function hostArchOf(machine: unknown): string | undefined {
  if (typeof machine !== 'string') return undefined
  const m = machine.trim().toLowerCase()
  return m === 'x86_64' || m === 'amd64' ? 'amd64' : m === 'arm64' || m === 'aarch64' ? 'arm64' : undefined
}

/**
 * `OTEL_RESOURCE_ATTRIBUTES` as the OpenTelemetry JS SDK reads it: `key=value` pairs split by commas, a pair with no `=` or more than
 * one skipped, the value trimmed, stripped of surrounding quotes and percent-decoded. A pair that does not decode is skipped.
 */
export function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (raw ?? '').split(',')) {
    const parts = pair.split('=')
    if (parts.length !== 2) continue
    const key = parts[0]!.trim()
    let value = parts[1]!.trim().replace(/^"|"$/g, '')
    try {
      value = decodeURIComponent(value)
    } catch {
      continue
    }
    if (key !== '') Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return out
}

/**
 * The resource the exporter would send: defaults, then `OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME`. In Cowork the defaults
 * are Cowork's (`cowork`, `cowork.surface` `remote`); the variables still win.
 */
export function resourceOf(input: { resourceAttributes?: string; serviceName?: string; version?: string; cowork?: boolean; hostArch?: string }): Record<string, string> {
  const out: Record<string, string> = { 'service.name': input.cowork ? COWORK_SERVICE_NAME : DEFAULT_SERVICE_NAME }
  if (input.cowork) out['cowork.surface'] = COWORK_SURFACE
  if (input.hostArch) out['host.arch'] = input.hostArch
  if (input.version) out['service.version'] = input.version
  Object.assign(out, parseResourceAttributes(input.resourceAttributes))
  if (input.serviceName) out['service.name'] = input.serviceName
  return out
}

type AnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: number }
  | { doubleValue: number }
  | { arrayValue: { values: AnyValue[] } }

/**
 * One attribute value, as the OpenTelemetry JS SDK's JSON exporter writes a JavaScript value: a whole number an int, any other number
 * a double, each as a JSON number. (A double that is not finite comes out as `null`, as it does from the SDK.)
 */
export function anyValue(v: unknown): AnyValue {
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { boolValue: v }
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: v } : { doubleValue: v }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } }
  return { stringValue: String(v) }
}

const keyValues = (attributes: Readonly<Record<string, unknown>>) => Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(value) }))

/** Milliseconds since the epoch as OTLP's nanosecond string; `fallbackMs` when `loggedAt` does not parse. */
export function unixNanos(loggedAt: string, fallbackMs: number): string {
  const ms = Date.parse(loggedAt)
  const at = Number.isFinite(ms) && ms > 0 ? ms : fallbackMs
  return `${Math.trunc(at)}000000`
}

const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/

/** One log record. The span's ids go as OTLP/JSON spells them, lowercase hex, and only when both have their shape. */
export function logRecord(row: CopiedRow, nowMs: number) {
  const time = unixNanos(row.loggedAt, nowMs)
  const span = row.span
  const ids = span !== undefined && HEX32.test(span.traceId) && HEX16.test(span.spanId)
    ? { traceId: span.traceId, spanId: span.spanId, flags: span.traceFlags & 0xff }
    : {}
  return {
    timeUnixNano: time,
    observedTimeUnixNano: time,
    body: { stringValue: `claude_code.${row.event}` },
    attributes: keyValues(row.attributes),
    ...ids,
  }
}

/** The request body for rows grouped by resource (each group's resource as its JSON text), in the order given. */
export function logsBody(groups: readonly { resource: string; rows: readonly CopiedRow[] }[], scopeVersion: string | undefined, nowMs: number): string {
  return JSON.stringify({
    resourceLogs: groups.map(g => ({
      resource: { attributes: keyValues(JSON.parse(g.resource) as Record<string, string>) },
      scopeLogs: [{ scope: { name: SCOPE_NAME, ...(scopeVersion ? { version: scopeVersion } : {}) }, logRecords: g.rows.map(r => logRecord(r, nowMs)) }],
    })),
  })
}

// ── Spans ─────────────────────────────────────────────────────────────────────

/** The tracer Claude Code's spans are named under: a fixed name and version, not the CLI's. */
export const TRACE_SCOPE = { name: 'com.anthropic.claude_code.tracing', version: '1.0.0' } as const

/** One span the plugin rebuilt (spans.ts): plain data, times in epoch milliseconds. */
export type BuiltSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startMs: number
  endMs: number
  attributes: Record<string, TelemetryAttribute>
  events?: { name: string; timeMs: number; attributes: Record<string, TelemetryAttribute> }[]
  /** 0 unset, 2 error, as OTLP numbers them. */
  status?: { code: 0 | 2; message?: string }
}

/** Epoch milliseconds, fractions kept to the nanosecond, as OTLP's nanosecond string. */
export function msToNanos(ms: number): string {
  const whole = Math.floor(ms)
  const frac = Math.round((ms - whole) * 1e6)
  return frac >= 1e6 ? `${whole + 1}000000` : `${whole}${String(frac).padStart(6, '0')}`
}

/**
 * One span as the OpenTelemetry JS SDK's JSON exporter writes it: kind INTERNAL, flags 257 (sampled, parent not remote), the dropped
 * counts at 0, no links. `parentSpanId` only on a span that has one.
 */
export function spanJson(span: BuiltSpan) {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    kind: 1,
    startTimeUnixNano: msToNanos(span.startMs),
    endTimeUnixNano: msToNanos(span.endMs),
    attributes: keyValues(span.attributes),
    droppedAttributesCount: 0,
    events: (span.events ?? []).map(e => ({ attributes: keyValues(e.attributes), name: e.name, timeUnixNano: msToNanos(e.timeMs), droppedAttributesCount: 0 })),
    droppedEventsCount: 0,
    status: span.status?.message ? { code: span.status.code, message: span.status.message } : { code: span.status?.code ?? 0 },
    links: [],
    droppedLinksCount: 0,
    flags: 257,
  }
}

/** The request body for spans grouped by resource, under the tracer's scope. */
export function tracesBody(groups: readonly { resource: string; items: readonly BuiltSpan[] }[]): string {
  return JSON.stringify({
    resourceSpans: groups.map(g => ({
      resource: { attributes: keyValues(JSON.parse(g.resource) as Record<string, string>) },
      scopeSpans: [{ scope: { ...TRACE_SCOPE }, spans: g.items.map(spanJson) }],
    })),
  })
}

// ── Metrics ───────────────────────────────────────────────────────────────────

/** The meter Claude Code's metrics are named under; its version is the CLI's. */
export const METRIC_SCOPE_NAME = 'com.anthropic.claude_code'

/** One data point of a delta sum the plugin collected (metrics.ts): times in epoch milliseconds. */
export type MetricPoint = {
  name: string
  startMs: number
  timeMs: number
  value: number
  attributes: Record<string, TelemetryAttribute>
}

/** Each counter Claude Code defines: its description and unit, as the exporter sends them. */
export const METRICS: Readonly<Record<string, { description: string; unit: string }>> = {
  'claude_code.session.count': { description: 'Count of CLI sessions started', unit: '' },
  'claude_code.lines_of_code.count': {
    description: "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed and the 'model' attribute indicating which model made the change",
    unit: '',
  },
  'claude_code.pull_request.count': { description: 'Number of pull requests created', unit: '' },
  'claude_code.commit.count': { description: 'Number of git commits created', unit: '' },
  'claude_code.cost.usage': { description: 'Cost of the Claude Code session', unit: 'USD' },
  'claude_code.token.usage': { description: 'Number of tokens used', unit: 'tokens' },
  'claude_code.code_edit_tool.decision': { description: 'Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools', unit: '' },
  'claude_code.active_time.total': { description: 'Total active time in seconds', unit: 's' },
}

/**
 * The request body for data points grouped by resource: one metric per name, in the order Claude Code defines them, each a monotonic
 * delta sum of doubles, as the exporter sends them.
 */
export function metricsBody(groups: readonly { resource: string; items: readonly MetricPoint[] }[], scopeVersion: string | undefined): string {
  const order = Object.keys(METRICS)
  return JSON.stringify({
    resourceMetrics: groups.map(g => {
      const byName = new Map<string, MetricPoint[]>()
      for (const p of g.items) byName.set(p.name, [...(byName.get(p.name) ?? []), p])
      const names = [...byName.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))
      return {
        resource: { attributes: keyValues(JSON.parse(g.resource) as Record<string, string>) },
        scopeMetrics: [{
          scope: { name: METRIC_SCOPE_NAME, ...(scopeVersion ? { version: scopeVersion } : {}) },
          metrics: names.map(name => ({
            name,
            description: METRICS[name]?.description ?? '',
            unit: METRICS[name]?.unit ?? '',
            sum: {
              aggregationTemporality: 1,
              isMonotonic: true,
              dataPoints: byName.get(name)!.map(p => ({
                attributes: keyValues(p.attributes),
                startTimeUnixNano: msToNanos(p.startMs),
                timeUnixNano: msToNanos(p.timeMs),
                asDouble: p.value,
              })),
            },
          })),
        }],
      }
    }),
  })
}
