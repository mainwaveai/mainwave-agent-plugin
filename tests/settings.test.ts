// Where the dev ingest key may come from and the shape it must have, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { ingestKeyOf, namesOption, optionValues, type Layer } from '../hooks/settings.ts'

const cfg = (entries: Record<string, unknown>): Layer => ({ pluginConfigs: entries })
const opt = (value: unknown) => ({ options: { devIngestKey: value } })

describe('namesOption', () => {
  const cases: [string, Layer, boolean][] = [
    ['no pluginConfigs', {}, false],
    ['pluginConfigs not an object', { pluginConfigs: [] }, false],
    ['another plugin only', cfg({ other: opt('x') }), false],
    ['our entry without options', cfg({ mainwave: {} }), false],
    ['our options without the field', cfg({ mainwave: { options: { x: 1 } } }), false],
    ['bare id', cfg({ mainwave: opt('mw_dev_example_key_0001') }), true],
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
  ]
  for (const [name, layer, want] of cases) test(name, () => expect(namesOption(layer)).toBe(want))
})

describe('ingestKeyOf', () => {
  const cases: [string, unknown, string | null][] = [
    ['a plain key', 'mw_dev_example_key_0001', 'mw_dev_example_key_0001'],
    ['spaces around it', '  mw_dev_example_key_0001\n', 'mw_dev_example_key_0001'],
    ['with Bearer in front', 'Bearer mw_dev_example_key_0001', 'mw_dev_example_key_0001'],
    ['with bearer in front, lowercase', 'bearer mw_dev_example_key_0001', 'mw_dev_example_key_0001'],
    ['unset', '', null],
    ['not a string', 42, null],
    ['too short', 'abc', null],
    ['a space inside', 'mw_dev example', null],
    ['a line break inside (no header injection)', 'mw_dev_key\r\nx-evil: 1', null],
    ['too long', 'k'.repeat(513), null],
    ['non-ASCII', 'mw_dev_ключ_0001', null],
  ]
  for (const [name, raw, want] of cases) test(name, () => expect(ingestKeyOf(raw)).toBe(want))
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
