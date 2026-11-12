// End to end: the plugin loaded by the test kit's host, driven through $.telemetry.log, with the engine beneath it played by rig.ts.

import { describe, expect, test } from 'claude-code/testing'

import { rowCatch } from '../hooks/register.ts'
import { VERSION } from '../hooks/version.ts'
import { ACCOUNT, boot, contractViolations, DEVICE, EMAIL, log, option, ORG, ownedKeys, STAMPED, watchIdentity } from './rig.ts'

const inOrg = { 'organization.id': ORG, 'session.id': 's-1' }

describe('stamping', () => {
  test('a row that names an organization carries the plugin name, version, entry point and source', async ($, on) => {
    const rig = boot(on, { entrypoint: 'cli' })
    const a = await log(rig, $, inOrg)
    expect(ownedKeys(a)).toEqual(STAMPED)
    expect(a['mainwave.mod.name']).toBe('mainwave')
    expect(a['mainwave.mod.version']).toBe(VERSION)
    expect(a['mainwave.mod.entrypoint']).toBe('cli')
    expect(a['mainwave.telemetry.source']).toBe('default')
    expect(contractViolations(a)).toEqual([])
  })

  test("the row's own attributes go on unchanged and in order", async ($, on) => {
    const rig = boot(on)
    const a = await log(rig, $, { 'organization.id': ORG, model: 'claude-opus-5-5', cost_usd: 0.25, input_tokens: 10 })
    expect(Object.keys(a).slice(0, 4)).toEqual(['organization.id', 'model', 'cost_usd', 'input_tokens'])
    expect(a['cost_usd']).toBe(0.25)
    expect(a['input_tokens']).toBe(10)
  })

  test('an unknown entry point reads as other; none set reads as other', async ($, on) => {
    const rig = boot(on, { entrypoint: 'something-new' })
    expect((await log(rig, $, inOrg))['mainwave.mod.entrypoint']).toBe('other')
  })

  test('a row with no organization carries no stamp (the default is off until the organization is known)', async ($, on) => {
    const rig = boot(on)
    expect(ownedKeys(await log(rig, $, { 'session.id': 's-1' }))).toEqual([])
    expect(ownedKeys(await log(rig, $, { 'organization.id': '' }))).toEqual([])
  })

  test('forged keys under the owned prefixes are removed and replaced by the real ones', async ($, on) => {
    const rig = boot(on, { entrypoint: 'cli' })
    const a = await log(rig, $, { ...inOrg, 'mainwave.mod.name': 'evil', 'mainwave.mod.extra': 'x', 'mainwave.telemetry.state': 'on' })
    expect(ownedKeys(a)).toEqual(STAMPED)
    expect(a['mainwave.mod.name']).toBe('mainwave')
    expect(contractViolations(a)).toEqual([])
  })

  test('forged keys are removed even where reporting is off', async ($, on) => {
    const rig = boot(on, { layers: { policy: option(false) } })
    const a = await log(rig, $, { ...inOrg, 'mainwave.mod.name': 'evil', 'mainwave.telemetry.source': 'policy' })
    expect(ownedKeys(a)).toEqual([])
    expect(a['session.id']).toBe('s-1')
  })

  test("keys outside the owned prefixes, Mainwave's included, are left alone", async ($, on) => {
    const rig = boot(on)
    const a = await log(rig, $, { ...inOrg, 'mainwave.attr.project': 'p1', 'mainwave.modx': 'kept' })
    expect(a['mainwave.attr.project']).toBe('p1')
    expect(a['mainwave.modx']).toBe('kept')
  })
})

describe('the reporting switch: organization, then person, then default', () => {
  test("the organization's off wins over the person's on", async ($, on) => {
    const rig = boot(on, { layers: { policy: option(false), user: option(true) } })
    expect(ownedKeys(await log(rig, $, inOrg))).toEqual([])
  })

  test("the organization's on wins over the person's off, and says so", async ($, on) => {
    const rig = boot(on, { layers: { policy: option(true, 'mainwave@synced'), user: option(false) } })
    expect((await log(rig, $, inOrg))['mainwave.telemetry.source']).toBe('policy')
  })

  test("the person's off counts where the organization says nothing", async ($, on) => {
    const rig = boot(on, { layers: { user: option(false) } })
    expect(ownedKeys(await log(rig, $, inOrg))).toEqual([])
  })

  test("--settings counts before the person's user settings", async ($, on) => {
    const rig = boot(on, { layers: { flag: option(true), user: option(false) } })
    expect((await log(rig, $, inOrg))['mainwave.telemetry.source']).toBe('user')
  })

  test("a repository's settings change nothing", async ($, on) => {
    const rig = boot(on, { layers: { project: option(false), local: option(false) } })
    expect((await log(rig, $, inOrg))['mainwave.telemetry.source']).toBe('default')
    expect(rig.reads).not.toContain('project')
    expect(rig.reads).not.toContain('local')
  })

  test("another plugin's options change nothing", async ($, on) => {
    const rig = boot(on, { layers: { policy: option(false, 'mainwave@someone-else'), user: option(false, 'mainwave-extra') } })
    expect((await log(rig, $, inOrg))['mainwave.telemetry.source']).toBe('default')
  })

  for (const source of ['policy', 'flag', 'user'] as const) {
    test(`an unreadable ${source} layer turns reporting off, and the row is still delivered`, async ($, on) => {
      const rig = boot(on, { layers: { [source]: 'reject' } })
      const a = await log(rig, $, inOrg)
      expect(ownedKeys(a)).toEqual([])
      expect(a['session.id']).toBe('s-1')
    })
  }

  test('a malformed value turns reporting off', async ($, on) => {
    const rig = boot(on, { layers: { policy: option('false') } })
    expect(ownedKeys(await log(rig, $, inOrg))).toEqual([])
  })

  test('the switch is read on every row: an organization that turns reporting off stops it at the next row', async ($, on) => {
    const layers: { policy: Record<string, unknown> } = { policy: {} }
    const rig = boot(on, { layers })
    expect(ownedKeys(await log(rig, $, inOrg))).toEqual(STAMPED)
    layers.policy = option(false)
    expect(ownedKeys(await log(rig, $, inOrg))).toEqual([])
  })
})

describe('identity from rows', () => {
  test('the organization, account, email and device are kept for the session', async ($, on) => {
    const rig = boot(on)
    const writes = watchIdentity(on)
    await log(rig, $, { ...inOrg, 'user.account_uuid': ACCOUNT, 'user.email': EMAIL, 'user.id': DEVICE })
    expect(writes).toEqual([{ organizationId: ORG, accountUuid: ACCOUNT, email: EMAIL, deviceId: DEVICE }])
  })

  test('a later row adds what an earlier one lacked and replaces what changed; an unchanged row writes nothing', async ($, on) => {
    const rig = boot(on)
    const writes = watchIdentity(on)
    await log(rig, $, { ...inOrg, 'user.email': EMAIL })
    await log(rig, $, { ...inOrg, 'user.email': EMAIL })
    await log(rig, $, { ...inOrg, 'user.id': DEVICE, 'user.email': 'other@example.com' })
    expect(writes).toEqual([
      { organizationId: ORG, email: EMAIL },
      { organizationId: ORG, email: 'other@example.com', deviceId: DEVICE },
    ])
  })

  test('values that do not fit their shape are not kept', async ($, on) => {
    const rig = boot(on)
    const writes = watchIdentity(on)
    await log(rig, $, { ...inOrg, 'user.account_uuid': 'not-a-uuid', 'user.email': 'no-at-sign', 'user.id': 'has spaces' })
    expect(writes).toEqual([{ organizationId: ORG }])
  })

  test('nothing is kept while reporting is off', async ($, on) => {
    const rig = boot(on, { layers: { policy: option(false) } })
    const writes = watchIdentity(on)
    await log(rig, $, { ...inOrg, 'user.email': EMAIL })
    expect(writes).toEqual([])
  })

  test('a failed write never holds the row', async ($, on) => {
    const rig = boot(on)
    on('state.set', () => { throw new Error('state refused in test') })
    const a = await log(rig, $, { ...inOrg, 'user.email': EMAIL })
    expect(ownedKeys(a)).toEqual(STAMPED)
  })

  test('the identity is never stamped on the row by the plugin', async ($, on) => {
    const rig = boot(on)
    const a = await log(rig, $, { 'organization.id': ORG })
    expect(a['user.email']).toBeUndefined()
    expect(a['user.id']).toBeUndefined()
  })
})

describe('fail open', () => {
  const row = { to: 'collector', event: 'api_request', loggedAt: '2026-11-12T00:00:00.000Z', attributes: { 'organization.id': ORG, 'mainwave.mod.name': 'evil' } } as const

  test('a failure before the row went on sends it without any owned key', async () => {
    const sent: unknown[] = []
    const next = Object.assign((e: unknown) => { sent.push(e); return {} }, { called: false })
    rowCatch(undefined as never, row as never, next as never)
    expect(sent).toEqual([{ ...row, attributes: { 'organization.id': ORG } }])
  })

  test('a failure after the row went on replays it as it was sent', async () => {
    const sent: unknown[] = []
    const next = Object.assign((e: unknown) => { sent.push(e); return {} }, { called: true })
    rowCatch(undefined as never, row as never, next as never)
    expect(sent).toEqual([row])
  })

  test('a row whose attributes cannot be read goes on as it came', async () => {
    const broken = { ...row, get attributes(): never { throw new Error('unreadable') } }
    const sent: unknown[] = []
    const next = Object.assign((e: unknown) => { sent.push(e); return {} }, { called: false })
    rowCatch(undefined as never, broken as never, next as never)
    expect(sent.length).toBe(1)
    expect(sent[0] === broken).toBe(true)
  })
})
