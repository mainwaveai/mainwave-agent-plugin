// The engine beneath the plugin for the end-to-end tests. Not a test file: the runner loads only *.test.ts.
//
// Written independently of hooks/: it imports nothing from the plugin, so a change to the plugin's rules can never also change what
// the tests expect.

import type { On } from 'claude-code'

/** Any customer's Claude organization, and another account in it (arbitrary IDs). */
export const ORG = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
export const ACCOUNT = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
export const EMAIL = 'dev@example.com'
export const DEVICE = '9b2c8f0e4d1a7c3b5e6f8a9d0c1b2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d'
export const LOGGED_AT = '2026-11-12T00:00:00.000Z'

/** Every key the plugin may put on a row, with the shape its value must have. */
export const CONTRACT: Record<string, (v: string) => boolean> = {
  'mainwave.mod.name': v => v === 'mainwave',
  'mainwave.mod.version': v => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v),
  'mainwave.mod.entrypoint': v => /^[a-z0-9_-]+$/.test(v),
  'mainwave.telemetry.source': v => v === 'policy' || v === 'user' || v === 'default',
}
export const STAMPED = Object.keys(CONTRACT).sort()
export const isOwned = (k: string) => k.startsWith('mainwave.mod.') || k.startsWith('mainwave.telemetry.')

/** A settings layer as the test answers it: an object, or `reject` for a read that fails. */
export type Answer = Record<string, unknown> | 'reject'
export type Layers = Partial<Record<'policy' | 'flag' | 'user' | 'project' | 'local', Answer>>
export type Rig = { rows: { event: string; attributes: Record<string, unknown> }[]; reads: string[] }

/** The plugin's option in a settings layer, under the given plugin id. */
export const option = (value: unknown, id = 'mainwave@mainwave'): Record<string, unknown> => ({ pluginConfigs: { [id]: { options: { reporting: value } } } })

/** Hooks that stand for the engine: settings layers, the environment, and the collector, which records each row it receives. */
export function boot(on: On, opts: { layers?: Layers; entrypoint?: string } = {}): Rig {
  const rig: Rig = { rows: [], reads: [] }
  on('settings.read', async (_$, e) => {
    const source = String((e as { source?: string }).source)
    rig.reads.push(source)
    const answer = (opts.layers as Record<string, Answer | undefined> | undefined)?.[source] ?? {}
    if (answer === 'reject') throw new Error(`settings.read ${source} refused in test`)
    return { value: answer } as never
  })
  on('env.get', async (_$, e) => ({ value: (e as unknown as { name: string }).name === 'CLAUDE_CODE_ENTRYPOINT' ? opts.entrypoint : undefined }) as never)
  on('telemetry.log', async (_$, e) => {
    const row = e as unknown as { event: string; attributes: Record<string, unknown> }
    rig.rows.push({ event: row.event, attributes: { ...row.attributes } })
    return { value: undefined } as never
  })
  return rig
}

/** Records each value the plugin writes to its `identity` in `$.state`, then lets the kit store it. */
export function watchIdentity(on: On): unknown[] {
  const writes: unknown[] = []
  on('state.set', (_$, e, next) => {
    const w = e as unknown as { plugin: string; key: string; value: unknown }
    if (w.plugin === 'mainwave' && w.key === 'identity') writes.push(w.value)
    return next(e)
  })
  return writes
}

type Engine = { telemetry: { log: (a: never) => Promise<unknown> } }

/** Logs one collector row and answers its attributes as the collector received them. */
export async function log(rig: Rig, $: Engine, attributes: Record<string, unknown>, event = 'api_request') {
  const before = rig.rows.length
  await $.telemetry.log({ to: 'collector', event, attributes, loggedAt: LOGGED_AT } as never)
  if (rig.rows.length !== before + 1) throw new Error(`expected exactly one delivered row, got ${rig.rows.length - before}`)
  return rig.rows[rig.rows.length - 1]!.attributes
}

/** The owned keys on a row, sorted. */
export const ownedKeys = (attributes: Record<string, unknown>) => Object.keys(attributes).filter(isOwned).sort()

/** Why the row's owned keys break the contract; empty when they keep it. */
export function contractViolations(attributes: Record<string, unknown>): string[] {
  const bad: string[] = []
  for (const key of ownedKeys(attributes)) {
    const rule = CONTRACT[key]
    const value = attributes[key]
    if (rule === undefined) bad.push(`unknown owned key ${key}`)
    else if (typeof value !== 'string' || !rule(value)) bad.push(`${key}=${JSON.stringify(value)} fails its shape`)
  }
  return bad
}
