// The rows Claude Code would have handed the plugin, built from its own events where none reach it. Pure: the hooks (register.ts) call
// it, tests drive it.
//
// Since 2.1.328, in Team and Enterprise organizations and on machines with managed settings, Claude Code seats a built-in plugin
// first that sends every collector row, and every classic hook, on past the plugins installed in the `user` tier, which an org-synced
// plugin is (README, rows_skipped). The plugin then sees no row: nothing says who the session is, and nothing carries a request's
// tokens or a call's outcome. Its other hooks still run: each turn's start and end, each model request's model, effort, usage and stop
// reason (`turn.step`), each tool call and what it answered (`tool.call`), and the session's cost so far (`$.session.usage()`).
//
// From those, the plugin builds the four rows Mainwave reads a session from, under Claude Code's names, attributes and value types:
//
//   user_prompt     a main-loop turn began: its prompt's length (the text itself is the gate's to add, as for Claude Code's row)
//   api_request     a model request answered: its model, tokens, effort, duration, time to first token and cost
//   tool_decision   a tool call settled: refused (its permission check refused it, or asked and the call then ended in an error) or
//                   accepted, at the time the call began
//   tool_result     a tool call that was not refused ended: its outcome and duration
//
// They go through the rebuild and the copy as Claude Code's rows do, so the spans and metrics are built from them, and they carry
// `mainwave.telemetry.built_from` (`events`), so Mainwave can tell them from the copies of Claude Code's rows. Their identity is the
// session's as Claude Code reads it: the host's variables (`CLAUDE_CODE_ORGANIZATION_UUID`, `CLAUDE_CODE_USER_EMAIL`,
// `CLAUDE_CODE_ACCOUNT_UUID`), which Claude Code reads before its account file, else the account file (setup.ts).

import type { TelemetryAttribute } from 'claude-code'

import { identityOf } from './identity.ts'
import type { RowIn } from './rebuild.ts'

type Attrs = Record<string, TelemetryAttribute>

/** The variables a host sets to say who the session is, which Claude Code reads before its account file. */
export type HostIdentityEnv = {
  CLAUDE_CODE_ORGANIZATION_UUID?: string | undefined
  CLAUDE_CODE_USER_EMAIL?: string | undefined
  CLAUDE_CODE_ACCOUNT_UUID?: string | undefined
}

/**
 * Who the session is, as its host says (remote Cowork sets these): the organization, the email and the account, under the attributes
 * Claude Code's rows name them by, each where it fits its shape. Empty unless both the organization and the email fit.
 */
export function hostIdentityOf(env: HostIdentityEnv): Record<string, string> {
  const seen = identityOf({
    'organization.id': env.CLAUDE_CODE_ORGANIZATION_UUID?.trim(),
    'user.email': env.CLAUDE_CODE_USER_EMAIL?.trim(),
    'user.account_uuid': env.CLAUDE_CODE_ACCOUNT_UUID?.trim(),
  })
  if (seen.organizationId === undefined || seen.email === undefined) return {}
  return {
    'organization.id': seen.organizationId,
    'user.email': seen.email,
    ...(seen.accountUuid !== undefined ? { 'user.account_uuid': seen.accountUuid } : {}),
  }
}

/**
 * Who the session is where no row says: the host's identity where it names the organization and the email, else the account file's.
 * The account file's device ID goes with either: Claude Code keeps one per installation.
 */
export function sessionIdentityOf(host: Readonly<Record<string, string>>, file: Readonly<Record<string, string>>): Record<string, string> {
  if (host['organization.id'] === undefined) return { ...file }
  const device = file['user.id']
  return { ...(device !== undefined ? { 'user.id': device } : {}), ...host }
}

/**
 * The attributes Claude Code puts first on each of its rows, in its order: the organization's resource attributes
 * (`OTEL_RESOURCE_ATTRIBUTES`), then the device, the session and who it is. The rebuild reads them as the session's common
 * attributes, as it reads a row's.
 */
export function rowHead(resource: Readonly<Record<string, string>>, identity: Readonly<Record<string, string>>, sessionId: string | undefined): Attrs {
  const out: Attrs = { ...resource }
  const put = (key: string, value: string | undefined) => {
    if (value === undefined) return
    delete out[key]
    out[key] = value
  }
  put('user.id', identity['user.id'])
  put('session.id', sessionId)
  put('organization.id', identity['organization.id'])
  put('user.email', identity['user.email'])
  put('user.account_uuid', identity['user.account_uuid'])
  return out
}

/** The state the rows are built with, one per load: their sequence, the turn's prompt id, and the session's cost at the last request. */
export type Rowless = { sequence: number; promptId?: string; costUsd?: number }

export const newRowless = (): Rowless => ({ sequence: 0 })

/** A random version 4 UUID, from 32 random hex digits: the shape of Claude Code's `prompt.id`. */
export function uuidOf(hex32: string): string {
  const h = hex32.padEnd(32, '0').slice(0, 32).split('')
  h[12] = '4'
  h[16] = '89ab'[Number.parseInt(h[16]!, 16) & 3]!
  const s = h.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

function row(state: Rowless, head: Attrs, event: string, atMs: number, attributes: readonly (readonly [string, TelemetryAttribute | undefined])[]): RowIn {
  const out: Attrs = { ...head, 'event.name': event, 'event.timestamp': new Date(atMs).toISOString(), 'event.sequence': state.sequence++ }
  if (state.promptId !== undefined) out['prompt.id'] = state.promptId
  for (const [k, v] of attributes) if (v !== undefined) out[k] = v
  return { event, atMs, attributes: out }
}

/** A main-loop turn began with `text`: a new prompt id, and its `user_prompt` row. */
export function promptRow(state: Rowless, head: Attrs, text: string, atMs: number, promptId: string): RowIn {
  state.promptId = promptId
  // Claude Code logs the length as a string, and the text only where prompts are logged: the gate adds it where it allows.
  return row(state, head, 'user_prompt', atMs, [['prompt_length', String(text.length)]])
}

/** What one answered model request says, as `turn.step` and the plugin's clock saw it. */
export type RequestFacts = {
  model: string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
    model?: string
  }
  effort?: string | number
  agentId?: string
  startMs: number
  endMs: number
  firstChunkMs?: number
  /** The session's cost after the request, as `$.session.usage()` reads it; undefined where it could not be read. */
  sessionCostUsd?: number
  /** Whether the session is a print or SDK session: its main loop's requests' `query_source` is `sdk` there. */
  sdk: boolean
}

const whole = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined)

/**
 * The cost of the request that just ended: what the session's cost grew by since the last request ended. Requests that end together
 * (subagents) may trade a share of their cost, but never add to or lose any of the session's. Undefined where the cost could not be
 * read, or where it went down (a /clear starts it over).
 */
export function costOf(state: Rowless, sessionCostUsd: number | undefined): number | undefined {
  if (sessionCostUsd === undefined || !Number.isFinite(sessionCostUsd) || sessionCostUsd < 0) return undefined
  const before = state.costUsd ?? 0
  state.costUsd = sessionCostUsd
  if (sessionCostUsd < before) return undefined
  return Math.round((sessionCostUsd - before) * 1e10) / 1e10
}

/** A model request answered: its `api_request` row, under Claude Code's attribute names and types. */
export function requestRow(state: Rowless, head: Attrs, f: RequestFacts): RowIn {
  const u = f.usage
  const cost = costOf(state, f.sessionCostUsd)
  const effort = typeof f.effort === 'string' ? f.effort : undefined
  return row(state, head, 'api_request', f.endMs, [
    ['model', u.model ?? f.model],
    ['input_tokens', whole(u.input_tokens) ?? 0],
    ['output_tokens', whole(u.output_tokens) ?? 0],
    ['cache_read_tokens', whole(u.cache_read_input_tokens) ?? 0],
    ['cache_creation_tokens', whole(u.cache_creation_input_tokens) ?? 0],
    ['cache_creation_5m_tokens', whole(u.ephemeral_5m_input_tokens)],
    ['cache_creation_1h_tokens', whole(u.ephemeral_1h_input_tokens)],
    ['cost_usd', cost],
    ['cost_usd_micros', cost === undefined ? undefined : Math.round(cost * 1e6)],
    ['duration_ms', Math.max(0, Math.round(f.endMs - f.startMs))],
    ['ttft_ms', f.firstChunkMs === undefined ? undefined : Math.max(0, Math.round(f.firstChunkMs - f.startMs))],
    // Claude Code names a subagent's requests by the agent's type, which `turn.step` does not say: `agent:custom` reads as a subagent's.
    ['query_source', f.agentId !== undefined ? 'agent:custom' : f.sdk ? 'sdk' : 'repl_main_thread'],
    ['effort', effort],
    ['agent_id', f.agentId],
  ])
}

/**
 * A tool call's permission decision: its `tool_decision` row, as the call began. Built once the call settles, as only its result says
 * whether it was refused; what decided (a rule, a hook, the person) no event a plugin may hook says.
 */
export function decisionRow(state: Rowless, head: Attrs, call: { tool: string; id: string; agentId?: string; refused: boolean }, atMs: number): RowIn {
  return row(state, head, 'tool_decision', atMs, [
    ['decision', call.refused ? 'reject' : 'accept'],
    ['tool_name', call.tool],
    ['tool_use_id', call.id],
    ['agent_id', call.agentId],
  ])
}

/** A tool call ended: its `tool_result` row, its outcome and duration as strings, as Claude Code logs them. */
export function resultRow(state: Rowless, head: Attrs, call: { tool: string; id: string; agentId?: string; startMs: number; endMs: number; isError: boolean }): RowIn {
  return row(state, head, 'tool_result', call.endMs, [
    ['tool_name', call.tool],
    ['tool_use_id', call.id],
    ['success', call.isError ? 'false' : 'true'],
    ['duration_ms', String(Math.max(0, Math.round(call.endMs - call.startMs)))],
    ['agent_id', call.agentId],
  ])
}
