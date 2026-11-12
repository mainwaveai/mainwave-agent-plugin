// The reporting switch: whether the plugin stamps this session's rows. Pure: tests call it directly.
//
// The order, first answer wins:
//   1. the organization's managed settings (the `policy` layer), under any of the plugin's ids
//   2. the person's own settings: `--settings` (the `flag` layer), then their user settings; never a repository's (`project`, `local`)
//   3. the default: on once the row names an organization (a UUID in `organization.id`), off otherwise
//
// A layer that cannot be read, or holds a malformed entry or a value that is not a boolean, ends the search with the switch off and
// the source `error`: an administrator's or a person's mistake never reports more than they asked for.
//
// The option sits where Claude Code keeps every plugin's options: `pluginConfigs["<plugin id>"].options.reporting`, in managed settings
// for the organization and in user settings for the person (the /config menu writes it there).

import { isOrgId } from './identity.ts'

/** A settings layer as `$.settings.read` answers it, or `unreadable` when the read failed. */
export type Layer = Readonly<Record<string, unknown>> | 'unreadable'

/** The plugin's ids in `pluginConfigs`: bare (a `--plugin-dir` load), or installed from this repository's marketplace or by org sync. */
export const PLUGIN_ID = /^mainwave(@(mainwave|inline|synced))?$/

/** The option that holds the switch. */
export const OPTION = 'reporting'

export type Vote = { kind: 'set'; on: boolean } | { kind: 'absent' } | { kind: 'invalid' }
export type Source = 'policy' | 'user' | 'default' | 'error'
export type Switch = { on: boolean; source: Source }

const ABSENT: Vote = { kind: 'absent' }
const INVALID: Vote = { kind: 'invalid' }
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/**
 * One layer's vote on an option, across every id of the plugin in its `pluginConfigs`. An off under any id wins over an on under
 * another, so two installs of the plugin can never outvote an off. With no off, a malformed entry or value makes the vote invalid.
 */
export function layerVote(layer: Layer, option: string = OPTION): Vote {
  if (layer === 'unreadable') return INVALID
  if (!has(layer, 'pluginConfigs')) return ABSENT
  const configs = layer['pluginConfigs']
  if (!isObject(configs)) return INVALID
  let vote: Vote = ABSENT
  let bad = false
  for (const [id, entry] of Object.entries(configs)) {
    if (!PLUGIN_ID.test(id)) continue
    if (!isObject(entry)) { bad = true; continue }
    if (!has(entry, 'options')) continue
    const options = entry['options']
    if (!isObject(options)) { bad = true; continue }
    if (!has(options, option)) continue
    const value = options[option]
    if (typeof value !== 'boolean') { bad = true; continue }
    if (!value) return { kind: 'set', on: false }
    vote = { kind: 'set', on: true }
  }
  return bad ? INVALID : vote
}

/** The person's vote: `--settings` first, then their user settings. The first that says anything answers. */
export function personVote(layers: { flag: Layer; user: Layer }, option: string = OPTION): Vote {
  const flag = layerVote(layers.flag, option)
  return flag.kind === 'absent' ? layerVote(layers.user, option) : flag
}

/** The switch from the organization's vote, the person's vote and the row's organization, in that order. */
export function resolveSwitch(policy: Vote, person: Vote, orgId: unknown, defaultOn = true): Switch {
  for (const [vote, source] of [[policy, 'policy'], [person, 'user']] as const) {
    if (vote.kind === 'set') return { on: vote.on, source }
    if (vote.kind === 'invalid') return { on: false, source: 'error' }
  }
  return { on: defaultOn && isOrgId(orgId), source: 'default' }
}

/** The reporting switch for one row, from the three layers it reads. */
export function reportingSwitch(layers: { policy: Layer; flag: Layer; user: Layer }, orgId: unknown): Switch {
  return resolveSwitch(layerVote(layers.policy), personVote(layers), orgId)
}
