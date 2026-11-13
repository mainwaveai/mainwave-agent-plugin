// Where the plugin's dev ingest key may come from, and the shape it must have. Pure: tests call it directly.
//
// The key is the person's own: `/config` keeps a sensitive option in secure storage and hands it to `register` as `options`. A
// repository's settings (`project`, `local`) are not the person's. A repository that names the option under any of the plugin's
// ids could be trying to send the person's rows somewhere they did not choose, so the plugin then sends nothing. A repository
// layer that cannot be read counts as naming it.

/** A settings layer as `$.settings.read` answers it, or `unreadable` when the read failed. */
export type Layer = Readonly<Record<string, unknown>> | 'unreadable'

/** The plugin's ids in `pluginConfigs`: bare (a `--plugin-dir` load), or installed from this repository's marketplace or by org sync. */
export const PLUGIN_ID = /^mainwave(@(mainwave|inline|synced))?$/

/** The option that holds the dev ingest key. */
export const KEY_OPTION = 'devIngestKey'

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Whether a layer names the option under any of the plugin's ids, to any value. A layer that cannot be read does. */
export function namesOption(layer: Layer, option: string = KEY_OPTION): boolean {
  if (layer === 'unreadable') return true
  if (!has(layer, 'pluginConfigs')) return false
  const configs = layer['pluginConfigs']
  if (!isObject(configs)) return false
  for (const [id, entry] of Object.entries(configs)) {
    if (!PLUGIN_ID.test(id) || !isObject(entry)) continue
    const options = entry['options']
    if (isObject(options) && has(options, option)) return true
  }
  return false
}

// Printable ASCII, no spaces: what a header value can carry as it is.
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/

/** The key as the option holds it, with a leading `Bearer ` taken off; `null` when unset or of the wrong shape. */
export function ingestKeyOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().replace(/^bearer\s+/i, '')
  return KEY_SHAPE.test(key) ? key : null
}
