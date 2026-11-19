// What the plugin reads in its own hooks, for the rows Claude Code writes without it: a tool call's input (`tool.call`), a prompt's
// text (`prompt.submit`, `turn.start`), the text a model request streams (`turn.step`). Claude Code leaves these off its rows unless
// its own switches are on, and Cowork's export leaves them off always; the gate (gate.ts) decides whether they go. Pure: the hooks
// (register.ts) feed it, tests drive it.
//
// The shapes follow Claude Code's (version 2.1.322): `tool_parameters` as it builds it for a Bash command, an MCP call, a skill or a
// subagent; `tool_input` as its preview of a call's input.

import type { TelemetryAttribute } from 'claude-code'

import type { RowFill } from './gate.ts'
import { mcpParts, metricQuerySource } from './derive.ts'

/**
 * MCP tools that run a shell command on the person's computer, by server and tool: their commands count as Bash commands do.
 * Cowork's `device_bash` takes `{ command, description? }`, and answers a command that exits non-zero as an error.
 */
export const SHELL_TOOLS: readonly (readonly [string, string])[] = [['remote-devices', 'device_bash']]

/**
 * The account-memory MCP tools (`mcp__memory__memory_*`): Claude Code records their input and output only as their length, whatever
 * its switches say, and so does the plugin.
 */
export const isAccountMemoryTool = (name: string): boolean => name.startsWith('mcp__memory__memory_')

/** A value recorded only as its length, as Claude Code records an account-memory tool's. */
export const notRecorded = (text: string): string => `<${text.length} chars; not recorded>`

/** The command a call runs, for Bash and the MCP shell tools; undefined for any other call. */
export function shellCommand(name: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const command = input['command']
  if (typeof command !== 'string') return undefined
  if (name === 'Bash') return command
  const mcp = mcpParts(name)
  return mcp && SHELL_TOOLS.some(([s, t]) => s === mcp.server && t === mcp.tool) ? command : undefined
}

/**
 * `tool_parameters` as Claude Code builds it with tool details on: a Bash command's first word, whole text, timeout, description and
 * sandbox flag; an MCP call's server and tool; a skill's name; a subagent's type. An MCP shell tool's command is read as a Bash
 * command's, beside its server and tool.
 */
export function toolParameters(name: string, input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const command = shellCommand(name, input)
  if (command !== undefined) {
    out['bash_command'] = command.trim().split(/\s+/)[0] || ''
    out['full_command'] = command
    if (name === 'Bash') {
      if (input['timeout'] !== undefined) out['timeout'] = input['timeout']
      if (input['description'] !== undefined) out['description'] = input['description']
      if ('dangerouslyDisableSandbox' in input) out['dangerouslyDisableSandbox'] = input['dangerouslyDisableSandbox']
    }
  }
  const mcp = mcpParts(name)
  if (mcp) {
    out['mcp_server_name'] = mcp.server
    out['mcp_tool_name'] = mcp.tool
  }
  if (name === 'Skill' && typeof input['skill'] === 'string') out['skill_name'] = input['skill']
  if ((name === 'Agent' || name === 'Task') && typeof input['subagent_type'] === 'string') out['subagent_type'] = input['subagent_type']
  return out
}

const PREVIEW_STRING = 512
const PREVIEW_HEAD = 128
const PREVIEW_ITEMS = 20
const PREVIEW_DEPTH = 2
const PREVIEW_LENGTH = 4096

function previewValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > PREVIEW_STRING ? `${v.slice(0, PREVIEW_HEAD)}…[${v.length} chars]` : v
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) return v
  if (depth >= PREVIEW_DEPTH) return '<nested>'
  if (Array.isArray(v)) {
    const out = v.slice(0, PREVIEW_ITEMS).map(x => previewValue(x, depth + 1))
    if (v.length > PREVIEW_ITEMS) out.push(`…[${v.length} items]`)
    return out
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([k]) => !k.startsWith('_'))
    const out = entries.slice(0, PREVIEW_ITEMS).map(([k, x]) => [k, previewValue(x, depth + 1)] as const)
    if (entries.length > PREVIEW_ITEMS) out.push(['…', `${entries.length} keys`])
    return Object.fromEntries(out)
  }
  return String(v)
}

/** `tool_input` as Claude Code previews a call's input: long strings shortened, deep values elided, 4,096 characters at most. */
export function toolInputPreview(input: Readonly<Record<string, unknown>>): string {
  const text = JSON.stringify(previewValue(input, 0))
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…[truncated]` : text
}

// ── State ─────────────────────────────────────────────────────────────────────

const MAX_TOOLS = 500
const MAX_PROMPTS = 20

/** What the hooks read, kept until the rows that need it pass. One per load. */
export type Capture = {
  /** Each tool call's name and input, by its id, and the commit it made where its result row is built (`captureCommit`). */
  tools: Map<string, { name: string; input: Readonly<Record<string, unknown>>; commit?: { commitId: string; branch?: string } }>
  /** The prompts submitted lately, newest last. */
  prompts: string[]
  /** The text and thinking each loop's request is streaming: the main loop's as `main`, a subagent's by its id. */
  streams: Map<string, { text: string[]; thinking: string[] }>
}

export const newCapture = (): Capture => ({ tools: new Map(), prompts: [], streams: new Map() })

export const loopKey = (agentId: unknown): string => (typeof agentId === 'string' && agentId !== '' ? agentId : 'main')

/** A tool call began: its input is kept for its rows. */
export function captureTool(c: Capture, id: string | undefined, name: string, input: Readonly<Record<string, unknown>>): void {
  if (!id) return
  c.tools.delete(id)
  c.tools.set(id, { name, input })
  while (c.tools.size > MAX_TOOLS) c.tools.delete(c.tools.keys().next().value!)
}

/** A call made a commit: its result row's `tool_parameters` name it (`git_commit_id`) and its branch (`git_branch`), as Claude Code's do. */
export function captureCommit(c: Capture, id: string, commit: { commitId: string; branch?: string }): void {
  const tool = c.tools.get(id)
  if (tool) tool.commit = commit
}

/** A prompt was submitted, or a turn began with one. */
export function capturePrompt(c: Capture, text: unknown): void {
  if (typeof text !== 'string' || text === '' || c.prompts.at(-1) === text) return
  c.prompts.push(text)
  if (c.prompts.length > MAX_PROMPTS) c.prompts.shift()
}

/** A request began streaming in a loop: what the loop streamed before is let go. */
export function streamStart(c: Capture, agentId: unknown): void {
  c.streams.set(loopKey(agentId), { text: [], thinking: [] })
}

/** One piece of a request's stream: its text and thinking are kept, block by block. */
export function streamChunk(c: Capture, agentId: unknown, chunk: unknown): void {
  if (chunk === null || typeof chunk !== 'object') return
  const { kind, index, text } = chunk as { kind?: unknown; index?: unknown; text?: unknown }
  if ((kind !== 'text' && kind !== 'thinking') || typeof text !== 'string' || typeof index !== 'number' || index < 0 || index > 1000) return
  const s = c.streams.get(loopKey(agentId)) ?? { text: [], thinking: [] }
  c.streams.set(loopKey(agentId), s)
  const blocks = kind === 'text' ? s.text : s.thinking
  blocks[index] = (blocks[index] ?? '') + text
}

const joined = (blocks: readonly (string | undefined)[], sep: string) => blocks.filter((b): b is string => b !== undefined).join(sep)

/**
 * The text a loop's request streamed, its blocks joined as Claude Code joins a response's (a newline), for a response row the plugin
 * builds where none comes; undefined where it streamed none.
 */
export function streamedText(c: Capture, agentId: unknown): string | undefined {
  const s = c.streams.get(loopKey(agentId))
  const text = s ? joined(s.text, '\n') : ''
  return text === '' ? undefined : text
}

/** The text a loop's request answered with, in place of its streamed pieces: what a response row of its length is filled with. */
export function setStreamedText(c: Capture, agentId: unknown, text: string): void {
  const s = c.streams.get(loopKey(agentId)) ?? { text: [], thinking: [] }
  s.text = [text]
  c.streams.set(loopKey(agentId), s)
}

/** The text a loop's request streamed is let go, once a row has carried it: a row that comes later fills nothing from it. */
export function dropStreamedText(c: Capture, agentId: unknown): void {
  const s = c.streams.get(loopKey(agentId))
  if (s) s.text = []
}

/** The thinking a loop's request streamed, if any. */
export function streamedThinking(c: Capture, agentId: unknown): string | undefined {
  const s = c.streams.get(loopKey(agentId))
  const text = s ? joined(s.thinking, '\n') : ''
  return text === '' ? undefined : text
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

/**
 * What the plugin read for one of Claude Code's rows, where the row may lack it: a prompt row's text (the prompt of its length,
 * submitted lately), a response row's text (what its loop streamed, if of its length), a tool row's parameters and input preview.
 */
export function rowFill(c: Capture, event: string, attributes: Readonly<Record<string, TelemetryAttribute>>): RowFill {
  switch (event) {
    case 'user_prompt': {
      const length = num(attributes['prompt_length'])
      const i = c.prompts.findLastIndex(p => p.length === length)
      if (i < 0) return {}
      const [text] = c.prompts.splice(i, 1)
      return { attributes: { prompt: text!, prompt_text: text! } }
    }
    case 'assistant_response': {
      // Only a request of the main loop or a subagent's streams through a hook: another (a title, a memory operation) has nothing here.
      const source = metricQuerySource(attributes['query_source'])
      if (source !== undefined && source !== 'main' && source !== 'subagent') return {}
      const s = c.streams.get(loopKey(attributes['agent_id']))
      if (!s) return {}
      // Claude Code joins a response's text blocks with a newline.
      for (const text of [joined(s.text, '\n'), joined(s.text, ' '), joined(s.text, '')]) {
        if (text !== '' && text.length === num(attributes['response_length'])) return { attributes: { response: text } }
      }
      return {}
    }
    case 'tool_decision':
    case 'tool_result': {
      const id = attributes['tool_use_id']
      const tool = typeof id === 'string' ? c.tools.get(id) : undefined
      if (!tool) return {}
      const parameters = toolParameters(tool.name, tool.input)
      if (event !== 'tool_result') return { parameters }
      if (tool.commit !== undefined) {
        parameters['git_commit_id'] = tool.commit.commitId
        if (tool.commit.branch !== undefined) parameters['git_branch'] = tool.commit.branch
      }
      // The call's last row: its input is let go.
      c.tools.delete(id as string)
      return { parameters, attributes: { tool_input: isAccountMemoryTool(tool.name) ? notRecorded(JSON.stringify(tool.input)) : toolInputPreview(tool.input) } }
    }
    default:
      return {}
  }
}
