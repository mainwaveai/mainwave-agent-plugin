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
// Only each server's name, transport and address are read, and the lists that say which project servers are approved or denied:
// never its headers, environment or anything else in these files. A remote server's address keeps scheme, host, port and path, and
// drops any user name, password, query and fragment (a token in the path stays, as the spec keeps the path); a local server's is its
// command and arguments, the value after a flag that names a secret, a header or an environment variable replaced here, and the
// always-on protections then scrub the rest of secrets.
//
// A project server goes only where Claude Code would load it: approved (`enableAllProjectMcpServers`, `enabledMcpjsonServers`) and
// not refused (`disabledMcpjsonServers`), as the settings or the project's entry in the global config say. A server whose name an
// organization's `deniedMcpServers` lists goes nowhere.

/** One MCP server set up for the session. */
export type McpServer = { name: string; scope: string; transport?: string; address?: string }

/** The managed settings folders, as Claude Code names them: macOS and Linux (each needs an administrator to create), and Windows. */
export const MANAGED_DIRS_POSIX = ['/Library/Application Support/ClaudeCode', '/etc/claude-code'] as const
export const MANAGED_DIR_WINDOWS = 'C:\\Program Files\\ClaudeCode'

/** Whether a home folder is a Windows one (`C:\\Users\\ana`): only that OS's managed folder is read, never another's. */
export const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path)

/**
 * The managed folders to read on the OS the environment says (`USERPROFILE` is Windows'): absolute paths of that OS alone, so a
 * file a repository names like another OS's path is never read as one.
 */
export function managedDirs(home: string | undefined, profile: string | undefined): readonly string[] {
  if ((profile !== undefined && isWindowsPath(profile)) || (home !== undefined && isWindowsPath(home))) return [MANAGED_DIR_WINDOWS]
  return home !== undefined && home.startsWith('/') ? MANAGED_DIRS_POSIX : []
}

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

/** A remote server's address: scheme, host, port and path, without a user name, password (to the last `@`), query or fragment. */
export function remoteAddress(raw: string): string | undefined {
  const m = /^([a-z][a-z0-9+.-]{0,31}:\/\/)([^/?#]{0,4096})([^?#]{0,4096})/i.exec(raw.trim())
  if (!m) return undefined
  const at = m[2]!.lastIndexOf('@')
  return `${m[1]}${at < 0 ? m[2] : m[2]!.slice(at + 1)}${m[3]}`
}

/** A flag whose next argument is a secret, a header or an environment variable: `--api-key x`, `-H "X-Auth: x"`, `-e TOKEN=x`. */
const SECRET_FLAG = /^--?[A-Za-z0-9_.-]{0,64}(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|key)$/i
const VALUE_FLAG = /^(?:-H|--header|-e|--env)$/

/** A local server's command and arguments, each value a flag names as secret, a header or an environment variable replaced. */
export function localAddress(command: string, args: readonly string[]): string {
  const out = [command]
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    out.push(arg)
    if ((SECRET_FLAG.test(arg) || VALUE_FLAG.test(arg)) && i + 1 < args.length) {
      out.push(VALUE_FLAG.test(arg) ? '[REDACTED:header_or_env]' : '[REDACTED:assigned_secret]')
      i += 1
    }
  }
  return out.join(' ')
}

/** One server's entry as a config file holds it, read for its transport and address alone. */
export function serverOf(name: string, scope: string, config: unknown): McpServer | undefined {
  if (name === '' || !isObject(config)) return undefined
  const url = typeof config['url'] === 'string' ? config['url'] : undefined
  const command = typeof config['command'] === 'string' ? config['command'] : undefined
  const type = typeof config['type'] === 'string' ? config['type'] : url !== undefined ? 'http' : command !== undefined ? 'stdio' : undefined
  const args = Array.isArray(config['args']) ? config['args'].filter((a): a is string => typeof a === 'string') : []
  const address = url !== undefined ? remoteAddress(url) : command !== undefined ? localAddress(command, args) : undefined
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

/** The project's entry in Claude Code's global config, keyed by its folder as Claude Code writes it (forward slashes on Windows too). */
export function projectEntry(json: unknown, root: string | undefined): Record<string, unknown> | undefined {
  if (!isObject(json) || root === undefined || !isObject(json['projects'])) return undefined
  const projects = json['projects']
  for (const key of [root, root.replace(/\\/g, '/')]) if (isObject(projects[key])) return projects[key] as Record<string, unknown>
  return undefined
}

/** Claude Code's global config: the user's servers, and the local ones of the project at `root`. */
export function globalServers(json: unknown, root: string | undefined): { user: McpServer[]; local: McpServer[] } {
  if (!isObject(json)) return { user: [], local: [] }
  return { user: serversIn(json['mcpServers'], 'user'), local: serversIn(projectEntry(json, root)?.['mcpServers'], 'local') }
}

/** Which of a project's `.mcp.json` servers load, as the settings and the project's entry in the global config say. */
export type Approvals = { all: boolean; enabled: ReadonlySet<string>; disabled: ReadonlySet<string>; denied: ReadonlySet<string> }

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** The approvals from the merged settings and the project's entry; `deniedMcpServers` by server name. */
export function approvalsOf(settings: unknown, project: Record<string, unknown> | undefined): Approvals {
  const s = isObject(settings) ? settings : {}
  const p = project ?? {}
  const denied = Array.isArray(s['deniedMcpServers']) ? s['deniedMcpServers'].flatMap(d => (isObject(d) && typeof d['serverName'] === 'string' ? [d['serverName']] : [])) : []
  return {
    all: s['enableAllProjectMcpServers'] === true || p['enableAllProjectMcpServers'] === true,
    enabled: new Set([...names(s['enabledMcpjsonServers']), ...names(p['enabledMcpjsonServers'])]),
    disabled: new Set([...names(s['disabledMcpjsonServers']), ...names(p['disabledMcpjsonServers'])]),
    denied: new Set(denied),
  }
}

/** A project server Claude Code would load: approved, and not refused. */
export const approved = (a: Approvals, name: string): boolean => !a.disabled.has(name) && (a.all || a.enabled.has(name))

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

/** The files a plugin's manifest names for its servers (`mcpServers` as a path, or a list of paths), relative to the plugin. */
export function manifestServerFiles(manifest: unknown): string[] {
  const v = isObject(manifest) ? manifest['mcpServers'] : undefined
  const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : []
  return list.filter((x): x is string => typeof x === 'string' && x !== '' && !x.split(/[\\/]/).includes('..')).slice(0, 8)
}

/**
 * A plugin's servers, from its `.mcp.json`, its manifest's `mcpServers` (written inline, or in the files it names, read in `files`),
 * named as Claude Code names them: `plugin:<plugin>:<server>`.
 */
export function pluginServers(plugin: string, mcpJson: unknown, manifest: unknown, files: readonly unknown[] = []): McpServer[] {
  const name = (key: string) => `plugin:${plugin}:${key}`
  const fromFile = (json: unknown) => (isObject(json) ? serversIn(isObject(json['mcpServers']) ? json['mcpServers'] : json, 'plugin', name) : [])
  const inline = isObject(manifest) ? manifest['mcpServers'] : undefined
  const fromList = Array.isArray(inline) ? inline.flatMap(x => fromFile(x)) : []
  return [...fromFile(mcpJson), ...serversIn(inline, 'plugin', name), ...fromList, ...files.flatMap(fromFile)]
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
