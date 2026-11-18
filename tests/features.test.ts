// The extension point (hooks/features.ts): a feature rides the plugin's own hooks, stamps only under its own prefix and only where the
// plugin stamps, and a feature that throws is skipped while the plugin goes on as without it.

import { describe, expect, test } from 'claude-code/testing'

import { configureFeatures, FEATURES, featureOn, featureStamps, runSteps, validFeatures, type Feature } from '../hooks/features.ts'
import { commandHook, promptHook, sessionEnd, spawnHook, stampRow, toolCallHook, turnCompleteHook, turnStartHook } from '../hooks/register.ts'
import { stripOwned } from '../hooks/stamps.ts'
import { boot, LOGGED_AT, ORG, ownedKeys, STAMPED } from './rig.ts'

// The engine loads the plugin's hooks module in an environment of its own: a feature list a test configures reaches the handlers this file
// imports and calls, never the copy the engine registered. So rows go through `stampRow` called directly, as the engine would call it.
type Engine = Parameters<typeof stampRow>[0]
async function log(_rig: unknown, $: unknown, attributes: Record<string, unknown>, event = 'api_request'): Promise<Record<string, unknown>> {
  const got: { attributes: Record<string, unknown> }[] = []
  const next = Object.assign(async (e: unknown) => (got.push(e as never), { value: undefined }), { called: false, budget: { remainingMs: 1000 } })
  await stampRow($ as Engine, { event, attributes, loggedAt: LOGGED_AT } as never, next as never)
  if (got.length !== 1) throw new Error(`expected exactly one delivered row, got ${got.length}`)
  return got[0]!.attributes
}

const calls: string[] = []
const fake: Feature = {
  name: 'fake',
  prefix: 'mainwave.fake.',
  enabled: o => o['fake'] !== false,
  rules: { 'mainwave.fake.seen': v => v === 'yes', 'mainwave.fake.count': v => typeof v === 'number' && Number.isInteger(v) && v >= 0 },
  stamps: () => ({ 'mainwave.fake.seen': 'yes', 'mainwave.fake.count': 2 }),
  observe: (_a, event) => void calls.push(`observe:${event}`),
}
const thrower: Feature = {
  name: 'thrower',
  prefix: 'mainwave.thrower.',
  enabled: () => true,
  rules: { 'mainwave.thrower.x': () => true },
  stamps: () => { throw new Error('stamps failed') },
  observe: () => { throw new Error('observe failed') },
  steps: Object.fromEntries(
    (['session.start', 'turn.start', 'turn.step', 'turn.complete', 'tool.call', 'command.run', 'prompt.submit', 'agent.spawn', 'skill.prompt', 'session.end'] as const)
      .map(h => [h, () => { calls.push(h); throw new Error(`${h} failed`) }]),
  ),
}
const fakeKeys = (a: Record<string, unknown>) => Object.keys(a).filter(k => k.startsWith('mainwave.fake.') || k.startsWith('mainwave.thrower.')).sort()
const inOrg = { 'organization.id': ORG, 'session.id': 's-1' }

/** Runs `body` with `list` as the features, then puts the plugin's own list back. */
async function withFeatures(list: Feature[], options: Record<string, unknown>, body: () => Promise<void>) {
  calls.length = 0
  configureFeatures(options as never, list)
  try {
    await body()
  } finally {
    configureFeatures({} as never)
  }
}

describe('the plugin ships with no feature', () => {
  test('the list is empty and well formed, and no feature is on', () => {
    expect(FEATURES.length).toBe(0)
    expect(validFeatures(FEATURES)).toBe(true)
    expect(featureOn('fake')).toBe(false)
  })
})

describe('a feature on rows', () => {
  test('stamps under its own prefix where the plugin stamps, and learns from every row', async ($, on) => {
    const rig = boot(on, { entrypoint: 'cli' })
    await withFeatures([fake], {}, async () => {
      const a = await log(rig, $, { ...inOrg, 'mainwave.fake.seen': 'forged', 'mainwave.fake.other': 'x' })
      expect(fakeKeys(a)).toEqual(['mainwave.fake.count', 'mainwave.fake.seen'])
      expect(a['mainwave.fake.seen']).toBe('yes')
      expect(a['mainwave.fake.count']).toBe(2)
      expect(ownedKeys(a)).toEqual(STAMPED)
      expect(calls).toEqual(['observe:api_request'])
    })
  })

  test('a row with no organization carries none of its keys, forged ones included', async ($, on) => {
    const rig = boot(on)
    await withFeatures([fake], {}, async () => {
      expect(fakeKeys(await log(rig, $, { 'session.id': 's-2', 'mainwave.fake.seen': 'forged' }))).toEqual([])
      expect(fakeKeys(await log(rig, $, { 'organization.id': 'not-an-org', 'mainwave.fake.seen': 'yes' }))).toEqual([])
    })
  })

  test('off by its flag it adds nothing, and its prefix is still stripped', async ($, on) => {
    const rig = boot(on)
    await withFeatures([fake], { fake: false }, async () => {
      expect(featureOn('fake')).toBe(false)
      expect(fakeKeys(await log(rig, $, { ...inOrg, 'mainwave.fake.seen': 'forged' }))).toEqual([])
      expect(calls).toEqual([])
    })
  })

  test('a key outside its prefix, without a rule, or failing its rule is dropped', () => {
    configureFeatures({} as never, [{ ...fake, stamps: () => ({ 'mainwave.fake.seen': 'no', 'mainwave.fake.norule': 'x', 'mainwave.plugin.name': 'evil', 'user.email': 'a@example.com', 'mainwave.fake.count': 3 }) }])
    try {
      expect(featureStamps(inOrg, 'api_request')).toEqual({ 'mainwave.fake.count': 3 })
    } finally {
      configureFeatures({} as never)
    }
  })

  test('a feature that throws in observe or stamps leaves the row as the plugin stamps it, and the other features still stamp', async ($, on) => {
    const rig = boot(on, { entrypoint: 'cli' })
    await withFeatures([thrower, fake], {}, async () => {
      const a = await log(rig, $, { ...inOrg, 'mainwave.thrower.x': 'forged' })
      expect(fakeKeys(a)).toEqual(['mainwave.fake.count', 'mainwave.fake.seen'])
      expect(ownedKeys(a)).toEqual(STAMPED)
    })
  })

  test('the strip covers every feature prefix', () => {
    configureFeatures({} as never, [fake])
    try {
      expect(Object.keys(stripOwned({ a: 1, 'mainwave.fake.x': 1, 'mainwave.fakery': 2 }))).toEqual(['a', 'mainwave.fakery'])
    } finally {
      configureFeatures({} as never)
    }
  })
})

describe('a feature on hooks', () => {
  test('each step that throws is skipped, and every hook passes its event and result on unchanged', async ($) => {
    await withFeatures([thrower], {}, async () => {
      const pass = <T>(result: T) => {
        const got: unknown[] = []
        const next = Object.assign(async (e: unknown) => (got.push(e), result), { called: false, budget: { remainingMs: 1000 } })
        return { next: next as never, got }
      }
      const t = pass({ ok: 1 })
      expect(await turnStartHook($ as never, { text: 'hi' } as never, t.next)).toEqual({ ok: 1 })
      expect(t.got).toEqual([{ text: 'hi' }])
      const c = pass({ ok: 2 })
      expect(await turnCompleteHook($ as never, { durationMs: 1 } as never, c.next)).toEqual({ ok: 2 })
      const tc = pass({ result: 'r' })
      expect(await toolCallHook($ as never, { tool: 'Read', tool_use_id: 't1', file_path: '/x' } as never, tc.next)).toEqual({ result: 'r' })
      const cm = pass({ text: 'c' })
      expect(await commandHook($ as never, { command: 'cost', args: '' } as never, cm.next)).toEqual({ text: 'c' })
      const p = pass({})
      expect(await promptHook($ as never, { text: 'hello' } as never, p.next)).toEqual({})
      const s = pass({ agentId: 'a1' })
      expect(await spawnHook($ as never, { tool_use_id: 't2' } as never, s.next)).toEqual({ agentId: 'a1' })
      const end = pass(undefined)
      await sessionEnd($ as never, { reason: 'other' } as never, end.next)
      expect(end.got.length).toBe(1)
      expect(calls).toEqual(['turn.start', 'turn.complete', 'tool.call', 'command.run', 'prompt.submit', 'agent.spawn', 'session.end'])
    })
  })

  test('runSteps never rejects', async () => {
    await withFeatures([thrower], {}, async () => {
      await runSteps('turn.start', {})
      expect(calls).toEqual(['turn.start'])
    })
  })
})

describe('the list itself', () => {
  test('a malformed list runs no feature at all', () => {
    const bad: Feature[][] = [
      [fake, { ...fake }],
      [{ ...fake, prefix: 'mainwave.plugin.' }],
      [{ ...fake, prefix: 'mainwave.' }],
      [{ ...fake, prefix: 'other.fake.' }],
      [{ ...fake, prefix: 'mainwave.fake' }],
      [{ ...fake, name: 'Fake' }],
      [fake, { ...thrower, prefix: 'mainwave.fake.' }],
    ]
    for (const list of bad) {
      expect(validFeatures(list)).toBe(false)
      configureFeatures({} as never, list)
      expect(featureOn('fake')).toBe(false)
    }
    configureFeatures({} as never)
  })

  test('a feature whose enabled throws is off; one whose reset throws is still asked', () => {
    configureFeatures({} as never, [{ ...fake, enabled: () => { throw new Error('x') } }, { ...thrower, reset: () => { throw new Error('y') } }])
    try {
      expect(featureOn('fake')).toBe(false)
      expect(featureOn('thrower')).toBe(true)
    } finally {
      configureFeatures({} as never)
    }
  })
})

describe('what the review asked for', () => {
  test('a step that never settles holds no hook', async ($) => {
    const never: Feature = { ...fake, steps: { 'turn.start': () => new Promise(() => undefined), 'session.end': () => new Promise(() => undefined) } }
    await withFeatures([never], {}, async () => {
      const next = Object.assign(async () => ({ ok: 1 }), { called: false, budget: { remainingMs: 1000 } })
      expect(await turnStartHook($ as never, { text: 'hi' } as never, next as never)).toEqual({ ok: 1 })
    })
  })

  test('a step or observer that rejects is caught', async () => {
    const rejects: Feature = { ...fake, observe: () => Promise.reject(new Error('x')) as never, steps: { 'turn.start': () => Promise.reject(new Error('y')) } }
    await withFeatures([rejects], {}, async () => {
      runSteps('turn.start', {})
      await Promise.resolve()
    })
  })

  test('an observer reads the row less every owned key, forged ones of its own prefix included', async ($) => {
    const seen: Record<string, unknown>[] = []
    await withFeatures([{ ...fake, observe: a => void seen.push({ ...a }) }], {}, async () => {
      await log(undefined, $, { ...inOrg, 'mainwave.fake.seen': 'forged', 'mainwave.plugin.name': 'evil', keep: 1 })
      expect(Object.keys(seen[0]!).sort()).toEqual(['keep', 'organization.id', 'session.id'])
    })
  })

  test('only a short string, a finite number or a boolean is stamped, whatever the rule says', () => {
    configureFeatures({} as never, [{ ...fake, rules: { 'mainwave.fake.a': () => true, 'mainwave.fake.b': () => true, 'mainwave.fake.c': () => true, 'mainwave.fake.d': () => true, 'mainwave.fake.e': () => true },
      stamps: () => ({ 'mainwave.fake.a': 'x'.repeat(257), 'mainwave.fake.b': Number.NaN, 'mainwave.fake.c': { o: 1 } as never, 'mainwave.fake.d': true, 'mainwave.fake.e': 'ok' }) }])
    try {
      expect(featureStamps(inOrg, 'api_request')).toEqual({ 'mainwave.fake.d': true, 'mainwave.fake.e': 'ok' })
    } finally {
      configureFeatures({} as never)
    }
  })

  test('a prefix must be exactly mainwave.<name>., and the platform prefixes are reserved', () => {
    expect(validFeatures([{ ...fake, name: 'mcp', prefix: 'mainwave.mcp.' }])).toBe(false)
    expect(validFeatures([{ ...fake, name: 'command', prefix: 'mainwave.command.' }])).toBe(false)
    expect(validFeatures([{ ...fake, name: 'fake', prefix: 'mainwave.other.' }])).toBe(false)
    expect(validFeatures([{ ...fake, name: 'project-tags', prefix: 'mainwave.project_tags.' }])).toBe(true)
  })
})
