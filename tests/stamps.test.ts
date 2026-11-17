// The stamp rules and the strip of owned keys, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { applyStamps, commandStamps, entrypointOf, filterStamps, stripOwned } from '../hooks/stamps.ts'

describe('stripOwned', () => {
  test('removes every key under an owned prefix and keeps the rest in order', () => {
    const out = stripOwned({
      a: 1, 'mainwave.plugin.name': 'x', b: 'two', 'mainwave.telemetry.anything': 'y', 'mainwave.redaction.count': 3, 'mainwave.attr.k': 'v',
      'mainwave.mod.name': 'old', 'mainwave.pluginx': 'kept', 'mainwave.command.commits': 9, 'mainwave.command.push_ref': 'forged', 'mainwave.commandx': 'kept',
    })
    expect(Object.keys(out)).toEqual(['a', 'b', 'mainwave.attr.k', 'mainwave.pluginx', 'mainwave.commandx'])
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
      'mainwave.plugin.name': 'mainwave',
      'mainwave.plugin.version': '1.2.3-rc.1+build.5',
      'mainwave.plugin.entrypoint': 'remote_cowork',
      'mainwave.telemetry.route': 'plugin',
    })
    expect(dropped).toEqual([])
    expect(Object.keys(kept).length).toBe(4)
  })

  const bad: [string, unknown][] = [
    ['mainwave.plugin.name', 'mainwave-other'],
    ['mainwave.plugin.version', '1.2'],
    ['mainwave.plugin.version', `1.2.3-${'a'.repeat(70)}`],
    ['mainwave.plugin.entrypoint', 'made-up'],
    ['mainwave.telemetry.route', 'collector'],
    ['mainwave.telemetry.route', ''],
    ['mainwave.telemetry.source', 'policy'],
    ['mainwave.plugin.unknown', 'x'],
    ['mainwave.mod.name', 'mainwave'],
    ['mainwave.mod.version', '0.1.0'],
    ['mainwave.mod.entrypoint', 'cli'],
    ['user.email', 'dev@example.com'],
    ['mainwave.plugin.name', 7],
    ['mainwave.plugin.name', 'x'.repeat(300)],
    ['mainwave.telemetry.opt_in', ''],
    ['mainwave.telemetry.opt_in', 'tool.call'],
    ['mainwave.telemetry.opt_in', 'mcp.url,mcp.url'],
    ['mainwave.telemetry.opt_in', 'mcp.url, skill.text'],
    ['mainwave.telemetry.opt_in', 'usage'],
  ]
  for (const [key, value] of bad) {
    test(`drops ${key}=${JSON.stringify(value).slice(0, 30)}`, () => {
      expect(filterStamps({ [key]: value })).toEqual({ kept: {}, dropped: [key] })
    })
  }
})

describe('the opt-in stamp', () => {
  test('lists data points off by default, each once', () => {
    const value = 'mcp.url,skill.text,response.thinking'
    expect(filterStamps({ 'mainwave.telemetry.opt_in': value })).toEqual({ kept: { 'mainwave.telemetry.opt_in': value }, dropped: [] })
    expect(filterStamps({ 'mainwave.telemetry.opt_in': 'response.thinking' }).dropped).toEqual([])
  })
})

describe('applyStamps', () => {
  test('strips first, then adds only what passes', () => {
    const out = applyStamps({ 'mainwave.plugin.name': 'forged', 'mainwave.mod.name': 'old', keep: 'me' }, { 'mainwave.plugin.name': 'mainwave', 'mainwave.plugin.bogus': 'no' })
    expect(out).toEqual({ keep: 'me', 'mainwave.plugin.name': 'mainwave' })
  })
})

describe('commandStamps', () => {
  test('counted on every command; on one that succeeded each count above 0, and each ref beside its count where refs go', () => {
    const found = { counts: { commits: 2, pushes: 1, branches_opened: 1 }, refs: { push_ref: 'feat/x', branch_opened: 'feat/x', merge_ref: 'feat/y' } }
    expect(commandStamps(undefined, true)).toEqual({ 'mainwave.command.counted': 1 })
    expect(commandStamps(found, false)).toEqual({ 'mainwave.command.counted': 1, 'mainwave.command.commits': 2, 'mainwave.command.pushes': 1, 'mainwave.command.branches_opened': 1 })
    // `merge_ref` has no merge count beside it: left off.
    expect(commandStamps(found, true)).toEqual({
      'mainwave.command.counted': 1, 'mainwave.command.commits': 2, 'mainwave.command.pushes': 1, 'mainwave.command.branches_opened': 1,
      'mainwave.command.branch_opened': 'feat/x', 'mainwave.command.push_ref': 'feat/x',
    })
  })

  test('a value that fails its shape is dropped, and its ref with it', () => {
    const counts = { commits: 0, reverts: 1.5, pushes: 70_000, tags: 1, branches_opened: 2 }
    const refs = { tag_name: 'v 1', push_ref: 'x' }
    expect(commandStamps({ counts, refs }, true)).toEqual({ 'mainwave.command.counted': 1, 'mainwave.command.tags': 1 })
    expect(commandStamps({ counts: { tags: 1 }, refs: { tag_name: 'v'.repeat(257) } }, true)).toEqual({ 'mainwave.command.counted': 1, 'mainwave.command.tags': 1 })
    expect(commandStamps({ counts: { tags: 1 }, refs: { tag_name: 'v1\u0007' } }, true)).toEqual({ 'mainwave.command.counted': 1, 'mainwave.command.tags': 1 })
  })
})

describe('entrypointOf', () => {
  test('known values pass, anything else is other', () => {
    expect(entrypointOf('cli')).toBe('cli')
    expect(entrypointOf('remote_cowork')).toBe('remote_cowork')
    expect(entrypointOf('t3-code')).toBe('t3-code')
    expect(entrypointOf('CLI')).toBe('other')
    expect(entrypointOf(undefined)).toBe('other')
    expect(entrypointOf(3)).toBe('other')
  })
})
