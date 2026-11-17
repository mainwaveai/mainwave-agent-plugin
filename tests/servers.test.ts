// The MCP servers read from Claude's settings files, called directly with the files' contents.

import { describe, expect, test } from 'claude-code/testing'

import {
  approvalsOf, approved, distinct, permitted, enabledPlugins, fileServers, foldersUp, globalServers, join, localAddress, managedDirs, manifestServerFiles, pluginServers, projectEntry, remoteAddress, serverOf, toolSpelling,
} from '../hooks/servers.ts'

describe('addresses', () => {
  test('a remote server keeps scheme, host, port and path; never a user name, password, query or fragment', () => {
    expect(remoteAddress('https://ana:hunter2@mcp.example.com:8443/v1/mcp?key=abc#top')).toBe('https://mcp.example.com:8443/v1/mcp')
    expect(remoteAddress('https://${MCP_HOST}/mcp')).toBe('https://${MCP_HOST}/mcp')
    expect(remoteAddress('not a url')).toBeUndefined()
    // A password with an `@` in it: all of it goes, to the last `@` before the path.
    expect(remoteAddress('https://ana:p@ss@mcp.example.com/mcp')).toBe('https://mcp.example.com/mcp')
    // One that ends the host early: its credentials can't be told from its host, so nothing past the scheme goes.
    expect(remoteAddress('https://ana:pa?ss@host.example.com/mcp')).toBe('https://[REDACTED:url_password]')
    expect(remoteAddress('https://ana:pa/ss@host.example.com/mcp')).toBe('https://[REDACTED:url_password]')
    expect(remoteAddress('https://ana:pa#ss@host.example.com/mcp')).toBe('https://[REDACTED:url_password]')
    // A port, and an IPv6 address, are a host's.
    expect(remoteAddress('http://[::1]:8080/mcp')).toBe('http://[::1]:8080/mcp')
    expect(remoteAddress('https://mcp.example.com:443/mcp?q=a@b')).toBe('https://mcp.example.com:443/mcp')
  })

  test('a value a flag names as a secret, a header or an environment variable is replaced, the flag kept', () => {
    expect(localAddress('npx', ['mcp-remote', 'https://x.example.com', '--api-key', 'sk_live_1', '--access-token', 'abc', '-H', 'X-Auth: abc', '-e', 'FOO=bar', '--verbose'])).toBe(
      'npx mcp-remote https://x.example.com --api-key [REDACTED:assigned_secret] --access-token [REDACTED:assigned_secret] -H [REDACTED:header_or_env] -e [REDACTED:header_or_env] --verbose',
    )
    expect(localAddress('server', ['--token'])).toBe('server --token')
    expect(localAddress('x', ['--authorization', 'Bearer abc', '--bearer', 'zzz', '--cookie', 'c=1', '--session-token', 's'])).toBe(
      'x --authorization [REDACTED:assigned_secret] --bearer [REDACTED:assigned_secret] --cookie [REDACTED:assigned_secret] --session-token [REDACTED:assigned_secret]',
    )
  })

  test('a local server is its command and arguments; its environment and headers are never read', () => {
    expect(serverOf('db', 'user', { command: 'npx', args: ['db-mcp', 3, '--ro'], env: { PASSWORD: 'x' } })).toEqual({ name: 'db', scope: 'user', transport: 'stdio', address: 'npx db-mcp --ro' })
    expect(serverOf('api', 'user', { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'Bearer x' } })).toEqual({ name: 'api', scope: 'user', transport: 'http', address: 'https://mcp.example.com' })
    expect(serverOf('', 'user', { command: 'x' })).toBeUndefined()
    expect(serverOf('x', 'user', 'npx')).toBeUndefined()
  })
})

describe('where they are kept', () => {
  test("Claude Code's global config: the user's servers, and the local ones of this project alone", () => {
    const json = { mcpServers: { a: { command: 'a' } }, projects: { '/p': { mcpServers: { b: { command: 'b' } } }, '/q': { mcpServers: { c: { command: 'c' } } } } }
    const g = globalServers(json, '/p')
    expect(g.user.map(s => s.name)).toEqual(['a'])
    expect(g.local.map(s => s.name)).toEqual(['b'])
    expect(globalServers('nope', '/p')).toEqual({ user: [], local: [] })
  })

  test("the managed folder of the session's OS alone, as an absolute path", () => {
    expect(managedDirs('/home/ana', undefined)).toEqual(['/Library/Application Support/ClaudeCode', '/etc/claude-code'])
    expect(managedDirs('/c/Users/ana', 'C:\\Users\\ana')).toEqual(['C:\\Program Files\\ClaudeCode'])
    expect(managedDirs(undefined, undefined)).toEqual([])
  })

  test("a project's servers load where approved and not refused; the project's entry is found under Windows paths too", () => {
    const json = { projects: { 'C:/Users/ana/api': { enabledMcpjsonServers: ['a'], disabledMcpjsonServers: ['b'] } } }
    const a = approvalsOf({ enabledMcpjsonServers: ['b', 'c'], deniedMcpServers: [{ serverName: 'x' }, { serverUrl: 'https://y' }] }, projectEntry(json, 'C:\\Users\\ana\\api'))
    expect(['a', 'b', 'c', 'd'].map(n => approved(a, n))).toEqual([true, false, true, false])
    expect([...a.denied]).toEqual(['x'])
    expect(approved(approvalsOf({ enableAllProjectMcpServers: true }, undefined), 'd')).toBe(true)
    // An organization's lists by name: denied goes nowhere; where it allows some by name, only those.
    expect(['x', 'y', 'z'].map(n => permitted(approvalsOf({ allowedMcpServers: [{ serverName: 'x' }, { serverName: 'y' }], deniedMcpServers: [{ serverName: 'y' }] }, undefined), n))).toEqual([true, false, false])
    expect(permitted(approvalsOf({ allowedMcpServers: [{ serverUrl: 'https://*' }] }, undefined), 'z')).toBe(true)
  })

  test('.mcp.json in the project root and each folder above it, nearest first, on any OS', () => {
    expect(foldersUp('/home/ana/api')).toEqual(['/home/ana/api', '/home/ana', '/home', '/'])
    expect(foldersUp('C:\\Users\\ana\\api')).toEqual(['C:\\Users\\ana\\api', 'C:\\Users\\ana', 'C:\\Users', 'C:\\'])
    expect(join('C:\\Users\\ana', '.claude.json')).toBe('C:\\Users\\ana\\.claude.json')
    expect(join('/home/ana/', '.claude', 'plugins')).toBe('/home/ana/.claude/plugins')
    expect(fileServers({ mcpServers: { d: { url: 'https://d.example.com' } } }, 'project')).toEqual([{ name: 'd', scope: 'project', transport: 'http', address: 'https://d.example.com' }])
  })

  test("a plugin's servers, only where it is enabled, named as Claude Code names them", () => {
    const installed = { version: 2, plugins: { 'tools@market': [{ installPath: '/c/plugins/tools' }], 'off@market': [{ installPath: '/c/plugins/off' }] } }
    expect(enabledPlugins(installed, { 'tools@market': true, 'off@market': false })).toEqual([{ name: 'tools', path: '/c/plugins/tools' }])
    expect(pluginServers('tools', { mcpServers: { db: { command: 'db' } } }, { mcpServers: { web: { url: 'https://w.example.com' } } }).map(s => [s.name, s.scope])).toEqual([
      ['plugin:tools:db', 'plugin'], ['plugin:tools:web', 'plugin'],
    ])
    // A manifest that names files for its servers: those files, read beside it; never one outside the plugin.
    expect(manifestServerFiles({ mcpServers: ['./a.json', '../b.json', 3] })).toEqual(['./a.json'])
    expect(pluginServers('tools', undefined, { mcpServers: './a.json' }, [{ mcpServers: { s: { command: 's' } } }]).map(s => s.name)).toEqual(['plugin:tools:s'])
  })

  test("one row per name, the nearest setting's; a name as a tool's name spells it", () => {
    expect(distinct([{ name: 'a', scope: 'local' }, { name: 'a', scope: 'user' }, { name: 'b', scope: 'user' }])).toEqual([{ name: 'a', scope: 'local' }, { name: 'b', scope: 'user' }])
    expect(toolSpelling('plugin:tools:db')).toBe('plugin_tools_db')
    expect(toolSpelling('claude.ai Gmail')).toBe('claude_ai_Gmail')
  })
})
