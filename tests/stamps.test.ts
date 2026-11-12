// The stamp rules and the strip of owned keys, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { applyStamps, entrypointOf, filterStamps, stripOwned } from '../hooks/stamps.ts'

describe('stripOwned', () => {
  test('removes every key under an owned prefix and keeps the rest in order', () => {
    const out = stripOwned({ a: 1, 'mainwave.mod.name': 'x', b: 'two', 'mainwave.telemetry.anything': 'y', 'mainwave.attr.k': 'v' })
    expect(Object.keys(out)).toEqual(['a', 'b', 'mainwave.attr.k'])
  })

  test('a key named __proto__ stays a plain key and changes no prototype', () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as Record<string, unknown>
    const out = stripOwned(input)
    expect(Object.keys(out)).toEqual(['__proto__', 'a'])
    expect((out as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })
})

describe('filterStamps', () => {
  test('keeps the stamps that fit their rule', () => {
    const { kept, dropped } = filterStamps({
      'mainwave.mod.name': 'mainwave',
      'mainwave.mod.version': '1.2.3-rc.1+build.5',
      'mainwave.mod.entrypoint': 'remote_cowork',
      'mainwave.telemetry.source': 'policy',
    })
    expect(dropped).toEqual([])
    expect(Object.keys(kept).length).toBe(4)
  })

  const bad: [string, unknown][] = [
    ['mainwave.mod.name', 'mainwave-telemetry'],
    ['mainwave.mod.version', '1.2'],
    ['mainwave.mod.version', `1.2.3-${'a'.repeat(70)}`],
    ['mainwave.mod.entrypoint', 'made-up'],
    ['mainwave.telemetry.source', 'error'],
    ['mainwave.telemetry.source', 'someone'],
    ['mainwave.mod.unknown', 'x'],
    ['user.email', 'dev@example.com'],
    ['mainwave.mod.name', 7],
    ['mainwave.mod.name', 'x'.repeat(300)],
  ]
  for (const [key, value] of bad) {
    test(`drops ${key}=${JSON.stringify(value).slice(0, 30)}`, () => {
      expect(filterStamps({ [key]: value })).toEqual({ kept: {}, dropped: [key] })
    })
  }
})

describe('applyStamps', () => {
  test('strips first, then adds only what passes', () => {
    const out = applyStamps({ 'mainwave.mod.name': 'forged', keep: 'me' }, { 'mainwave.mod.name': 'mainwave', 'mainwave.mod.bogus': 'no' })
    expect(out).toEqual({ keep: 'me', 'mainwave.mod.name': 'mainwave' })
  })
})

describe('entrypointOf', () => {
  test('known values pass, anything else is other', () => {
    expect(entrypointOf('cli')).toBe('cli')
    expect(entrypointOf('remote_cowork')).toBe('remote_cowork')
    expect(entrypointOf('CLI')).toBe('other')
    expect(entrypointOf(undefined)).toBe('other')
    expect(entrypointOf(3)).toBe('other')
  })
})
