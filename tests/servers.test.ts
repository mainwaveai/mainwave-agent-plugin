// The MCP servers read from Claude's settings files, called directly with the files' contents.

import { describe, expect, test } from 'claude-code/testing'

import { distinct, enabledPlugins, fileServers, foldersUp, globalServers, join, pluginServers, remoteAddress, serverOf, toolSpelling } from '../hooks/servers.ts'

describe('addresses', () => {
  test('a remote server keeps scheme, host, port and path; never a user name, password, query or fragment', () => {
    expect(remoteAddress('https://ana:hunter2@mcp.example.com:8443/v1/mcp?key=abc#top')).toBe('https://mcp.example.com:8443/v1/mcp')
    expect(remoteAddress('https://${MCP_HOST}/mcp')).toBe('https://${MCP_HOST}/mcp')
    expect(remoteAddress('not a url')).toBeUndefined()
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
    // A manifest that names a file for its servers names no server itself.
    expect(pluginServers('tools', undefined, { mcpServers: './mcp.json' })).toEqual([])
  })

  test("one row per name, the nearest setting's; a name as a tool's name spells it", () => {
    expect(distinct([{ name: 'a', scope: 'local' }, { name: 'a', scope: 'user' }, { name: 'b', scope: 'user' }])).toEqual([{ name: 'a', scope: 'local' }, { name: 'b', scope: 'user' }])
    expect(toolSpelling('plugin:tools:db')).toBe('plugin_tools_db')
    expect(toolSpelling('claude.ai Gmail')).toBe('claude_ai_Gmail')
  })
})
