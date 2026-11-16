// The plugin's copy of Claude Code's metrics: monotonic counters summed between collections and sent as delta data points, the way
// Claude Code's own meter does by default. Pure: tests call it directly.
//
// Claude Code's exporter (the OpenTelemetry JS SDK with delta temporality) collects on a fixed interval and once more at shutdown.
// Each collection sends one point per series (a metric name and its exact attributes) measured since the last one; a series with no
// measurement since is not sent. A point starts where the previous collection ended when its series was in that collection, else at
// the series' first measurement.

import type { TelemetryAttribute } from 'claude-code'

import type { MetricPoint } from './otlp.ts'

/** One addition to a counter. */
export type Measure = { name: string; value: number; attributes: Record<string, TelemetryAttribute>; atMs: number }

type Series = { name: string; attributes: Record<string, TelemetryAttribute>; value: number; firstMs: number }

export type Meter = {
  /** The series measured since the last collection, by key. */
  open: Map<string, Series>
  /** The keys the last collection sent. */
  lastSent: Set<string>
  lastCollectedMs: number | undefined
}

export const newMeter = (): Meter => ({ open: new Map(), lastSent: new Set(), lastCollectedMs: undefined })

/** A series' identity: its name and its attributes in any order. */
export function seriesKey(name: string, attributes: Readonly<Record<string, TelemetryAttribute>>): string {
  return JSON.stringify([name, Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))])
}

/** Adds to a counter. A value that is not a finite number of zero or more is ignored, as the SDK ignores a negative add. */
export function add(meter: Meter, m: Measure): void {
  if (typeof m.value !== 'number' || !Number.isFinite(m.value) || m.value < 0) return
  const key = seriesKey(m.name, m.attributes)
  const s = meter.open.get(key)
  if (s) s.value += m.value
  else meter.open.set(key, { name: m.name, attributes: m.attributes, value: m.value, firstMs: m.atMs })
}

/** One collection: a point for each series measured since the last, which then starts over. */
export function collect(meter: Meter, nowMs: number): MetricPoint[] {
  const points: MetricPoint[] = []
  const sent = new Set<string>()
  for (const [key, s] of meter.open) {
    const startMs = meter.lastCollectedMs !== undefined && meter.lastSent.has(key) ? meter.lastCollectedMs : s.firstMs
    points.push({ name: s.name, startMs, timeMs: nowMs, value: s.value, attributes: s.attributes })
    sent.add(key)
  }
  meter.open = new Map()
  meter.lastSent = sent
  meter.lastCollectedMs = nowMs
  return points
}
