// The reporting switch's order and its failure rules, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { layerVote, personVote, reportingSwitch, resolveSwitch, type Layer } from '../hooks/settings.ts'

const ORG = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const cfg = (entries: Record<string, unknown>): Layer => ({ pluginConfigs: entries })
const opt = (value: unknown) => ({ options: { reporting: value } })
const set = (on: boolean) => ({ kind: 'set', on }) as const
const absent = { kind: 'absent' } as const
const invalid = { kind: 'invalid' } as const

describe('layerVote', () => {
  const cases: [string, Layer, unknown][] = [
    ['no pluginConfigs', {}, absent],
    ['pluginConfigs not an object', { pluginConfigs: [] }, invalid],
    ['another plugin only', cfg({ other: opt(false) }), absent],
    ['our entry without options', cfg({ mainwave: {} }), absent],
    ['our options without the field', cfg({ mainwave: { options: { x: 1 } } }), absent],
    ['bare id, on', cfg({ mainwave: opt(true) }), set(true)],
    ['@mainwave, off', cfg({ 'mainwave@mainwave': opt(false) }), set(false)],
    ['@synced, off', cfg({ 'mainwave@synced': opt(false) }), set(false)],
    ['@inline, on', cfg({ 'mainwave@inline': opt(true) }), set(true)],
    ['another marketplace with our name', cfg({ 'mainwave@elsewhere': opt(false) }), absent],
    ['a longer name', cfg({ 'mainwave-telemetry': opt(false) }), absent],
    ['an off under one id beats an on under another', cfg({ mainwave: opt(true), 'mainwave@synced': opt(false) }), set(false)],
    ['an off beats a malformed entry', cfg({ mainwave: 'x', 'mainwave@synced': opt(false) }), set(false)],
    ['a malformed entry with an on', cfg({ mainwave: 'x', 'mainwave@synced': opt(true) }), invalid],
    ['options not an object', cfg({ mainwave: { options: 'x' } }), invalid],
    ['a string value', cfg({ mainwave: opt('false') }), invalid],
    ['a null value', cfg({ mainwave: opt(null) }), invalid],
    ['unreadable', 'unreadable', invalid],
  ]
  for (const [name, layer, want] of cases) test(name, () => expect(layerVote(layer)).toEqual(want))
})

describe('personVote', () => {
  test('--settings answers before the user layer', () => {
    expect(personVote({ flag: cfg({ mainwave: opt(true) }), user: cfg({ mainwave: opt(false) }) })).toEqual(set(true))
  })
  test('the user layer answers when --settings says nothing', () => {
    expect(personVote({ flag: {}, user: cfg({ mainwave: opt(false) }) })).toEqual(set(false))
  })
  test('a broken --settings layer is invalid, whatever the user layer says', () => {
    expect(personVote({ flag: 'unreadable', user: cfg({ mainwave: opt(true) }) })).toEqual(invalid)
  })
})

describe('resolveSwitch', () => {
  test('the organization answers first', () => {
    expect(resolveSwitch(set(false), set(true), ORG)).toEqual({ on: false, source: 'policy' })
    expect(resolveSwitch(set(true), set(false), ORG)).toEqual({ on: true, source: 'policy' })
  })
  test('an invalid organization vote is off, without asking the person', () => {
    expect(resolveSwitch(invalid, set(true), ORG)).toEqual({ on: false, source: 'error' })
  })
  test('the person answers when the organization says nothing', () => {
    expect(resolveSwitch(absent, set(false), ORG)).toEqual({ on: false, source: 'user' })
    expect(resolveSwitch(absent, set(true), undefined)).toEqual({ on: true, source: 'user' })
    expect(resolveSwitch(absent, invalid, ORG)).toEqual({ on: false, source: 'error' })
  })
  test('the default is on once the organization is known', () => {
    expect(resolveSwitch(absent, absent, ORG)).toEqual({ on: true, source: 'default' })
    for (const unknown of [undefined, '', 7, null, 'not-a-uuid']) expect(resolveSwitch(absent, absent, unknown)).toEqual({ on: false, source: 'default' })
  })
})

describe('reportingSwitch', () => {
  test('reads the three layers in order', () => {
    const layers = { policy: {}, flag: {}, user: cfg({ 'mainwave@mainwave': opt(false) }) }
    expect(reportingSwitch(layers, ORG)).toEqual({ on: false, source: 'user' })
    expect(reportingSwitch({ ...layers, policy: cfg({ 'mainwave@synced': opt(true) }) }, ORG)).toEqual({ on: true, source: 'policy' })
  })
})
