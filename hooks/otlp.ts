// The plugin's copy of Claude Code's log rows as OTLP/JSON, shaped as Claude Code's own exporter sends them. Pure: tests call it.
//
// A row reaches the plugin's hook with every attribute the exporter sends (the session's identity, `event.name`, `event.sequence`
// and `event.timestamp` among them), the time it was logged and the span it belongs to. What the hook does not see is the
// exporter's resource, so it is rebuilt here the way the OpenTelemetry SDK builds it: `service.name` and `service.version` by
// default, then `OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME`. The SDK's host detectors (`os.type`, `os.version`,
// `host.arch`) have no counterpart a plugin can read, so the copy's resource goes without them.

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

/** The resource the exporter would send: defaults, then `OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME`. */
export function resourceOf(input: { resourceAttributes?: string; serviceName?: string; version?: string }): Record<string, string> {
  const out: Record<string, string> = { 'service.name': DEFAULT_SERVICE_NAME }
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
