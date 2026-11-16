// Claude Code's spans and the measures behind its metrics, rebuilt from what a plugin sees. Spans and metrics never pass through a
// plugin (the only telemetry hook carries log rows), so the plugin puts them back together from the rows it does see and from the
// engine's own events: turns, model requests, tool calls, subagent spawns. Pure: the hooks (register.ts) feed it, tests drive it.
//
// What Claude Code's exporter sends, and where each part comes from here (Claude Code 2.1.322, with CLAUDE_CODE_ENHANCED_TELEMETRY_BETA):
//
//   claude_code.interaction               one per main-loop turn, and one per slash command that asks no model. Its trace and span
//                                         ids are the `user_prompt` row's; a turn's end is its `turn.complete`, its start that less
//                                         the turn's duration; a command's spans its `command.run`.
//   ├─ claude_code.llm_request            one per model request: the `api_request` (or `api_error`) row, paired with its `turn.step`
//   │                                     for the stop reason and the start. Its parent is the row's span; its own id no row carries,
//   │                                     so it is new.
//   └─ claude_code.tool                   one per tool call, from `tool.call`. Its parent is its `tool_result` row's span; its own id
//      │                                  no row carries, so it is new.
//      ├─ claude_code.tool.blocked_on_user   the permission decision: the `tool_decision` row's own span, ids and all.
//      └─ claude_code.tool.execution         the run. Its id is new, except for an Agent call, whose subagent's rows name it.
//
// Every span and measure starts with the attributes Claude Code puts first on each of its records (the session's identity, the
// organization's resource attributes, the repository): the attributes of the latest row, up to its `event.name`.
//
// Nothing here waits or throws on purpose: a record it cannot pair is sent with what it has, after a short wait (`sweep`).

import type { TelemetryAttribute } from 'claude-code'

import { bashClass, CODE_EDIT_TOOLS, genAiProvider, gitCounts, languageOf, linesChanged, mcpCreatesPr, mcpParts, metricQuerySource, querySourceSafe, toolNameSafe } from './derive.ts'
import type { Measure } from './meter.ts'
import type { BuiltSpan } from './otlp.ts'
import { stripOwned } from './stamps.ts'

type Attrs = Record<string, TelemetryAttribute>
type Ctx = { traceId: string; spanId: string }

/** A collector row as the rebuild reads it: its event, when it was logged, its span, its attributes as Claude Code raised them. */
export type RowIn = { event: string; atMs: number; span?: Ctx; attributes: Readonly<Record<string, TelemetryAttribute>> }

/** What the session's environment says about the exporter, read once per load. */
export type Settings = {
  /** `OTEL_LOG_TOOL_DETAILS`: a tool span carries the file path, the command, the skill or the agent type. */
  toolDetails: boolean
  /** `TRACEPARENT`, when set: the trace an SDK host started, which the first interaction joins. */
  traceparent?: Ctx
  /** The longest string an attribute keeps (`OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT`, else `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`). */
  valueLengthLimit?: number
}

/** What one event produced: finished spans, and additions to counters. */
export type Emit = { spans: BuiltSpan[]; measures: Measure[] }

type Prompt = { ctx?: Ctx; text: TelemetryAttribute; length: number }
type Interaction = { turnId: string; sequence: number; prompt?: Prompt; ctx?: Ctx; text: string }
/** A slash command that runs without a model turn (`/plugins`, `/cost`): an interaction of its own, as Claude Code counts it. */
type Command = { sequence: number; startMs: number; endMs?: number; prompt?: Prompt; promptAtMs?: number }
type Step = { loop: string; startMs: number; endMs: number; stopReason: string | null; usage: StepUsage | null }
type StepUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
type Waiting = { row: RowIn; heldAtMs: number }
type Tool = {
  id: string
  name: string
  input: Readonly<Record<string, unknown>>
  agentId?: string
  startMs: number
  spanId: string
  endMs?: number
  isError?: boolean
  decision?: { ctx?: Ctx; decision: string; source?: string; atMs: number }
  result?: { ctx?: Ctx; success?: boolean; error?: TelemetryAttribute; atMs: number }
  spawned?: string
  /** The tool span and its children are sent; an Agent call's execution may wait for its subagent to name it. */
  sent: boolean
  execWaits: boolean
  endedAtMs?: number
}

/** The rebuild's state, one per load of the module. */
export type Rebuild = {
  settings: Settings
  /** The attributes Claude Code puts first on every record, from the latest row. */
  common: Attrs
  sequence: number
  interaction?: Interaction
  /** The slash command running or just run, until its interaction is sent or a model turn takes it over. */
  command?: Command
  /** A `user_prompt` row seen before its turn began. */
  heldPrompt?: Prompt
  interactionIds: Set<string>
  /** The span ids the rows named that are not an Agent call's execution: interactions and permission decisions. */
  knownIds: Set<string>
  loopModel: Map<string, string>
  steps: Step[]
  waiting: Waiting[]
  tools: Map<string, Tool>
  /** A subagent's id, by the Agent call that started it, and the agent that started each subagent. */
  agentTool: Map<string, string>
  parentAgent: Map<string, string>
  /** The span id of the Agent call's execution, as its subagent's rows name it. */
  execOfAgent: Map<string, string>
  /** When the session started, while its count waits for the first row to name the session. */
  sessionCountAt?: number
  /** New span and trace ids: random hex of the given length. */
  mint: (hexLength: 16 | 32) => string
}

/** How long a record waits for its pair before it is sent with what it has. */
export const PAIR_WAIT_MS = 2_000
/** How long a request's step result waits for its row before it is forgotten. */
export const STEP_KEEP_MS = 30_000
/** A tool call that never ended is forgotten after this long. */
const TOOL_KEEP_MS = 3_600_000
/** At most this many records wait at once; past it the oldest go on unpaired. */
const MAX_WAITING = 500

export function randomHex(hexLength: 16 | 32): string {
  const bytes = new Uint8Array(hexLength / 2)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  // An all-zero id is invalid in OTLP; one in 2^64 is not worth a loop.
  return /^0+$/.test(out) ? `${out.slice(0, -1)}1` : out
}

export function newRebuild(settings: Settings, mint: Rebuild['mint'] = randomHex): Rebuild {
  return {
    settings, common: {}, sequence: 0, interactionIds: new Set(), knownIds: new Set(), loopModel: new Map(),
    steps: [], waiting: [], tools: new Map(), agentTool: new Map(), parentAgent: new Map(), execOfAgent: new Map(), mint,
  }
}

const none = (): Emit => ({ spans: [], measures: [] })
const merge = (a: Emit, b: Emit): Emit => ({ spans: [...a.spans, ...b.spans], measures: [...a.measures, ...b.measures] })
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}
const truthy = (v: unknown) => v === true || v === 'true'
const HEX32 = /^[0-9a-f]{32}$/
const HEX16 = /^[0-9a-f]{16}$/
const validCtx = (c: Ctx | undefined): Ctx | undefined => (c && HEX32.test(c.traceId) && HEX16.test(c.spanId) ? { traceId: c.traceId, spanId: c.spanId } : undefined)

/** A W3C `traceparent` header's trace and span ids, or undefined when it has not the shape. */
export function parseTraceparent(raw: unknown): Ctx | undefined {
  const m = typeof raw === 'string' ? /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(raw.trim()) : null
  return m && !/^0+$/.test(m[1]!) && !/^0+$/.test(m[2]!) ? { traceId: m[1]!, spanId: m[2]! } : undefined
}

/** The attributes Claude Code writes before `event.name` on a row: the ones it puts first on every span and metric too. */
export function commonOf(attributes: Readonly<Record<string, TelemetryAttribute>>): Attrs {
  const out: Attrs = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'event.name') return out
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  }
  // A row without `event.name` is not Claude Code's own: it says nothing about the common attributes.
  return {}
}

/** Attributes in order, with undefined values left out and strings cut to the session's limit. */
function attrs(r: Rebuild, entries: readonly (readonly [string, TelemetryAttribute | undefined])[]): Attrs {
  const out: Attrs = {}
  const limit = r.settings.valueLengthLimit
  for (const [key, value] of entries) {
    if (value === undefined) continue
    const v = typeof value === 'string' && limit !== undefined && value.length > limit ? value.slice(0, limit) : value
    Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true })
  }
  return out
}

/** What every span starts with: the common attributes, the provider, and the span's type. */
function head(r: Rebuild, type: string): [string, TelemetryAttribute | undefined][] {
  return [...Object.entries(r.common), ['gen_ai.provider.name', genAiProvider(r.common['anthropic.provider'])], ['span.type', type]]
}

/** `gen_ai.conversation.id`: a subagent's own id inside it, the session's on the main loop. */
const conversationOf = (r: Rebuild, agentId: string | undefined) => agentId ?? str(r.common['session.id'])

const agentAttrs = (r: Rebuild, agentId: string | undefined): [string, TelemetryAttribute | undefined][] =>
  agentId === undefined ? [] : [['agent_id', agentId], ['parent_agent_id', r.parentAgent.get(agentId)]]

const durationOf = (startMs: number, endMs: number) => Math.max(0, Math.round(endMs - startMs))

// ── Rows ──────────────────────────────────────────────────────────────────────

/**
 * Reads one collector row: the common attributes, the ids it names, and the request, decision or result it reports; and sends any
 * Agent call's execution the row has just named.
 */
export function observeRow(r: Rebuild, row: RowIn): Emit {
  return merge(readRow(r, row), namedExecutions(r))
}

function readRow(r: Rebuild, row: RowIn): Emit {
  const common = stripOwned(commonOf(row.attributes))
  if (Object.keys(common).length > 0) r.common = common
  const counted = sessionCount(r)
  return counted ? merge(counted, readRowEvent(r, row)) : readRowEvent(r, row)
}

/**
 * The session started: it counts once in `claude_code.session.count`, as Claude Code counts it when the process starts. The count
 * carries the session's attributes, which only a row names, so it waits for the first one.
 */
export function sessionStarted(r: Rebuild, nowMs: number): Emit {
  r.sessionCountAt = nowMs
  return sessionCount(r) ?? none()
}

function sessionCount(r: Rebuild): Emit | undefined {
  if (r.sessionCountAt === undefined || Object.keys(r.common).length === 0) return undefined
  const atMs = r.sessionCountAt
  r.sessionCountAt = undefined
  return { spans: [], measures: [{ name: 'claude_code.session.count', value: 1, attributes: attrs(r, [...Object.entries(r.common), ['start_type', 'fresh']]), atMs }] }
}

function readRowEvent(r: Rebuild, row: RowIn): Emit {
  const a = row.attributes
  const ctx = validCtx(row.span)
  const agentId = str(a['agent_id'])
  // A subagent's model requests are logged inside the Agent call's run: their span is that run's. Other rows of a subagent may be
  // logged inside another span (a permission decision, a hook), so only a request names it.
  const subagentRequest = (row.event === 'api_request' || row.event === 'api_error') && metricQuerySource(a['query_source']) === 'subagent'
  if (agentId && ctx && subagentRequest && !r.knownIds.has(ctx.spanId) && !r.execOfAgent.has(agentId)) {
    r.execOfAgent.set(agentId, ctx.spanId)
  }
  switch (row.event) {
    case 'user_prompt': {
      const prompt: Prompt = { ctx, text: a['prompt'] ?? '<REDACTED>', length: num(a['prompt_length']) ?? 0 }
      if (ctx) {
        r.interactionIds.add(ctx.spanId)
        r.knownIds.add(ctx.spanId)
      }
      const it = r.interaction
      if (it && !it.prompt && (promptFits(prompt, it.text) || (ctx !== undefined && it.ctx?.spanId === ctx.spanId))) it.prompt = prompt
      else if (!it && r.command && !r.command.prompt) {
        r.command.prompt = prompt
        r.command.promptAtMs = row.atMs
      } else r.heldPrompt = prompt
      return none()
    }
    case 'tool_decision': {
      const id = str(a['tool_use_id'])
      if (ctx) r.knownIds.add(ctx.spanId)
      const tool = id ? r.tools.get(id) : undefined
      const decision = str(a['decision']) ?? 'unknown'
      if (tool) tool.decision = { ctx, decision, source: str(a['source']), atMs: row.atMs }
      const name = str(a['tool_name'])
      if (name && CODE_EDIT_TOOLS.includes(name)) {
        const path = tool?.input['file_path'] ?? tool?.input['notebook_path']
        const measure: Measure = {
          name: 'claude_code.code_edit_tool.decision', value: 1, atMs: row.atMs,
          attributes: attrs(r, [...Object.entries(r.common), ['decision', decision], ['source', str(a['source'])], ['tool_name', name], ['language', path === undefined ? undefined : languageOf(path)]]),
        }
        return { spans: [], measures: [measure] }
      }
      return none()
    }
    case 'tool_result': {
      const id = str(a['tool_use_id'])
      const tool = id ? r.tools.get(id) : undefined
      if (tool) tool.result = { ctx, success: a['success'] === undefined ? undefined : truthy(a['success']), error: a['error'], atMs: row.atMs }
      return tool ? finishTool(r, tool, false) : none()
    }
    case 'api_request':
    case 'api_error': {
      learnInteraction(r, row, ctx)
      const measures = row.event === 'api_request' ? requestMeasures(r, row) : []
      return merge(pairRequest(r, row), { spans: [], measures })
    }
    default:
      return none()
  }
}

/** A main-loop request's row names the interaction it belongs to: kept for a turn whose prompt row never came. */
function learnInteraction(r: Rebuild, row: RowIn, ctx: Ctx | undefined) {
  if (!ctx || row.attributes['agent_id'] !== undefined || metricQuerySource(row.attributes['query_source']) !== 'main') return
  if (r.interaction && !r.interaction.ctx && !r.interaction.prompt?.ctx) {
    r.interaction.ctx = ctx
    r.interactionIds.add(ctx.spanId)
    r.knownIds.add(ctx.spanId)
    // A prompt row whose text the turn's did not match (pastes expanded, say) is still this turn's when it names the same span.
    if (!r.interaction.prompt && r.heldPrompt?.ctx?.spanId === ctx.spanId) {
      r.interaction.prompt = r.heldPrompt
      r.heldPrompt = undefined
    }
  }
}

/** A plugin's own completions and classifications: logged as requests, but kept out of the cost and token metrics. */
const UNMETERED = new Set(['plugin_model_complete', 'plugin_model_classify'])

/** Cost and tokens, as Claude Code adds them for each response. */
function requestMeasures(r: Rebuild, row: RowIn): Measure[] {
  const a = row.attributes
  if (typeof a['query_source'] === 'string' && UNMETERED.has(a['query_source'])) return []
  const qs = metricQuerySource(a['query_source'])
  const base = attrs(r, [
    ...Object.entries(r.common),
    ['model', str(a['model'])],
    ['speed', a['speed'] === 'fast' ? 'fast' : undefined],
    ['query_source', qs],
    ['effort', str(a['effort'])],
    ...(['agent.name', 'skill.name', 'plugin.name', 'marketplace.name', 'mcp_server.name', 'mcp_tool.name'] as const).map(k => [k, str(a[k])] as const),
  ])
  const at = row.atMs
  const out: Measure[] = []
  const cost = num(a['cost_usd'])
  if (cost !== undefined) out.push({ name: 'claude_code.cost.usage', value: cost, attributes: base, atMs: at })
  for (const [type, key] of [['input', 'input_tokens'], ['output', 'output_tokens'], ['cacheRead', 'cache_read_tokens'], ['cacheCreation', 'cache_creation_tokens']] as const) {
    const n = num(a[key])
    if (n !== undefined) out.push({ name: 'claude_code.token.usage', value: n, attributes: { ...base, type }, atMs: at })
  }
  return out
}

// ── Model requests ────────────────────────────────────────────────────────────

const loopOf = (agentId: unknown) => (typeof agentId === 'string' && agentId !== '' ? agentId : 'main')

/** A request of the main loop or a subagent's has a `turn.step`; another (a title, a summary, a classifier) has none. */
const hasStep = (row: RowIn) => {
  const qs = metricQuerySource(row.attributes['query_source'])
  return qs === 'main' || qs === 'subagent'
}

const sameUsage = (u: StepUsage | null, a: RowIn['attributes']) =>
  u !== null && u.input_tokens === num(a['input_tokens']) && u.output_tokens === num(a['output_tokens'])
  && u.cache_read_input_tokens === (num(a['cache_read_tokens']) ?? 0) && u.cache_creation_input_tokens === (num(a['cache_creation_tokens']) ?? 0)

/** Pairs a request's row with its step result, or holds it a moment for the step to finish. */
function pairRequest(r: Rebuild, row: RowIn): Emit {
  if (!hasStep(row)) return { spans: [llmSpan(r, row, undefined)], measures: [] }
  const loop = loopOf(row.attributes['agent_id'])
  const i = r.steps.findIndex(s => s.loop === loop && (row.event === 'api_error' ? s.usage === null : sameUsage(s.usage, row.attributes)))
  if (i >= 0) {
    const [step] = r.steps.splice(i, 1)
    return { spans: [llmSpan(r, row, step)], measures: [] }
  }
  r.waiting.push({ row, heldAtMs: row.atMs })
  if (r.waiting.length > MAX_WAITING) return { spans: [llmSpan(r, r.waiting.shift()!.row, undefined)], measures: [] }
  return none()
}

/** A `turn.step` began: the loop's requests run on this model (the lines a file edit counts are credited to it). */
export function stepStart(r: Rebuild, agentId: string | undefined, model: string): void {
  r.loopModel.set(loopOf(agentId), model)
}

/**
 * A `turn.step` settled, its request having started at `startMs` (the step's own hook keeps it, so a step whose stream was closed early
 * moves no other's): its stop reason and usage pair with the request's row, now or when the row comes.
 */
export function stepEnd(r: Rebuild, agentId: string | undefined, startMs: number, result: { stopReason: string | null; usage: StepUsage | null } | undefined, nowMs: number): Emit {
  const loop = loopOf(agentId)
  const step: Step = { loop, startMs, endMs: nowMs, stopReason: result?.stopReason ?? null, usage: result?.usage ?? null }
  const i = r.waiting.findIndex(w => loopOf(w.row.attributes['agent_id']) === loop && (w.row.event === 'api_error' ? step.usage === null : sameUsage(step.usage, w.row.attributes)))
  if (i >= 0) {
    const [w] = r.waiting.splice(i, 1)
    return { spans: [llmSpan(r, w!.row, step)], measures: [] }
  }
  r.steps.push(step)
  return none()
}

/** One `claude_code.llm_request`, as Claude Code ends it. */
function llmSpan(r: Rebuild, row: RowIn, step: Step | undefined): BuiltSpan {
  const a = row.attributes
  const parent = validCtx(row.span)
  const failed = row.event === 'api_error'
  const endMs = row.atMs
  const startMs = Math.min(step?.startMs ?? endMs - (num(a['duration_ms']) ?? 0), endMs)
  const model = str(a['model'])
  const agentId = str(a['agent_id'])
  // Claude Code names the context the request ran in: a tool's (a subagent's requests run inside its Agent call), the open
  // interaction's, or none. Where a host does not carry the trace onto the row (the SDK), the plugin's own state says which.
  const context = parent !== undefined
    ? (r.interactionIds.has(parent.spanId) ? 'interaction' : 'tool')
    : agentId !== undefined ? 'tool' : r.interaction !== undefined ? 'interaction' : 'standalone'
  const status = num(a['status_code'])
  const error = str(a['error'])
  const attempt = num(a['attempt']) ?? 1
  const stop = step?.stopReason ?? undefined
  return {
    traceId: parent?.traceId ?? r.interaction?.prompt?.ctx?.traceId ?? r.mint(32),
    spanId: r.mint(16),
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    name: 'claude_code.llm_request',
    startMs,
    endMs,
    attributes: attrs(r, [
      ...head(r, 'llm_request'),
      ['model', model],
      ['gen_ai.system', 'anthropic'],
      ['gen_ai.request.model', model],
      ['llm_request.context', context],
      ['speed', a['speed'] === 'fast' ? 'fast' : 'normal'],
      ['gen_ai.conversation.id', conversationOf(r, agentId)],
      ['query_source_safe', querySourceSafe(a['query_source'])],
      ...agentAttrs(r, agentId),
      ['duration_ms', durationOf(startMs, endMs)],
      ['input_tokens', num(a['input_tokens'])],
      ['output_tokens', num(a['output_tokens'])],
      ['cache_read_tokens', num(a['cache_read_tokens'])],
      ['cache_creation_tokens', num(a['cache_creation_tokens'])],
      ['success', !failed],
      ['status_code', failed && status !== undefined ? Math.trunc(status) : undefined],
      ['error', failed ? error : undefined],
      ['attempt', Math.trunc(attempt)],
      ['request_id', str(a['request_id'])],
      ['gen_ai.response.id', str(a['request_id'])],
      ['client_request_id', str(a['client_request_id'])],
      ['ttft_ms', num(a['ttft_ms'])],
      ['first_content_ms', num(a['ttft_ms'])],
      ['effort', str(a['effort'])],
      ['stop_reason', stop],
      ['gen_ai.response.finish_reasons', stop === undefined ? undefined : [stop]],
    ]),
    events: [{ name: 'gen_ai.request.attempt', timeMs: startMs, attributes: { attempt: Math.trunc(attempt) } }],
    ...(failed ? { status: { code: 2 as const, ...(error ? { message: error } : {}) } } : {}),
  }
}

// ── Turns ─────────────────────────────────────────────────────────────────────

/**
 * Whether a prompt row is the one a turn began with: its length is the turn's text's. A prompt that started no turn (one a hook
 * blocked, one folded into a running turn) is not taken by the next.
 */
const promptFits = (prompt: Prompt, text: string) => prompt.length === text.length

/** A main-loop turn began: an interaction opens, with the prompt row that came before it, if one did. */
export function turnStart(r: Rebuild, e: { turnId: string; text: string; agentId?: string }): void {
  if (e.agentId !== undefined) return
  // A command that goes on to ask the model (a skill, a prompt command) is one interaction with its turn, as in Claude Code.
  const command = r.command
  r.command = undefined
  if (command === undefined) r.sequence += 1
  const held = command?.prompt ?? (r.heldPrompt && promptFits(r.heldPrompt, e.text) ? r.heldPrompt : undefined)
  r.interaction = { turnId: e.turnId, sequence: command?.sequence ?? r.sequence, text: e.text, ...(held ? { prompt: held } : {}) }
  r.heldPrompt = undefined
}

/** A slash command began: an interaction opens, unless a model turn takes it over. */
export function commandStart(r: Rebuild, nowMs: number): void {
  if (r.interaction !== undefined) return
  r.sequence += 1
  r.command = { sequence: r.sequence, startMs: nowMs }
}

/**
 * A slash command ended. Its interaction goes after a short wait (`sweep`), never at once: a command that asks the model (a skill, a
 * prompt command) starts its turn right after, and the turn takes the interaction over.
 */
export function commandEnd(r: Rebuild, nowMs: number): Emit {
  if (r.command !== undefined) r.command.endMs = nowMs
  return none()
}

/** One slash command's interaction, from the command's start to its end or its prompt row, whichever is later. */
function sendCommand(r: Rebuild): Emit {
  const c = r.command
  if (c === undefined || c.endMs === undefined) return none()
  r.command = undefined
  const endMs = Math.max(c.endMs, c.promptAtMs ?? c.endMs)
  return interactionSpan(r, { ctx: c.prompt?.ctx, prompt: c.prompt, text: '', sequence: c.sequence, startMs: c.startMs, endMs, durationMs: endMs - c.startMs })
}

/** A turn ended: a main-loop turn's interaction is sent, and its time counts as active; a subagent's frees its Agent call. */
export function turnComplete(r: Rebuild, e: { turnId: string; durationMs: number; agentId?: string }, nowMs: number): Emit {
  if (e.agentId !== undefined) {
    const toolId = [...r.agentTool.entries()].find(([, agent]) => agent === e.agentId)?.[0]
    const tool = toolId ? r.tools.get(toolId) : undefined
    return tool?.execWaits ? sendExecution(r, tool) : none()
  }
  const it = r.interaction
  if (!it || it.turnId !== e.turnId) return none()
  r.interaction = undefined
  const durationMs = Math.max(0, Math.round(e.durationMs))
  return interactionSpan(r, { ctx: it.prompt?.ctx ?? it.ctx, prompt: it.prompt, text: it.text, sequence: it.sequence, startMs: nowMs - durationMs, endMs: nowMs, durationMs })
}

/** One `claude_code.interaction`, a turn's or a slash command's, and its time as active time. */
function interactionSpan(r: Rebuild, i: { ctx?: Ctx; prompt?: Prompt; text: string; sequence: number; startMs: number; endMs: number; durationMs: number }): Emit {
  const ctx = i.ctx ?? { traceId: r.mint(32), spanId: r.mint(16) }
  const parent = r.settings.traceparent?.traceId === ctx.traceId ? r.settings.traceparent : undefined
  const durationMs = Math.max(0, Math.round(i.durationMs))
  const span: BuiltSpan = {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    name: 'claude_code.interaction',
    startMs: i.startMs,
    endMs: i.endMs,
    attributes: attrs(r, [
      ...head(r, 'interaction'),
      ['gen_ai.operation.name', 'invoke_agent'],
      ['gen_ai.conversation.id', conversationOf(r, undefined)],
      ['user_prompt', i.prompt?.text ?? '<REDACTED>'],
      ['user_prompt_length', i.prompt ? i.prompt.length : i.text.length],
      ['interaction.sequence', i.sequence],
      ['parent.source', parent ? 'env' : 'none'],
      ['queued_sends', 0],
      ['interaction.duration_ms', durationMs],
    ]),
  }
  const active: Measure = { name: 'claude_code.active_time.total', value: durationMs / 1000, attributes: attrs(r, [...Object.entries(r.common), ['type', 'cli']]), atMs: i.endMs }
  return { spans: [span], measures: [active] }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/** A tool call began. */
export function toolStart(r: Rebuild, e: { tool: string; tool_use_id?: string; agentId?: string } & Readonly<Record<string, unknown>>, nowMs: number): void {
  const id = e.tool_use_id
  if (!id) return
  const { tool: name, tool_use_id: _id, agentId, ...input } = e
  r.tools.set(id, { id, name, input, ...(agentId ? { agentId } : {}), startMs: nowMs, spanId: r.mint(16), sent: false, execWaits: false })
}

/** An Agent call started a subagent, inside another subagent or not. */
export function agentSpawned(r: Rebuild, toolUseId: string, agentId: string, parentAgentId: string | undefined): void {
  r.agentTool.set(toolUseId, agentId)
  if (parentAgentId) r.parentAgent.set(agentId, parentAgentId)
  const tool = r.tools.get(toolUseId)
  if (tool) tool.spawned = agentId
}

/** A tool call settled: its spans go once its result row is in, and what it did counts toward the metrics. */
export function toolEnd(r: Rebuild, id: string | undefined, result: { isError?: boolean; deny?: string; result?: unknown } | undefined, nowMs: number): Emit {
  const tool = id ? r.tools.get(id) : undefined
  if (!tool) return none()
  tool.endMs = nowMs
  tool.endedAtMs = nowMs
  tool.isError = result?.isError === true || result?.deny !== undefined
  const measures: Measure[] = []
  const ok = !tool.isError && result?.deny === undefined
  if (ok && (tool.name === 'Edit' || tool.name === 'Write' || tool.name === 'NotebookEdit')) {
    const lines = linesChanged(result?.result)
    if (lines) {
      const model = r.loopModel.get(loopOf(tool.agentId))
      for (const [type, value] of [['added', lines.added], ['removed', lines.removed]] as const) {
        measures.push({ name: 'claude_code.lines_of_code.count', value, attributes: attrs(r, [...Object.entries(r.common), ['type', type], ['model', model]]), atMs: nowMs })
      }
    }
  }
  if (ok && tool.name === 'Bash' && typeof tool.input['command'] === 'string') {
    const { commits, pullRequests } = gitCounts(tool.input['command'])
    if (commits > 0) measures.push({ name: 'claude_code.commit.count', value: commits, attributes: { ...r.common }, atMs: nowMs })
    if (pullRequests > 0) measures.push({ name: 'claude_code.pull_request.count', value: pullRequests, attributes: { ...r.common }, atMs: nowMs })
  }
  const mcp = mcpParts(tool.name)
  if (ok && mcp && mcpCreatesPr(mcp.tool)) measures.push({ name: 'claude_code.pull_request.count', value: 1, attributes: { ...r.common }, atMs: nowMs })
  return merge(finishTool(r, tool, false), { spans: [], measures })
}

/** The attributes Claude Code reads from a tool's input onto its span. */
function inputAttrs(r: Rebuild, tool: Tool): [string, TelemetryAttribute | undefined][] {
  const out: [string, TelemetryAttribute | undefined][] = []
  const input = tool.input
  if (r.settings.toolDetails) {
    if ((tool.name === 'Read' || tool.name === 'Edit' || tool.name === 'Write') && input['file_path'] !== undefined) out.push(['file_path', String(input['file_path'])])
    else if (tool.name === 'Bash' && typeof input['command'] === 'string') out.push(['full_command', input['command']])
    else if (tool.name !== 'Read' && tool.name !== 'Edit' && tool.name !== 'Write' && tool.name !== 'Bash') {
      if (tool.name === 'Skill') out.push(['skill_name', str(input['skill'])])
      if (tool.name === 'Agent') out.push(['subagent_type', str(input['subagent_type'])])
    }
  }
  if (tool.name === 'Bash' && typeof input['command'] === 'string') {
    const cls = bashClass(input['command'])
    out.push(['bash_command_class', cls.bash_command_class], ['bash_argv0', cls.bash_argv0])
  }
  return out
}

/**
 * Sends a tool call's spans once it has ended and its result row is in (or, with `force`, with what there is). A call the
 * permission step never saw (a hook refused it first) has no spans, as in Claude Code.
 */
function finishTool(r: Rebuild, tool: Tool, force: boolean): Emit {
  if (tool.sent || tool.endMs === undefined) return none()
  if (!tool.result && !force && tool.decision?.decision !== 'reject') return none()
  tool.sent = true
  if (!tool.decision && !tool.result) {
    r.tools.delete(tool.id)
    return none()
  }
  const endMs = tool.endMs
  const mcp = mcpParts(tool.name)
  const parentId = tool.result?.ctx?.spanId ?? (tool.agentId ? r.execOfAgent.get(tool.agentId) : r.interaction?.prompt?.ctx?.spanId ?? r.interaction?.ctx?.spanId)
  const traceId = tool.decision?.ctx?.traceId ?? tool.result?.ctx?.traceId ?? r.interaction?.prompt?.ctx?.traceId ?? r.mint(32)
  const conversation = conversationOf(r, tool.agentId)
  const spans: BuiltSpan[] = [{
    traceId,
    spanId: tool.spanId,
    ...(parentId ? { parentSpanId: parentId } : {}),
    name: 'claude_code.tool',
    startMs: tool.startMs,
    endMs,
    attributes: attrs(r, [
      ...head(r, 'tool'),
      ['tool_name', tool.name],
      ['tool_name_safe', toolNameSafe(tool.name)],
      ['gen_ai.operation.name', 'execute_tool'],
      ['gen_ai.tool.name', mcp?.tool ?? tool.name],
      ['anthropic.mcp.server.name', mcp?.server],
      ['gen_ai.conversation.id', conversation],
      ...inputAttrs(r, tool),
      ...agentAttrs(r, tool.agentId),
      ['tool_use_id', tool.id],
      ['gen_ai.tool.call.id', tool.id],
      ['duration_ms', durationOf(tool.startMs, endMs)],
    ]),
  }]
  const d = tool.decision
  if (d) {
    const blockedEnd = Math.min(Math.max(d.atMs, tool.startMs), endMs)
    spans.push({
      traceId: d.ctx?.traceId ?? traceId,
      spanId: d.ctx?.spanId ?? r.mint(16),
      parentSpanId: tool.spanId,
      name: 'claude_code.tool.blocked_on_user',
      startMs: tool.startMs,
      endMs: blockedEnd,
      attributes: attrs(r, [
        ...head(r, 'tool.blocked_on_user'),
        ['gen_ai.conversation.id', conversation],
        ['duration_ms', durationOf(tool.startMs, blockedEnd)],
        ['decision', d.decision],
        ['source', d.source],
      ]),
    })
  }
  const ran = d ? d.decision === 'accept' : tool.result !== undefined
  let out: Emit = { spans, measures: [] }
  if (ran) {
    tool.execWaits = true
    // An Agent call's execution is the parent its subagent's rows name: it waits to take that id, unless the subagent already named it.
    const waitsForAgent = tool.name === 'Agent' && !force && !(tool.spawned && r.execOfAgent.has(tool.spawned))
    if (!waitsForAgent) out = merge(out, sendExecution(r, tool))
  }
  if (!tool.execWaits) r.tools.delete(tool.id)
  return out
}

/** One `claude_code.tool.execution`, under its tool span. */
function sendExecution(r: Rebuild, tool: Tool): Emit {
  if (!tool.execWaits || tool.endMs === undefined) return none()
  tool.execWaits = false
  r.tools.delete(tool.id)
  const startMs = Math.min(Math.max(tool.decision?.atMs ?? tool.startMs, tool.startMs), tool.endMs)
  const endMs = tool.endMs
  const success = tool.result?.success ?? !tool.isError
  const error = tool.result?.error
  const spanId = (tool.spawned && r.execOfAgent.get(tool.spawned)) || r.mint(16)
  const traceId = tool.decision?.ctx?.traceId ?? tool.result?.ctx?.traceId ?? r.mint(32)
  return {
    spans: [{
      traceId,
      spanId,
      parentSpanId: tool.spanId,
      name: 'claude_code.tool.execution',
      startMs,
      endMs,
      attributes: attrs(r, [
        ...head(r, 'tool.execution'),
        ['gen_ai.conversation.id', conversationOf(r, tool.agentId)],
        ['tool_use_id', tool.id],
        ['gen_ai.tool.call.id', tool.id],
        ['duration_ms', durationOf(startMs, endMs)],
        ['success', success],
        ['error.type', success ? undefined : 'tool_error'],
        ['error', success ? undefined : error],
      ]),
      ...(success ? {} : { status: { code: 2 as const, ...(typeof error === 'string' && error ? { message: error } : {}) } }),
    }],
    measures: [],
  }
}

// ── Waiting records ───────────────────────────────────────────────────────────

/**
 * Sends what has waited too long for its pair, with what it has, and forgets step results no row claimed. With `final` (the end
 * of the session), sends everything that has ended; what has not ended (a tool still running, an open turn) is never sent, as an
 * unended span never is.
 */
export function sweep(r: Rebuild, nowMs: number, final: boolean): Emit {
  let out = none()
  const keep: Waiting[] = []
  for (const w of r.waiting) {
    if (final || nowMs - w.heldAtMs >= PAIR_WAIT_MS) out = merge(out, { spans: [llmSpan(r, w.row, undefined)], measures: [] })
    else keep.push(w)
  }
  r.waiting = keep
  r.steps = r.steps.filter(s => nowMs - s.endMs < STEP_KEEP_MS)
  // A command whose prompt row has not come goes with what it has; at the end of the session (`/exit`), one still running ends now.
  const c = r.command
  if (c !== undefined && final && c.endMs === undefined) c.endMs = nowMs
  if (c !== undefined && c.endMs !== undefined && (final || nowMs - c.endMs >= PAIR_WAIT_MS)) out = merge(out, sendCommand(r))
  for (const tool of [...r.tools.values()]) {
    if (tool.endedAtMs === undefined) {
      if (nowMs - tool.startMs >= TOOL_KEEP_MS) r.tools.delete(tool.id)
      continue
    }
    if (!tool.sent && (final || nowMs - tool.endedAtMs >= PAIR_WAIT_MS)) out = merge(out, finishTool(r, tool, true))
    // An Agent call's subagent may run for a long time; its execution waits for it to name the span, or for the end of the session.
    else if (tool.execWaits && (final || (tool.spawned && r.execOfAgent.has(tool.spawned)))) out = merge(out, sendExecution(r, tool))
  }
  return out
}

/** Whether anything waits for a sweep: a request, a step result or a tool call. */
export const waits = (r: Rebuild) => r.waiting.length > 0 || r.steps.length > 0 || r.tools.size > 0 || r.command !== undefined

/** Sends any Agent call's execution its subagent has just named. */
export function namedExecutions(r: Rebuild): Emit {
  let out = none()
  for (const tool of [...r.tools.values()]) {
    if (tool.execWaits && tool.sent && tool.spawned && r.execOfAgent.has(tool.spawned)) out = merge(out, sendExecution(r, tool))
  }
  return out
}
