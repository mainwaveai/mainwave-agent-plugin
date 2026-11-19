// Where the person's collector override may come from and the shape it must have, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { collectorIn, collectorUrlOf, namesOption, optionValues, PROD_COLLECTOR, type Layer } from '../hooks/settings.ts'

const cfg = (entries: Record<string, unknown>): Layer => ({ pluginConfigs: entries })
const opt = (value: unknown) => ({ options: { collectorUrl: value } })

describe('namesOption', () => {
  const cases: [string, Layer, boolean][] = [
    ['no pluginConfigs', {}, false],
    ['pluginConfigs not an object', { pluginConfigs: [] }, false],
    ['another plugin only', cfg({ other: opt('x') }), false],
    ['our entry without options', cfg({ mainwave: {} }), false],
    ['our options without the field', cfg({ mainwave: { options: { x: 1 } } }), false],
    ['bare id', cfg({ mainwave: opt('https://collector.example.com') }), true],
    ['@mainwave', cfg({ 'mainwave@mainwave': opt('x') }), true],
    ['@synced', cfg({ 'mainwave@synced': opt('x') }), true],
    ['@inline', cfg({ 'mainwave@inline': opt('x') }), true],
    ['an empty value still names it', cfg({ mainwave: opt('') }), true],
    ['a value of any type names it', cfg({ mainwave: opt(null) }), true],
    ['our name from any marketplace, one that does not exist yet included', cfg({ 'mainwave@elsewhere': opt('x') }), true],
    ['a longer name', cfg({ 'mainwave-telemetry': opt('x') }), false],
    ['two marketplaces', cfg({ 'mainwave@a@b': opt('x') }), false],
    ['unreadable', 'unreadable', true],
    ['an option the plugin no longer has (keyless is the default now)', cfg({ 'mainwave@synced': { options: { devKeyless: true } } }), false],
    ['the dev ingest key the plugin no longer has', cfg({ 'mainwave@synced': { options: { devIngestKey: 'mw_dev_example_key_0001' } } }), false],
  ]
  for (const [name, layer, want] of cases) test(name, () => expect(namesOption(layer)).toBe(want))
})

describe('collectorUrlOf', () => {
  const cases: [string, unknown, string | null][] = [
    ['an https origin', 'https://collector.example.com', 'https://collector.example.com'],
    ['a trailing slash', 'https://collector.example.com/', 'https://collector.example.com'],
    ['spaces around it', '  https://collector.example.com\n', 'https://collector.example.com'],
    ['a port', 'https://collector.example.com:4318', 'https://collector.example.com:4318'],
    ['a path, kept before the signal path', 'https://example.com/otlp/', 'https://example.com/otlp'],
    ['the host lowercased', 'https://Collector.Example.COM', 'https://collector.example.com'],
    ['http on 127.0.0.1', 'http://127.0.0.1:4318', 'http://127.0.0.1:4318'],
    ['http on localhost', 'http://localhost:4318/', 'http://localhost:4318'],
    ['http on ::1', 'http://[::1]:4318', 'http://[::1]:4318'],
    ['http elsewhere', 'http://collector.example.com', null],
    ['another scheme', 'ftp://collector.example.com', null],
    ['a user and password', 'https://u:p@collector.example.com', null],
    ['a query', 'https://collector.example.com/?x=1', null],
    ['a fragment', 'https://collector.example.com/#x', null],
    ['a bare host', 'collector.example.com', null],
    ['empty', '', null],
    ['not a string', 42, null],
    ['too long', `https://example.com/${'p'.repeat(2100)}`, null],
  ]
  for (const [name, raw, want] of cases) test(name, () => expect(collectorUrlOf(raw)).toBe(want))
})

describe('optionValues', () => {
  const ids = (value: unknown) => ({ options: { extraDataPoints: value } })
  const cases: [string, Layer, unknown[]][] = [
    ['no pluginConfigs', {}, []],
    ['pluginConfigs not an object', { pluginConfigs: 'x' }, []],
    ['unreadable', 'unreadable', []],
    ['another plugin only', cfg({ other: ids(['mcp.url']) }), []],
    ['our entry without the field', cfg({ 'mainwave@synced': opt('x') }), []],
    ['one entry', cfg({ 'mainwave@synced': ids(['mcp.url']) }), [['mcp.url']]],
    ['each of our ids, in order', cfg({ mainwave: ids('skill.text'), 'mainwave@mainwave': ids(['mcp.url']), 'mainwave-telemetry': ids(['x']) }), ['skill.text', ['mcp.url']]],
    ['a value of any type, as it is', cfg({ 'mainwave@synced': ids(42) }), [42]],
  ]
  for (const [name, layer, want] of cases) test(name, () => expect(optionValues(layer, 'extraDataPoints')).toEqual(want))
})

describe('collectorIn', () => {
  const url = (v: unknown, id = 'mainwave@synced') => ({ [id]: { options: { collectorUrl: v } } })
  const cases: [string, Layer, string][] = [
    ['nothing set: production', {}, PROD_COLLECTOR],
    ['an empty value: production', cfg(url('  ')), PROD_COLLECTOR],
    ['a null value: production', cfg(url(null)), PROD_COLLECTOR],
    ['a collector of the right shape', cfg(url('https://collector.example.com/')), 'https://collector.example.com'],
    ['the same collector under two ids, written two ways', cfg({ ...url('https://collector.example.com'), ...url('https://COLLECTOR.example.com/', 'mainwave') }), 'https://collector.example.com'],
    ['two ids naming different collectors', cfg({ ...url('https://a.example.com'), ...url('https://b.example.com', 'mainwave') }), 'malformed'],
    ['a value of the wrong shape', cfg(url('http://collector.example.com')), 'malformed'],
    ['a value of the wrong type', cfg(url(42)), 'malformed'],
    ['a layer that cannot be read', 'unreadable', 'unreadable'],
  ]
  for (const [name, layer, want] of cases) test(name, () => expect(collectorIn(layer)).toBe(want))
})
