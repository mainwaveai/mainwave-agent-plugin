// Where the person's collector override and their opt-in to more data points may come from, and the shape the override must have.
// Pure: tests call it directly.
//
// The copy goes to Mainwave's production collector unless the person's own user settings name another (`collectorUrl`): Mainwave's
// dev collector, or a local receiver for a test. A repository's settings (`project`, `local`) are not the person's. A repository that
// names the option under any of the plugin's ids could be trying to send the person's rows somewhere they did not choose, so the
// plugin then sends nothing. A repository layer that cannot be read counts as naming it.
//
// This guards against settings only. Another plugin the person has installed runs beside this one and can read or rewrite its
// requests (`http.fetch` hooks see every plugin's) and the settings it reads; nothing a plugin does can keep its requests from those.

/** A settings layer as `$.settings.read` answers it, or `unreadable` when the read failed. */
export type Layer = Readonly<Record<string, unknown>> | 'unreadable'

/**
 * The plugin's ids in `pluginConfigs`: bare (a `--plugin-dir` load), or `mainwave@<marketplace>` from any marketplace (this
 * repository's, org sync, `inline`, or one that does not exist yet). Wide on purpose: an id this misses is one a repository could use.
 */
export const PLUGIN_ID = /^mainwave(@[^@\s]+)?$/

/**
 * The option that sends the copy to another collector than production's. Like `OPT_IN_OPTION`, the manifest doesn't declare it, and
 * the plugin reads it from the person's user settings alone (`optionValues` on the `user` layer).
 */
export const COLLECTOR_OPTION = 'collectorUrl'
/** The options only the person's own settings may set. */
export const SENDING_OPTIONS: readonly string[] = [COLLECTOR_OPTION]

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

/**
 * Where the copy goes, a path per signal after it, unless the person's own user settings name another collector (`collectorUrl`).
 * Nothing reads a URL from the environment or from the organization's settings.
 */
export const PROD_COLLECTOR = 'https://collector.mainwave.com'

/**
 * Where the person's user settings send the copy: the `collectorUrl` they give under the plugin's ids, else production's collector.
 * `malformed` for a value that has not the shape, or ids that give different values; `unreadable` for a layer that can't be read.
 */
export function collectorIn(layer: Layer): string | 'malformed' | 'unreadable' {
  if (layer === 'unreadable') return 'unreadable'
  const set = optionValues(layer, COLLECTOR_OPTION).filter(raw => !(raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')))
  if (set.length === 0) return PROD_COLLECTOR
  const urls = new Set(set.map(collectorUrlOf))
  const [url] = urls
  return urls.size === 1 && url !== null && url !== undefined ? url : 'malformed'
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The collector a `collectorUrl` value names, as an origin and an optional path with no trailing `/`, the signal's `/v1/...` path to
 * go after it; `null` when it has not the shape. It must be https, or http on a loopback host (a local receiver), with no user, query
 * or fragment.
 */
export function collectorUrlOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) return null
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.hostname === '') return null
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}
