// Where the plugin's dev ingest key and the person's opt-in to more data points may come from, and the shape the key must have. Pure:
// tests call it directly.
//
// Without a key the copy goes keyless; the key, where the person sets one, sends it with that key instead. The key is the person's
// own: `claude plugin configure` keeps a sensitive option in secure storage, and the engine hands it to `register` as `options`. A
// repository's settings (`project`, `local`) are not the person's. A repository that names the option under any of the plugin's ids
// could be trying to send the person's rows somewhere they did not choose, so the plugin then sends nothing. A repository layer that
// cannot be read counts as naming it.
//
// This guards against settings only. Another plugin the person has installed runs beside this one and can read or rewrite its
// requests (`http.fetch` hooks see every plugin's) and the settings it reads; nothing a plugin does can keep its key from those.

/** A settings layer as `$.settings.read` answers it, or `unreadable` when the read failed. */
export type Layer = Readonly<Record<string, unknown>> | 'unreadable'

/**
 * The plugin's ids in `pluginConfigs`: bare (a `--plugin-dir` load), or `mainwave@<marketplace>` from any marketplace (this
 * repository's, org sync, `inline`, or one that does not exist yet). Wide on purpose: an id this misses is one a repository could use.
 */
export const PLUGIN_ID = /^mainwave(@[^@\s]+)?$/

/** The option that holds the dev ingest key. */
export const KEY_OPTION = 'devIngestKey'
/** The options only the person's own settings may set. */
export const SENDING_OPTIONS: readonly string[] = [KEY_OPTION]

/**
 * The option that lists the data points the person opts in to (gate.ts, `optInOf`). The manifest doesn't declare it: the engine
 * refuses to load a hooks module whose declared option holds a value of the wrong type, and a typo here must never stop the plugin.
 * Nor does the plugin take it from `options`, which merge `--settings` and managed settings in: it reads the person's user settings
 * alone (`optionValues` on the `user` layer), never a repository's (`project`, `local`), `--settings` or managed settings.
 */
export const OPT_IN_OPTION = 'extraDataPoints'

/**
 * The option that lists the redaction packs to run (gate.ts, `packsOf`), undeclared for the same reason. The organization sets it in
 * its managed settings (the `policy` layer), and those packs apply to everyone; a person may add packs in their own user settings
 * (the `user` layer), never take one away. A repository's settings (`project`, `local`) and `--settings` are not read for it.
 */
export const PACKS_OPTION = 'redactionPacks'

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Whether a layer names any of the options under any of the plugin's ids, to any value. A layer that cannot be read does. */
export function namesOption(layer: Layer, options: readonly string[] = SENDING_OPTIONS): boolean {
  if (layer === 'unreadable') return true
  if (!has(layer, 'pluginConfigs')) return false
  const configs = layer['pluginConfigs']
  if (!isObject(configs)) return false
  for (const [id, entry] of Object.entries(configs)) {
    if (!PLUGIN_ID.test(id) || !isObject(entry)) continue
    const opts = entry['options']
    if (isObject(opts) && options.some(o => has(opts, o))) return true
  }
  return false
}

/** The values a layer gives the option under each of the plugin's ids, in their order; none from a layer that cannot be read. */
export function optionValues(layer: Layer, option: string): unknown[] {
  if (layer === 'unreadable' || !has(layer, 'pluginConfigs')) return []
  const configs = layer['pluginConfigs']
  if (!isObject(configs)) return []
  const out: unknown[] = []
  for (const [id, entry] of Object.entries(configs)) {
    if (!PLUGIN_ID.test(id) || !isObject(entry)) continue
    const opts = entry['options']
    if (isObject(opts) && has(opts, option)) out.push(opts[option])
  }
  return out
}

// Printable ASCII, no spaces: what a header value can carry as it is.
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/

/** The key as the option holds it, with a leading `Bearer ` taken off; `null` when unset or of the wrong shape. */
export function ingestKeyOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().replace(/^bearer\s+/i, '')
  return KEY_SHAPE.test(key) ? key : null
}
