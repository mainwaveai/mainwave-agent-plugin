// The MCP servers set up for a session, for the `mcp.url` data point: read from the files Claude keeps them in, each server's name,
// where it was set up, how it is reached and its address. Pure: the hooks (register.ts) read the files, tests hand it their text.
//
// Where Claude Code 2.1.322 keeps them, and the scope each is read as:
//   user      `mcpServers` in its global config, `.claude.json` in `CLAUDE_CONFIG_DIR`, else the home folder
//   local     `projects[<project root>].mcpServers` in the same file
//   project   `.mcp.json` in the project root and each folder above it
//   managed   `managed-mcp.json` in the managed settings folder (one path per OS: each is tried)
//   plugin    `.mcp.json`, or `mcpServers` in `.claude-plugin/plugin.json`, of each plugin installed and enabled
//   desktop   `claude_desktop_config.json`, where Claude Desktop and Cowork keep theirs: read outside the CLI alone
// A managed file, where there is one, has exclusive control, as in Claude Code: only its servers load, and only they are read.
// Where two settings name the same server, the nearest wins: local, then project (the nearest folder first), then user.
// A claude.ai connector, a server the host app provides and one set with `--mcp-config` are in none of these: the plugin sends such a
// server's name and scope when a call first names it.
//
// Only each server's name, transport and address are read: never its headers, environment or anything else in these files. A remote
// server's address keeps scheme, host, port and path, and drops any user name, password, query and fragment; a local server's is its
// command and arguments, which the always-on protections then scrub of secrets.

/** One MCP server set up for the session. */
export type McpServer = { name: string; scope: string; transport?: string; address?: string }

/** The managed settings folders, by OS, as Claude Code names them. */
export const MANAGED_DIRS = ['/Library/Application Support/ClaudeCode', '/etc/claude-code', 'C:\\Program Files\\ClaudeCode'] as const

/** Where Claude Desktop keeps its config, under the home folder (macOS, Linux) or `APPDATA` (Windows). */
export const DESKTOP_UNDER_HOME = [['Library', 'Application Support', 'Claude', 'claude_desktop_config.json'], ['.config', 'Claude', 'claude_desktop_config.json']] as const
export const DESKTOP_UNDER_APPDATA = ['Claude', 'claude_desktop_config.json'] as const
/** How many plugins are read at most. */
export const MAX_PLUGINS = 50

/** How many folders above the project root are looked in for `.mcp.json`. */
const MAX_DEPTH = 32
/** How many servers one session sends at most. */
export const MAX_SERVERS = 200

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A path joined with the separator its base uses. */
export function join(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

/** The folder a path is in; undefined at the root (`/`, `C:\\`). */
function parent(path: string): string | undefined {
  const t = path.length > 1 ? path.replace(/[\\/]+$/, '') : path
  if (t === '/' || /^[A-Za-z]:\\?$/.test(t)) return undefined
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'))
  if (i < 0) return undefined
  if (i === 0) return '/'
  const up = t.slice(0, i)
  return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up
}

/** The project root and each folder above it, nearest first. */
export function foldersUp(root: string): string[] {
  const out: string[] = []
  let dir: string | undefined = root
  while (dir !== undefined && out.length < MAX_DEPTH && !out.includes(dir)) {
    out.push(dir)
    dir = parent(dir)
  }
  return out
}

/** A remote server's address: scheme, host, port and path, without a user name, password, query or fragment. */
export function remoteAddress(raw: string): string | undefined {
  const m = /^([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^/?#@]{0,1024}@)?([^?#]{0,4096})/i.exec(raw.trim())
  return m ? `${m[1]}${m[2]}` : undefined
}

/** One server's entry as a config file holds it, read for its transport and address alone. */
export function serverOf(name: string, scope: string, config: unknown): McpServer | undefined {
  if (name === '' || !isObject(config)) return undefined
  const url = typeof config['url'] === 'string' ? config['url'] : undefined
  const command = typeof config['command'] === 'string' ? config['command'] : undefined
  const type = typeof config['type'] === 'string' ? config['type'] : url !== undefined ? 'http' : command !== undefined ? 'stdio' : undefined
  const args = Array.isArray(config['args']) ? config['args'].filter((a): a is string => typeof a === 'string') : []
  const address = url !== undefined ? remoteAddress(url) : command !== undefined ? [command, ...args].join(' ') : undefined
  return { name, scope, ...(type !== undefined ? { transport: type } : {}), ...(address !== undefined ? { address } : {}) }
}

/** The servers of one `mcpServers` object. */
export function serversIn(servers: unknown, scope: string, name: (key: string) => string = k => k): McpServer[] {
  if (!isObject(servers)) return []
  return Object.entries(servers).flatMap(([key, config]) => serverOf(name(key), scope, config) ?? [])
}

/** A file's text as JSON; undefined when it is not. */
export function parse(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Claude Code's global config: the user's servers, and the local ones of the project at `root`. */
export function globalServers(json: unknown, root: string | undefined): { user: McpServer[]; local: McpServer[] } {
  if (!isObject(json)) return { user: [], local: [] }
  const projects = json['projects']
  const local = root !== undefined && isObject(projects) && isObject(projects[root]) ? (projects[root] as Record<string, unknown>)['mcpServers'] : undefined
  return { user: serversIn(json['mcpServers'], 'user'), local: serversIn(local, 'local') }
}

/** A file that holds `{ mcpServers }`: `.mcp.json`, `managed-mcp.json`, Claude Desktop's config. */
export const fileServers = (json: unknown, scope: string): McpServer[] => (isObject(json) ? serversIn(json['mcpServers'], scope) : [])

/** The plugins installed (Claude Code's `installed_plugins.json`) and enabled (`enabledPlugins` in settings): name and folder. */
export function enabledPlugins(installed: unknown, enabled: unknown): { name: string; path: string }[] {
  if (!isObject(installed) || !isObject(installed['plugins']) || !isObject(enabled)) return []
  const out: { name: string; path: string }[] = []
  for (const [id, entries] of Object.entries(installed['plugins'])) {
    if (enabled[id] !== true || !Array.isArray(entries)) continue
    const name = id.split('@')[0] ?? id
    for (const entry of entries) {
      const path = isObject(entry) ? entry['installPath'] : undefined
      if (typeof path === 'string' && path !== '' && !out.some(p => p.path === path)) out.push({ name, path })
    }
  }
  return out
}

/** A plugin's servers, from its `.mcp.json` and its manifest's `mcpServers`, named as Claude Code names them: `plugin:<plugin>:<server>`. */
export function pluginServers(plugin: string, mcpJson: unknown, manifest: unknown): McpServer[] {
  const name = (key: string) => `plugin:${plugin}:${key}`
  const fromFile = isObject(mcpJson) ? serversIn(isObject(mcpJson['mcpServers']) ? mcpJson['mcpServers'] : mcpJson, 'plugin', name) : []
  const fromManifest = isObject(manifest) ? serversIn(manifest['mcpServers'], 'plugin', name) : []
  return [...fromFile, ...fromManifest]
}

/** A server's name as an MCP tool's name spells it (`mcp__<server>__<tool>`): what a call is matched to its server by. */
export const toolSpelling = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_')

/** The servers, one per name, the nearest setting first as Claude Code takes it; at most `MAX_SERVERS`. */
export function distinct(servers: readonly McpServer[]): McpServer[] {
  const seen = new Set<string>()
  const out: McpServer[] = []
  for (const s of servers) {
    if (seen.has(s.name) || out.length >= MAX_SERVERS) continue
    seen.add(s.name)
    out.push(s)
  }
  return out
}

/** The attributes of the plugin's row for one server. */
export function serverAttributes(s: McpServer): Record<string, string> {
  return {
    server_name: s.name,
    server_scope: s.scope,
    ...(s.transport !== undefined ? { transport_type: s.transport } : {}),
    ...(s.address !== undefined ? { server_url: s.address } : {}),
  }
}
