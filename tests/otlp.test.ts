// The copy's OTLP/JSON shape, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { anyValue, logRecord, logsBody, parseResourceAttributes, resourceOf, unixNanos } from '../hooks/otlp.ts'

describe('parseResourceAttributes', () => {
  test('pairs split by commas, trimmed, values percent-decoded', () => {
    expect(parseResourceAttributes(' a=1 , b = two,c=x%2Cy ')).toEqual({ a: '1', b: 'two', c: 'x,y' })
  })
  test('a pair without a key, without =, or with a bad escape is skipped', () => {
    expect(parseResourceAttributes('=v,novalue,bad=%E0%A4%A,ok=1')).toEqual({ ok: '1' })
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
  test('typed as the OpenTelemetry SDK types a JavaScript value', () => {
    expect(anyValue('x')).toEqual({ stringValue: 'x' })
    expect(anyValue(false)).toEqual({ boolValue: false })
    expect(anyValue(124)).toEqual({ intValue: '124' })
    expect(anyValue(0)).toEqual({ intValue: '0' })
    expect(anyValue(0.0001241)).toEqual({ doubleValue: 0.0001241 })
    expect(anyValue(['a', 'b'])).toEqual({ arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } })
    expect(anyValue(Number.NaN)).toEqual({ stringValue: 'NaN' })
    expect(anyValue(2 ** 60)).toEqual({ doubleValue: 2 ** 60 })
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
