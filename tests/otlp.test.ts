// The copy's OTLP/JSON shape, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { anyValue, logRecord, logsBody, metricsBody, msToNanos, parseResourceAttributes, resourceOf, spanJson, tracesBody, unixNanos } from '../hooks/otlp.ts'

describe('parseResourceAttributes', () => {
  test('pairs split by commas, trimmed, values percent-decoded', () => {
    expect(parseResourceAttributes(' a=1 , b = two,c=x%2Cy ')).toEqual({ a: '1', b: 'two', c: 'x,y' })
  })
  test('a pair without a key, without =, with two =, or with a bad escape is skipped', () => {
    expect(parseResourceAttributes('=v,novalue,bad=%E0%A4%A,two=a=b,ok=1')).toEqual({ ok: '1' })
  })
  test('quotes around a value are taken off', () => {
    expect(parseResourceAttributes('a="quoted",b= "spaced" ')).toEqual({ a: 'quoted', b: 'spaced' })
  })
  test('unset is empty', () => expect(parseResourceAttributes(undefined)).toEqual({}))
  test('a key named __proto__ stays a plain key', () => {
    const out = parseResourceAttributes('__proto__=x')
    expect(Object.keys(out)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })
})

describe('resourceOf', () => {
  test('defaults, then OTEL_RESOURCE_ATTRIBUTES, then OTEL_SERVICE_NAME', () => {
    expect(resourceOf({ version: '2.1.322' })).toEqual({ 'service.name': 'claude-code', 'service.version': '2.1.322' })
    expect(resourceOf({ version: '2.1.322', resourceAttributes: 'service.name=claude-code-desktop,service.version=5.1.0,deployment.environment=production' }))
      .toEqual({ 'service.name': 'claude-code-desktop', 'service.version': '5.1.0', 'deployment.environment': 'production' })
    expect(resourceOf({ resourceAttributes: 'service.name=a', serviceName: 'b' })).toEqual({ 'service.name': 'b' })
  })
})

describe('anyValue', () => {
  test('typed as the OpenTelemetry JS SDK types a JavaScript value, numbers as JSON numbers', () => {
    expect(anyValue('x')).toEqual({ stringValue: 'x' })
    expect(anyValue(false)).toEqual({ boolValue: false })
    expect(anyValue(124)).toEqual({ intValue: 124 })
    expect(anyValue(0)).toEqual({ intValue: 0 })
    expect(anyValue(2 ** 60)).toEqual({ intValue: 2 ** 60 })
    expect(anyValue(0.0001241)).toEqual({ doubleValue: 0.0001241 })
    expect(anyValue(['a', 'b'])).toEqual({ arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } })
    expect(JSON.stringify(anyValue(Number.NaN))).toBe('{"doubleValue":null}')
  })
})

describe('unixNanos', () => {
  test('milliseconds to a nanosecond string; a bad instant falls back', () => {
    expect(unixNanos('2026-11-13T03:28:30.664Z', 1)).toBe('1794540510664000000')
    expect(unixNanos('not a time', 1_700_000_000_123)).toBe('1700000000123000000')
  })
})

describe('logRecord', () => {
  const row = { event: 'api_request', loggedAt: '2026-11-13T03:28:30.664Z', attributes: { 'event.name': 'api_request', 'event.sequence': 39 } }
  test('the body is the event named as the exporter names it; the span ids ride when both fit', () => {
    const r = logRecord({ ...row, span: { traceId: '7d2fa3029813d71c9ad4ef05815fa7d5', spanId: 'e4a76fb0fca33a96', traceFlags: 1 } }, 0)
    expect(r.body).toEqual({ stringValue: 'claude_code.api_request' })
    expect(r.timeUnixNano).toBe('1794540510664000000')
    expect(r).toEqual(expect.objectContaining({ traceId: '7d2fa3029813d71c9ad4ef05815fa7d5', spanId: 'e4a76fb0fca33a96', flags: 1 }))
  })
  test('ids of the wrong shape are left off', () => {
    const r = logRecord({ ...row, span: { traceId: 'XYZ', spanId: 'e4a76fb0fca33a96', traceFlags: 1 } }, 0) as Record<string, unknown>
    expect('traceId' in r).toBe(false)
    expect('spanId' in r).toBe(false)
  })
})

describe('logsBody', () => {
  test('one resourceLogs per group, under the exporter scope', () => {
    const body = JSON.parse(logsBody([
      { resource: JSON.stringify({ 'service.name': 'claude-code' }), rows: [{ event: 'a', loggedAt: '2026-11-13T00:00:00.000Z', attributes: {} }] },
      { resource: JSON.stringify({ 'service.name': 'other' }), rows: [] },
    ], '2.1.322', 0))
    expect(body.resourceLogs.length).toBe(2)
    expect(body.resourceLogs[0].scopeLogs[0].scope).toEqual({ name: 'com.anthropic.claude_code.events', version: '2.1.322' })
    expect(body.resourceLogs[0].resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'claude-code' } }])
  })
})

describe('msToNanos', () => {
  test('whole and fractional milliseconds, to the nanosecond', () => {
    expect(msToNanos(1_794_606_872_847)).toBe('1794606872847000000')
    expect(msToNanos(1_794_606_872_847.5)).toBe('1794606872847500000')
    expect(msToNanos(1.9999999)).toBe('2000000')
  })
})

describe('spans', () => {
  const span = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'claude_code.tool', startMs: 1, endMs: 2, attributes: { tool_name: 'Bash', duration_ms: 1 } }
  test('as the exporter writes one: kind INTERNAL, flags 257, every count and list present, no parent key on a root', () => {
    expect(spanJson(span)).toEqual({
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'claude_code.tool', kind: 1, startTimeUnixNano: '1000000', endTimeUnixNano: '2000000',
      attributes: [{ key: 'tool_name', value: { stringValue: 'Bash' } }, { key: 'duration_ms', value: { intValue: 1 } }],
      droppedAttributesCount: 0, events: [], droppedEventsCount: 0, status: { code: 0 }, links: [], droppedLinksCount: 0, flags: 257,
    })
    expect(Object.keys(spanJson({ ...span, parentSpanId: 'c'.repeat(16) })).slice(0, 4)).toEqual(['traceId', 'spanId', 'parentSpanId', 'name'])
  })
  test('an error carries its message; events carry their attributes and time', () => {
    const j = spanJson({ ...span, status: { code: 2, message: 'boom' }, events: [{ name: 'gen_ai.request.attempt', timeMs: 1, attributes: { attempt: 1 } }] })
    expect(j.status).toEqual({ code: 2, message: 'boom' })
    expect(j.events).toEqual([{ attributes: [{ key: 'attempt', value: { intValue: 1 } }], name: 'gen_ai.request.attempt', timeUnixNano: '1000000', droppedAttributesCount: 0 }])
  })
  test('grouped by resource under the tracer\'s scope', () => {
    const body = JSON.parse(tracesBody([{ resource: JSON.stringify({ 'service.name': 'claude-code' }), items: [span] }]))
    expect(body.resourceSpans[0].scopeSpans[0].scope).toEqual({ name: 'com.anthropic.claude_code.tracing', version: '1.0.0' })
    expect(body.resourceSpans[0].scopeSpans[0].spans.length).toBe(1)
  })
})

describe('metricsBody', () => {
  test('one metric per name in the order Claude Code defines them, each a monotonic delta sum of doubles', () => {
    const point = (name: string, value: number) => ({ name, startMs: 1, timeMs: 2, value, attributes: { model: 'm' } })
    const body = JSON.parse(metricsBody([{ resource: JSON.stringify({ 'service.name': 'claude-code' }), items: [point('claude_code.token.usage', 5), point('claude_code.cost.usage', 0.5), point('claude_code.token.usage', 7)] }], '2.1.322'))
    const scope = body.resourceMetrics[0].scopeMetrics[0]
    expect(scope.scope).toEqual({ name: 'com.anthropic.claude_code', version: '2.1.322' })
    expect(scope.metrics.map((m: { name: string }) => m.name)).toEqual(['claude_code.cost.usage', 'claude_code.token.usage'])
    expect(scope.metrics[0]).toEqual({
      name: 'claude_code.cost.usage', description: 'Cost of the Claude Code session', unit: 'USD',
      sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ attributes: [{ key: 'model', value: { stringValue: 'm' } }], startTimeUnixNano: '1000000', timeUnixNano: '2000000', asDouble: 0.5 }] },
    })
    expect(scope.metrics[1].sum.dataPoints.map((p: { asDouble: number }) => p.asDouble)).toEqual([5, 7])
    // A whole number goes as a double all the same, as Claude Code's counters send it.
    expect(JSON.stringify(scope.metrics[1].sum.dataPoints[0])).toContain('"asDouble":5')
  })
})
