// The rules a rebuilt span's or metric's attributes follow, called directly.

import { describe, expect, test } from 'claude-code/testing'

import { bashClass, firstCommand, genAiProvider, gitCounts, languageOf, linesChanged, mcpCreatesPr, mcpParts, metricQuerySource, querySourceSafe, toolNameSafe } from '../hooks/derive.ts'

describe('genAiProvider', () => {
  test('providers as gen_ai names them', () => {
    expect(genAiProvider('firstParty')).toBe('anthropic')
    expect(genAiProvider('bedrock')).toBe('aws.bedrock')
    expect(genAiProvider('vertex')).toBe('gcp.vertex_ai')
    expect(genAiProvider('foundry')).toBe('anthropic')
    expect(genAiProvider('somewhere-new')).toBeUndefined()
    expect(genAiProvider(undefined)).toBeUndefined()
  })
})

describe('query sources', () => {
  test('as metrics count them', () => {
    expect(metricQuerySource('sdk')).toBe('main')
    expect(metricQuerySource('repl_main_thread')).toBe('main')
    expect(metricQuerySource('repl_main_thread:outputStyle:x')).toBe('main')
    expect(metricQuerySource('agent:builtin:general-purpose')).toBe('subagent')
    expect(metricQuerySource('hook_agent')).toBe('subagent')
    expect(metricQuerySource('generate_session_title')).toBe('auxiliary')
    expect(metricQuerySource(undefined)).toBeUndefined()
  })
  test('as spans carry them: custom agents folded, colons as dots, odd values left off', () => {
    expect(querySourceSafe('sdk')).toBe('sdk')
    expect(querySourceSafe('agent:builtin:general-purpose')).toBe('agent.builtin.general-purpose')
    expect(querySourceSafe('agent:custom:my-private-agent')).toBe('agent.custom')
    expect(querySourceSafe('has space')).toBeUndefined()
    expect(querySourceSafe('x'.repeat(65))).toBeUndefined()
  })
})

describe('tool names', () => {
  test('an MCP tool splits into server and tool', () => {
    expect(mcpParts('mcp__github__create_pull_request')).toEqual({ server: 'github', tool: 'create_pull_request' })
    expect(mcpParts('mcp__srv__a__b')).toEqual({ server: 'srv', tool: 'a__b' })
    expect(mcpParts('Bash')).toBeUndefined()
  })
  test('tool_name_safe keeps built-ins and Playwright browser tools, folds other MCP tools', () => {
    expect(toolNameSafe('Bash')).toBe('Bash')
    expect(toolNameSafe('mcp__github__create_issue')).toBe('mcp_other')
    expect(toolNameSafe('mcp__playwright__browser_click')).toBe('mcp__playwright__browser_click')
    expect(toolNameSafe('odd__name')).toBe('other')
  })
})

describe('bashClass', () => {
  test('the first program of a command, by class', () => {
    expect(bashClass('echo e2e')).toEqual({ bash_command_class: 'shell_builtin', bash_argv0: 'echo' })
    expect(bashClass('git status && npm test')).toEqual({ bash_command_class: 'vcs', bash_argv0: 'git' })
    expect(bashClass('FOO=1 BAR=2 npm run build')).toEqual({ bash_command_class: 'package_manager', bash_argv0: 'npm' })
    expect(bashClass('sudo -u root /usr/bin/python3 x.py')).toEqual({ bash_command_class: 'lang_runtime', bash_argv0: 'python' })
    expect(bashClass('timeout 5 curl https://example.com')).toEqual({ bash_command_class: 'network', bash_argv0: 'curl' })
    expect(bashClass('cat a | grep b')).toEqual({ bash_command_class: 'file_read', bash_argv0: 'cat' })
  })
  test('a program not listed is other; a command that does not read is unparsed', () => {
    expect(bashClass('./build.sh --fast')).toEqual({ bash_command_class: 'other', bash_argv0: 'other' })
    expect(bashClass('echo "unterminated')).toEqual({ bash_command_class: 'unparsed', bash_argv0: 'other' })
  })
  test('separators inside quotes do not end the first command', () => {
    expect(firstCommand('echo "a; b" ; ls')).toBe('echo "a; b" ')
    expect(firstCommand("echo 'x|y'")).toBe("echo 'x|y'")
  })
})

describe('gitCounts', () => {
  test('a commit, through any -c options', () => {
    expect(gitCounts('git commit -m x')).toEqual({ commits: 1, pullRequests: 0 })
    expect(gitCounts('git -c user.name=a -c user.email=a@example.com commit -q -m x')).toEqual({ commits: 1, pullRequests: 0 })
    expect(gitCounts('git status')).toEqual({ commits: 0, pullRequests: 0 })
  })
  test('a pull request: gh, glab, curl or gh api', () => {
    expect(gitCounts('gh pr create --fill')).toEqual({ commits: 0, pullRequests: 1 })
    expect(gitCounts('glab mr create')).toEqual({ commits: 0, pullRequests: 1 })
    expect(gitCounts('git push && gh pr create')).toEqual({ commits: 0, pullRequests: 1 })
    expect(gitCounts('curl -X POST https://api.example.com/repos/o/r/pulls -d @body.json')).toEqual({ commits: 0, pullRequests: 1 })
    expect(gitCounts('gh api repos/o/r/pulls -f title=x')).toEqual({ commits: 0, pullRequests: 1 })
    expect(gitCounts('gh api repos/o/r/pulls')).toEqual({ commits: 0, pullRequests: 0 })
    expect(gitCounts('gh pr view 12')).toEqual({ commits: 0, pullRequests: 0 })
  })
  test('an MCP tool named for creating one', () => {
    expect(mcpCreatesPr('create_pull_request')).toBe(true)
    expect(mcpCreatesPr('merge_request_create')).toBe(true)
    expect(mcpCreatesPr('list_pull_requests')).toBe(false)
  })
})

describe('linesChanged', () => {
  test('a file written whole counts every line of its content', () => {
    expect(linesChanged({ type: 'create', content: 'one\ntwo\n', structuredPatch: [], originalFile: null })).toEqual({ added: 3, removed: 0 })
  })
  test("a patch counts its + and - lines", () => {
    const structuredPatch = [{ lines: [' one', '-two', '+three', '+four'] }, { lines: ['-x'] }]
    expect(linesChanged({ structuredPatch })).toEqual({ added: 2, removed: 2 })
  })
  test("a result that is not a file edit's counts nothing", () => {
    expect(linesChanged({ stdout: 'x' })).toBeUndefined()
    expect(linesChanged(undefined)).toBeUndefined()
  })
})

describe('languageOf', () => {
  test('by extension, as Claude Code names them', () => {
    expect(languageOf('/w/a.txt')).toBe('Plain text')
    expect(languageOf('/w/a.ts')).toBe('TypeScript')
    expect(languageOf('/w/A.PY')).toBe('Python')
    expect(languageOf('/w/Makefile')).toBe('unknown')
    expect(languageOf('/w/a.unknownext')).toBe('unknown')
    expect(languageOf(undefined)).toBe('unknown')
  })
})
