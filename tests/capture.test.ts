// What the plugin reads in its own hooks for Claude Code's rows, called directly. The shapes are Claude Code 2.1.322's.

import { describe, expect, test } from 'claude-code/testing'

import { capturePrompt, captureTool, newCapture, rowFill, shellCommand, streamChunk, streamedThinking, streamStart, toolInputPreview, toolParameters } from '../hooks/capture.ts'

describe('toolParameters', () => {
  test("a Bash command as Claude Code builds it: first word, whole text, then timeout, description and sandbox flag", () => {
    expect(toolParameters('Bash', { command: '  git commit -m x', timeout: 5000, description: 'Commit', dangerouslyDisableSandbox: false })).toEqual({
      bash_command: 'git', full_command: '  git commit -m x', timeout: 5000, description: 'Commit', dangerouslyDisableSandbox: false,
    })
  })

  test("Cowork's device_bash: its command read as a Bash command's, beside its server and tool", () => {
    expect(toolParameters('mcp__remote-devices__device_bash', { command: 'git push', description: 'Push' })).toEqual({
      bash_command: 'git', full_command: 'git push', mcp_server_name: 'remote-devices', mcp_tool_name: 'device_bash',
    })
    expect(shellCommand('mcp__remote-devices__device_bash', { command: 'ls' })).toBe('ls')
    expect(shellCommand('mcp__other__device_bash', { command: 'ls' })).toBeUndefined()
  })

  test('a skill, a subagent, an MCP call; nothing for a file tool', () => {
    expect(toolParameters('Skill', { skill: 'pdf' })).toEqual({ skill_name: 'pdf' })
    expect(toolParameters('Agent', { subagent_type: 'Explore', prompt: 'x' })).toEqual({ subagent_type: 'Explore' })
    expect(toolParameters('mcp__github__create_issue', { title: 'x' })).toEqual({ mcp_server_name: 'github', mcp_tool_name: 'create_issue' })
    expect(toolParameters('Read', { file_path: '/a' })).toEqual({})
  })
})

describe('toolInputPreview', () => {
  test("Claude Code's preview: long strings shortened, deep values elided, private keys left out", () => {
    expect(toolInputPreview({ command: 'echo hi', description: 'x' })).toBe('{"command":"echo hi","description":"x"}')
    expect(JSON.parse(toolInputPreview({ content: 'a'.repeat(600) })).content).toBe(`${'a'.repeat(128)}…[600 chars]`)
    expect(JSON.parse(toolInputPreview({ a: { b: { c: 1 } }, _hidden: 1 }))).toEqual({ a: { b: '<nested>' } })
    expect(toolInputPreview({ text: 'x'.repeat(500), more: 'y'.repeat(500), b: 'z'.repeat(500), c: 'w'.repeat(500), d: 'v'.repeat(500), e: 'u'.repeat(500), f: 't'.repeat(500), g: 's'.repeat(500), h: 'r'.repeat(500) }).endsWith('…[truncated]')).toBe(true)
  })
})

describe('rowFill', () => {
  test("a prompt row takes the prompt of its length submitted lately, once", () => {
    const c = newCapture()
    capturePrompt(c, 'first')
    capturePrompt(c, 'go')
    expect(rowFill(c, 'user_prompt', { prompt: '<REDACTED>', prompt_length: '2' })).toEqual({ attributes: { prompt: 'go', prompt_text: 'go' } })
    expect(rowFill(c, 'user_prompt', { prompt: '<REDACTED>', prompt_length: '2' })).toEqual({})
  })

  test("a response row takes what its loop streamed, when the lengths agree", () => {
    const c = newCapture()
    streamStart(c, undefined)
    streamChunk(c, undefined, { kind: 'thinking', index: 0, text: 'hmm' })
    streamChunk(c, undefined, { kind: 'text', index: 1, text: 'Fixed' })
    streamChunk(c, undefined, { kind: 'text', index: 1, text: ' it.' })
    expect(rowFill(c, 'assistant_response', { response: '<REDACTED>', response_length: 9 })).toEqual({ attributes: { response: 'Fixed it.' } })
    expect(rowFill(c, 'assistant_response', { response: '<REDACTED>', response_length: 3 })).toEqual({})
    expect(rowFill(c, 'assistant_response', { response: '<REDACTED>', response_length: 9, agent_id: 'a1' })).toEqual({})
    // A request outside the main loop and its subagents (a title, a memory operation) streamed nothing a hook saw.
    expect(rowFill(c, 'assistant_response', { response: '<REDACTED>', response_length: 9, query_source: 'extract_memories' })).toEqual({})
    expect(rowFill(c, 'assistant_response', { response: '<REDACTED>', response_length: 9, query_source: 'repl_main_thread' })).toEqual({ attributes: { response: 'Fixed it.' } })
    expect(streamedThinking(c, undefined)).toBe('hmm')
  })

  test("a tool row takes the call's parameters, and its result row the input's preview", () => {
    const c = newCapture()
    captureTool(c, 'toolu_1', 'mcp__remote-devices__device_bash', { command: 'git push' })
    expect(rowFill(c, 'tool_decision', { tool_use_id: 'toolu_1' })).toEqual({ parameters: { bash_command: 'git', full_command: 'git push', mcp_server_name: 'remote-devices', mcp_tool_name: 'device_bash' } })
    expect(rowFill(c, 'tool_result', { tool_use_id: 'toolu_1' }).attributes).toEqual({ tool_input: '{"command":"git push"}' })
    expect(rowFill(c, 'tool_result', { tool_use_id: 'toolu_2' })).toEqual({})
    // Its result row was its last: the input is let go.
    expect(c.tools.has('toolu_1')).toBe(false)
  })

  test("an account-memory tool's input is recorded as its length alone, as Claude Code records it", () => {
    const c = newCapture()
    captureTool(c, 'toolu_1', 'mcp__memory__memory_write', { text: 'my dentist is Dr. Example' })
    expect(rowFill(c, 'tool_result', { tool_use_id: 'toolu_1' }).attributes).toEqual({ tool_input: '<36 chars; not recorded>' })
  })
})
