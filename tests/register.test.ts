// End to end: the plugin loaded by the test kit's host, driven through $.telemetry.log, with the engine beneath it played by rig.ts.

import { describe, expect, test } from 'claude-code/testing'

import { rowCatch } from '../hooks/register.ts'
import { VERSION } from '../hooks/version.ts'
import { ACCOUNT, boot, contractViolations, DEVICE, EMAIL, log, ORG, ownedKeys, STAMPED, watchIdentity } from './rig.ts'

const inOrg = { 'organization.id': ORG, 'session.id': 's-1' }

describe('stamping', () => {
  test("a row that names an organization carries the plugin's name, version, entry point and route", async ($, on) => {
    const rig = boot(on, { entrypoint: 'cli' })
    const a = await log(rig, $, inOrg)
    expect(ownedKeys(a)).toEqual(STAMPED)
    expect(a['mainwave.plugin.name']).toBe('mainwave')
    expect(a['mainwave.plugin.version']).toBe(VERSION)
    expect(a['mainwave.plugin.entrypoint']).toBe('cli')
    expect(a['mainwave.telemetry.route']).toBe('exporter')
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
    expect((await log(rig, $, inOrg))['mainwave.plugin.entrypoint']).toBe('other')
  })

  test('a row with no organization carries no stamp', async ($, on) => {
    const rig = boot(on)
    expect(ownedKeys(await log(rig, $, { 'session.id': 's-1' }))).toEqual([])
    expect(ownedKeys(await log(rig, $, { 'organization.id': '' }))).toEqual([])
  })

  test('forged keys under the owned prefixes are removed and replaced by the real ones', async ($, on) => {
    const rig = boot(on, { entrypoint: 'cli' })
    const a = await log(rig, $, { ...inOrg, 'mainwave.plugin.name': 'evil', 'mainwave.plugin.extra': 'x', 'mainwave.telemetry.route': 'plugin' })
    expect(ownedKeys(a)).toEqual(STAMPED)
    expect(a['mainwave.plugin.name']).toBe('mainwave')
    expect(a['mainwave.telemetry.route']).toBe('exporter')
    expect(contractViolations(a)).toEqual([])
  })

  test('keys under the old mainwave.mod. prefix are removed, on a row with an organization or without', async ($, on) => {
    const rig = boot(on, { entrypoint: 'cli' })
    const old = { 'mainwave.mod.name': 'old-plugin', 'mainwave.mod.version': '0.9.0', 'mainwave.mod.entrypoint': 'cli' }
    const a = await log(rig, $, { ...inOrg, ...old })
    expect(ownedKeys(a)).toEqual(STAMPED)
    expect(contractViolations(a)).toEqual([])
    expect(ownedKeys(await log(rig, $, { 'session.id': 's-1', ...old }))).toEqual([])
  })

  test('forged keys are removed from a row with no organization too', async ($, on) => {
    const rig = boot(on)
    const a = await log(rig, $, { 'session.id': 's-1', 'mainwave.plugin.name': 'evil', 'mainwave.telemetry.source': 'policy' })
    expect(ownedKeys(a)).toEqual([])
    expect(a['session.id']).toBe('s-1')
  })

  test("keys outside the owned prefixes, Mainwave's included, are left alone", async ($, on) => {
    const rig = boot(on)
    const a = await log(rig, $, { ...inOrg, 'mainwave.attr.project': 'p1', 'mainwave.modx': 'kept', 'mainwave.pluginx': 'kept', 'mainwave.mod': 'kept' })
    expect(a['mainwave.attr.project']).toBe('p1')
    expect(a['mainwave.modx']).toBe('kept')
    expect(a['mainwave.pluginx']).toBe('kept')
    expect(a['mainwave.mod']).toBe('kept')
  })

  test('no settings layer is read for a row, and no option turns stamping off', async ($, on) => {
    const rig = boot(on, { layers: { policy: { pluginConfigs: { 'mainwave@synced': { options: { reporting: false } } } } } })
    expect(ownedKeys(await log(rig, $, inOrg))).toEqual(STAMPED)
    expect(rig.reads).toEqual([])
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

  test('nothing is kept from a row with no organization', async ($, on) => {
    const rig = boot(on)
    const writes = watchIdentity(on)
    await log(rig, $, { 'user.email': EMAIL })
    expect(writes).toEqual([])
  })

  test('a failed write never holds the row', async ($, on) => {
    const rig = boot(on)
    on('state.set', () => ({ deny: 'state refused in test' }) as never)
    const a = await log(rig, $, { ...inOrg, 'user.email': EMAIL })
    expect(ownedKeys(a)).toEqual(STAMPED)
  })

  test('two rows that land together each keep their fields', async ($, on) => {
    const rig = boot(on)
    const writes = watchIdentity(on)
    // The two rows' updates overlap: the second write misses its version and is made again over the first one's value.
    await Promise.all([
      $.telemetry.log({ to: 'collector', event: 'a', attributes: { ...inOrg, 'user.email': EMAIL }, loggedAt: '2026-11-12T00:00:00.000Z' } as never),
      $.telemetry.log({ to: 'collector', event: 'b', attributes: { ...inOrg, 'user.id': DEVICE }, loggedAt: '2026-11-12T00:00:00.000Z' } as never),
    ])
    expect(rig.rows.length).toBe(2)
    expect(writes[writes.length - 1]).toEqual({ organizationId: ORG, email: EMAIL, deviceId: DEVICE })
  })

  test("the plugin adds no identity of its own: Claude Code's identity attributes go on as they came", async ($, on) => {
    const rig = boot(on)
    const a = await log(rig, $, { ...inOrg, 'user.email': EMAIL, 'user.id': DEVICE, 'user.account_uuid': ACCOUNT })
    expect(a['user.email']).toBe(EMAIL)
    expect(a['user.id']).toBe(DEVICE)
    expect(a['user.account_uuid']).toBe(ACCOUNT)
    for (const key of ownedKeys(a)) expect([EMAIL, DEVICE, ACCOUNT, ORG]).not.toContain(a[key])
    expect(ownedKeys(a)).toEqual(STAMPED)
  })
})

describe('fail open', () => {
  const row = { to: 'collector', event: 'api_request', loggedAt: '2026-11-12T00:00:00.000Z', attributes: { 'organization.id': ORG, 'mainwave.plugin.name': 'evil' } } as const

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
