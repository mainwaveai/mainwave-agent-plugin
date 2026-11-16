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
// Without the beta, Claude Code sends no spans and its rows name none, so there is no trace to mirror: the rebuild then makes one
// itself ("coherent" mode). Each interaction is the root of a trace the plugin starts as the turn (or the slash command) starts; the
// turn's model requests and tool calls are its children, and a subagent's requests and tool calls are children of its Agent call's
// execution, whose id the plugin makes as the subagent starts. The same tree as above, every id the plugin's own. Coherent mode holds
// while the beta is off and no row has named a span; once one has, the rebuild mirrors the rows again, as above.
//
// With the beta on, a turn whose prompt row names no span is rebuilt the same way: Claude Code did not trace it (the first turn of a
// session an SDK host drives, where the beta arrives with the organization's managed settings after the turn has begun), and its
// exporter sends each request and each tool call as a trace of its own, with no interaction. The plugin starts the interaction, puts
// the turn's requests and calls under it, and moves each call's trace (its decision's, its subagent's, a skill's) onto the
// interaction's, keeping the span ids the rows name. In both modes the copied rows carry the ids of the span they ran in, as Claude
// Code's rows do when it traces (`rowCtx`).
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
  /**
   * Claude Code's enhanced telemetry beta is on (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, else `ENABLE_ENHANCED_TELEMETRY_BETA`): it
   * traces, and its rows name their spans. Off, the rebuild builds the trace itself (coherent mode).
   */
  claudeTraces: boolean
}

/** What one event produced: finished spans, and additions to counters. */
export type Emit = { spans: BuiltSpan[]; measures: Measure[] }

/** A prompt row: its span, or, where it names none, the ids the plugin gives the interaction it starts (`own`). */
type Prompt = { ctx?: Ctx; own?: Ctx; text: TelemetryAttribute; length: number; atMs: number }
/** A main-loop turn. `rebuilt`: the beta is on, but its prompt row named no span, so the plugin builds its trace. */
type Interaction = { turnId: string; sequence: number; prompt?: Prompt; ctx?: Ctx; text: string; rebuilt?: true }
/**
 * A slash command that runs without a model turn (`/plugins`, `/cost`): an interaction of its own, as Claude Code counts it. In
 * coherent mode, `ctx` is the interaction's, made as the command starts.
 */
type Command = { sequence: number; startMs: number; endMs?: number; prompt?: Prompt; promptAtMs?: number; toTurn?: true; ctx?: Ctx }
/** Where a span sits in coherent mode: its trace, and its parent's span id (none for a root). */
type Home = { traceId?: string; parentId?: string }
/** A request's row, with where it sits in coherent mode as the row came: under the interaction, under its Agent call's run, or a root. */
type Req = RowIn & { home?: { traceId: string; parentId?: string; context: 'interaction' | 'tool' | 'standalone' } }

/** A prompt row of a slash command: its text starts with `/`, or is redacted, so nothing says it is not. */
const slashPrompt = (p: Prompt) => typeof p.text !== 'string' || p.text === '<REDACTED>' || p.text.startsWith('/')
type Step = { loop: string; startMs: number; endMs: number; stopReason: string | null; usage: StepUsage | null }
type StepUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
type Waiting = { row: Req; heldAtMs: number }
type Tool = {
  id: string
  name: string
  input: Readonly<Record<string, unknown>>
  agentId?: string
  startMs: number
  spanId: string
  endMs?: number
  isError?: boolean
  /** The permission decision; `own`, the span id the plugin gives it where its row names none and the plugin builds the trace. */
  decision?: { ctx?: Ctx; own?: string; decision: string; source?: string; atMs: number }
  result?: { ctx?: Ctx; success?: boolean; error?: TelemetryAttribute; atMs: number }
  spawned?: string
  /** Started in a rebuilt turn: the trace Claude Code started for it is moved onto the interaction's. */
  rebuilt?: true
  /**
   * Set when the call started in coherent mode: the trace and parent its spans take. A subagent's call whose Agent call is not known
   * yet takes its subagent's when its spans go.
   */
  home?: Home
  /** In coherent mode, the span id of the call's run, made when it first starts a subagent: every subagent it starts sits under it. */
  execId?: string
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
  /** Spans ready to go that no hook has sent yet: the next hook or sweep sends them. */
  ready: Emit
  /** Whether a prompt row has named its interaction's span: once one has, the host carries the trace onto its rows. */
  sawPromptSpan: boolean
  /** Whether any row has named a span: once one has, coherent mode is over. */
  sawSpan: boolean
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
  /** The span id of the Agent call's execution, as its subagent's rows name it, or as coherent mode made it. */
  execOfAgent: Map<string, string>
  /** In coherent mode, each subagent's trace and its Agent call's execution span: the parent of its requests and tool calls. */
  agentCtx: Map<string, Ctx>
  /**
   * In coherent mode, each loop with an agent id no Agent call is known to have started (a forked skill, a workflow's agent, or a
   * subagent seen before its spawn): where it sits, as first seen, so the loop's work stays in one trace.
   */
  looseAgents: Map<string, Home>
  /** In a rebuilt turn, each trace Claude Code started for one of its calls, and the interaction's trace it is moved onto. */
  traceMap: Map<string, string>
  /** In a rebuilt turn whose requests do name Claude Code's interaction after all: that span, and the plugin's interaction for it. */
  spanAlias: Map<string, string>
  /** The context the row being read ran in, as the plugin's spans have it: set while a row is read, for `observeRow` to answer. */
  rowCtx?: Ctx
  /** When the session started, while its count waits for the first row to name the session. */
  sessionCountAt?: number
  /** New span and trace ids: random hex of the given length. */
  mint: (hexLength: 16 | 32) => string
}

/** How long a record waits for its pair before it is sent with what it has. */
export const PAIR_WAIT_MS = 2_000
/** How recent a prompt row must be for the slash command that starts next to take it. */
export const HELD_PROMPT_MS = 1_000
/** How long a command handed to a model turn waits for that turn before it goes as an interaction of its own. */
export const TURN_WAIT_MS = 30_000
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
    steps: [], waiting: [], tools: new Map(), ready: { spans: [], measures: [] }, sawPromptSpan: false, sawSpan: false, agentTool: new Map(), parentAgent: new Map(),
    execOfAgent: new Map(), agentCtx: new Map(), looseAgents: new Map(), traceMap: new Map(), spanAlias: new Map(), mint,
  }
}

/** Whether the rebuild makes the trace itself: Claude Code does not trace, and no row has named a span. */
export const isCoherent = (r: Rebuild): boolean => !r.settings.claudeTraces && !r.sawSpan

const mintCtx = (r: Rebuild): Ctx => ({ traceId: r.mint(32), spanId: r.mint(16) })

/** Whether the plugin builds the trace of the work under way: in coherent mode, or in a rebuilt turn. */
const buildsTrace = (r: Rebuild): boolean => isCoherent(r) || r.interaction?.rebuilt === true

/** A trace id as the plugin sends it: a rebuilt turn's call's trace moved onto its interaction's. */
const retrace = (r: Rebuild, traceId: string): string => r.traceMap.get(traceId) ?? traceId
/** A span id a row names, as the plugin sends it: a rebuilt turn's interaction for Claude Code's. */
const respan = (r: Rebuild, spanId: string): string => r.spanAlias.get(spanId) ?? spanId

/** In coherent mode, the context the main loop's work runs in now: the open turn's interaction, or the slash command's. */
const openCtx = (r: Rebuild): Ctx | undefined => r.interaction?.ctx ?? r.command?.ctx

/**
 * Where a loop no Agent call is known to have started sits: under the interaction open when it was first seen, or, with none open, a
 * trace of its own. Settled once per loop.
 */
function looseHome(r: Rebuild, agentId: string): { traceId: string; parentId?: string } {
  let home = r.looseAgents.get(agentId)
  if (home === undefined) {
    const open = openCtx(r)
    home = open ? { traceId: open.traceId, parentId: open.spanId } : { traceId: r.mint(32) }
    r.looseAgents.set(agentId, home)
  }
  return home as { traceId: string; parentId?: string }
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
 * Agent call's execution the row has just named. Answers too the context the row ran in, as the plugin's spans have it (`rowCtx`):
 * the row's own span, its trace moved where a rebuilt turn moves it; or, where the row names none and the plugin builds the trace,
 * the span it ran in (the interaction, a subagent's Agent call's run, a decision's own). None where neither applies.
 */
export function observeRow(r: Rebuild, row: RowIn): Emit & { rowCtx?: Ctx } {
  r.rowCtx = undefined
  const out = merge(readRow(r, row), namedExecutions(r))
  const rowCtx = r.rowCtx ?? contextOfRow(r, row)
  r.rowCtx = undefined
  return rowCtx ? { ...out, rowCtx } : out
}

/** The span a row ran in, where the row does not say and nothing more particular (a prompt, a decision) has said either. */
function contextOfRow(r: Rebuild, row: RowIn): Ctx | undefined {
  const ctx = validCtx(row.span)
  if (ctx) return { traceId: retrace(r, ctx.traceId), spanId: respan(r, ctx.spanId) }
  if (!buildsTrace(r)) return undefined
  // A request outside the main loop and its subagents (a session title, a summary) ran in no span: its own is a root.
  if ((row.event === 'api_request' || row.event === 'api_error') && !hasStep(row)) return undefined
  const agentId = str(row.attributes['agent_id'])
  if (agentId === undefined) return openCtx(r)
  const agent = r.agentCtx.get(agentId)
  if (agent) return agent
  const loose = r.looseAgents.get(agentId)
  return loose?.traceId !== undefined && loose.parentId !== undefined ? { traceId: loose.traceId, spanId: loose.parentId } : undefined
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
  if (ctx) r.sawSpan = true
  const agentId = str(a['agent_id'])
  // A subagent's model requests are logged inside the Agent call's run: their span is that run's. Other rows of a subagent may be
  // logged inside another span (a permission decision, a hook), so only a request names it.
  const subagentRequest = (row.event === 'api_request' || row.event === 'api_error') && metricQuerySource(a['query_source']) === 'subagent'
  if (agentId && ctx && subagentRequest && !r.knownIds.has(ctx.spanId) && !r.execOfAgent.has(agentId)) {
    r.execOfAgent.set(agentId, ctx.spanId)
  }
  switch (row.event) {
    case 'user_prompt': {
      const prompt: Prompt = { ctx, text: a['prompt'] ?? '<REDACTED>', length: num(a['prompt_length']) ?? 0, atMs: row.atMs }
      if (ctx) {
        r.interactionIds.add(ctx.spanId)
        r.knownIds.add(ctx.spanId)
        r.sawPromptSpan = true
      }
      const it = r.interaction
      const forTurn = it !== undefined && !it.prompt && (promptFits(prompt, it.text) || (ctx !== undefined && it.ctx?.spanId === ctx.spanId))
      const forCommand = !forTurn && it === undefined && r.command !== undefined && !r.command.prompt && slashPrompt(prompt)
      if (ctx) r.traceMap.delete(ctx.traceId)
      // A prompt row that names no span: the interaction it starts is the plugin's to build, with these ids (the open turn's or
      // command's, where the plugin has made them already). Only a row a turn or a command takes, or one with none open, which may
      // yet start one: with the beta on, only while no prompt row has named a span (the untraced turn is a session's first). A row
      // folded into an open turn, or one a hook blocks, starts nothing.
      const mayStart = it === undefined && (isCoherent(r) || !r.sawPromptSpan)
      if (!ctx && (forTurn || forCommand || mayStart)) prompt.own = (forTurn ? it!.ctx : forCommand ? r.command!.ctx : undefined) ?? mintCtx(r)
      if (forTurn) {
        it!.prompt = prompt
        if (!ctx && it!.ctx === undefined) {
          it!.ctx = prompt.own
          if (!isCoherent(r)) it!.rebuilt = true
        }
      } else if (forCommand) {
        r.command!.prompt = prompt
        r.command!.promptAtMs = row.atMs
      } else r.heldPrompt = prompt
      r.rowCtx = ctx ?? prompt.own ?? (buildsTrace(r) ? openCtx(r) : undefined)
      return none()
    }
    case 'tool_decision': {
      const id = str(a['tool_use_id'])
      if (ctx) r.knownIds.add(ctx.spanId)
      const tool = id ? r.tools.get(id) : undefined
      const decision = str(a['decision']) ?? 'unknown'
      const home = tool ? homeOfTool(r, tool) : undefined
      // Where the plugin builds the trace: a decision whose row names no span gets an id of its own, the row with it; one that names
      // its span (a rebuilt turn) keeps it, and the trace Claude Code started for the call is moved onto the interaction's.
      const own = tool && home?.traceId !== undefined && !ctx ? r.mint(16) : undefined
      if (tool?.rebuilt && ctx && home?.traceId !== undefined && ctx.traceId !== home.traceId && ctx.traceId !== r.settings.traceparent?.traceId) {
        r.traceMap.set(ctx.traceId, home.traceId)
      }
      if (own !== undefined) r.rowCtx = { traceId: home!.traceId!, spanId: own }
      if (tool) tool.decision = { ctx, ...(own !== undefined ? { own } : {}), decision, source: str(a['source']), atMs: row.atMs }
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
  // A rebuilt turn whose request names Claude Code's interaction after all: that interaction is the plugin's, ids and trace.
  const it = r.interaction
  if (it?.rebuilt && it.ctx && ctx.spanId !== it.ctx.spanId && ctx.traceId !== r.settings.traceparent?.traceId) {
    r.traceMap.set(ctx.traceId, it.ctx.traceId)
    r.spanAlias.set(ctx.spanId, it.ctx.spanId)
    r.interactionIds.add(it.ctx.spanId)
    return
  }
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

/**
 * In coherent mode, where a request sits, read as its row comes (its span may go later, after the turn has ended): a subagent's under
 * its Agent call's run, the main loop's under the interaction open now. Any other request (a session title, a summary, a classifier)
 * is a root, as Claude Code's exporter sends it when it traces; so is a main-loop request with no interaction open. A loop no Agent
 * call is known to have started sits where it was first seen (`looseHome`).
 */
function homeOf(r: Rebuild, row: RowIn): Req['home'] {
  if (!buildsTrace(r) || validCtx(row.span) !== undefined || !hasStep(row)) return undefined
  const agentId = str(row.attributes['agent_id'])
  if (agentId !== undefined) {
    const agent = r.agentCtx.get(agentId)
    if (agent) return { traceId: agent.traceId, parentId: agent.spanId, context: 'tool' }
    const loose = looseHome(r, agentId)
    return { ...loose, context: loose.parentId !== undefined ? 'tool' : 'standalone' }
  }
  const open = openCtx(r)
  return open ? { traceId: open.traceId, parentId: open.spanId, context: 'interaction' } : undefined
}

/** Pairs a request's row with its step result, or holds it a moment for the step to finish. */
function pairRequest(r: Rebuild, rowIn: RowIn): Emit {
  const home = homeOf(r, rowIn)
  const row: Req = home ? { ...rowIn, home } : rowIn
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
function llmSpan(r: Rebuild, row: Req, step: Step | undefined): BuiltSpan {
  const a = row.attributes
  const named = validCtx(row.span)
  const parent = named ? { traceId: named.traceId, spanId: respan(r, named.spanId) } : row.home?.parentId !== undefined ? { traceId: row.home.traceId, spanId: row.home.parentId } : undefined
  const failed = row.event === 'api_error'
  const endMs = row.atMs
  const startMs = Math.min(step?.startMs ?? endMs - (num(a['duration_ms']) ?? 0), endMs)
  const model = str(a['model'])
  const agentId = str(a['agent_id'])
  // Claude Code names the context the request ran in: a tool's (a subagent's requests run inside its Agent call), the open
  // interaction's, or none. A row with no span ran outside both, unless the host carries no trace onto its rows at all (one that
  // drives Claude Code through its SDK): there the open interaction has no span of its own either, and the plugin's state says which.
  const traceless = !r.sawPromptSpan && r.interaction !== undefined && r.interaction.prompt?.ctx === undefined && r.interaction.ctx === undefined
  const context = row.home !== undefined
    ? row.home.context
    : parent !== undefined
    ? (r.interactionIds.has(parent.spanId) ? 'interaction' : 'tool')
    : traceless ? (agentId !== undefined ? 'tool' : 'interaction') : 'standalone'
  const status = num(a['status_code'])
  const error = str(a['error'])
  const attempt = num(a['attempt']) ?? 1
  const stop = step?.stopReason ?? undefined
  return {
    traceId: retrace(r, parent?.traceId ?? row.home?.traceId ?? r.interaction?.prompt?.ctx?.traceId ?? r.mint(32)),
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
export function turnStart(r: Rebuild, e: { turnId: string; text: string; agentId?: string }, nowMs: number): Emit {
  if (e.agentId !== undefined) return none()
  // A command that goes on to ask the model (a skill, a prompt command) is one interaction with its turn, as in Claude Code: the
  // submission that ran it says so. Any other command still waiting is sent first, and the turn is an interaction of its own.
  const flushed = r.command?.toTurn ? none() : endCommand(r, nowMs)
  const command = r.command
  r.command = undefined
  if (command === undefined) r.sequence += 1
  const held = command?.prompt ?? (r.heldPrompt && promptFits(r.heldPrompt, e.text) ? r.heldPrompt : undefined)
  // In coherent mode the interaction's trace starts now (a command the turn takes over has started it already). With the beta on, a
  // turn whose prompt row named no span is rebuilt, with the ids the plugin gave that row.
  const own = held && !held.ctx ? held.own : undefined
  const ctx = command?.ctx ?? own ?? (isCoherent(r) ? mintCtx(r) : undefined)
  const rebuilt = !isCoherent(r) && command?.ctx === undefined && own !== undefined
  r.interaction = {
    turnId: e.turnId, sequence: command?.sequence ?? r.sequence, text: e.text, ...(held ? { prompt: held } : {}), ...(ctx ? { ctx } : {}), ...(rebuilt ? { rebuilt: true as const } : {}),
  }
  r.heldPrompt = undefined
  return flushed
}

/**
 * A slash command began: an interaction opens, unless a model turn takes it over. One still waiting to be sent goes first; a prompt
 * row of a slash command seen just before is this command's.
 */
export function commandStart(r: Rebuild, nowMs: number): void {
  if (r.interaction !== undefined) return
  // Kept for the next hook or sweep, not handed back: a command like `/exit` may end the session before its own hook returns.
  r.ready = merge(r.ready, endCommand(r, nowMs))
  r.sequence += 1
  const held = r.heldPrompt
  const takes = held !== undefined && slashPrompt(held) && nowMs - held.atMs <= HELD_PROMPT_MS
  r.command = { sequence: r.sequence, startMs: nowMs, ...(isCoherent(r) ? { ctx: (takes ? held!.own : undefined) ?? mintCtx(r) } : {}) }
  if (held && takes) {
    r.command.prompt = held
    r.command.promptAtMs = held.atMs
    r.heldPrompt = undefined
  }
}

/** The spans ready to go, taken. */
export function takeReady(r: Rebuild): Emit {
  const out = r.ready
  r.ready = none()
  return out
}

/**
 * A prompt was submitted. One that runs no slash command is the start of a turn of its own: a command still waiting is sent first,
 * so the turn does not take it over. One that runs a command (a skill, a prompt command) may be that command's turn.
 */
export function promptSubmitted(r: Rebuild, e: { command?: unknown }, nowMs: number): Emit {
  if (e.command === undefined) return endCommand(r, nowMs)
  if (r.command !== undefined) r.command.toTurn = true
  return none()
}

/** A submitted prompt that ran a command was dropped (by a hook): no turn follows, so the command goes as an interaction of its own. */
export function promptDropped(r: Rebuild, nowMs: number): Emit {
  return r.command?.toTurn ? endCommand(r, nowMs) : none()
}

/** Sends the command waiting, if any, ending it now if it has not ended. */
function endCommand(r: Rebuild, nowMs: number): Emit {
  if (r.command === undefined) return none()
  r.command.endMs ??= nowMs
  return sendCommand(r)
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
  return interactionSpan(r, { ctx: c.prompt?.ctx ?? c.ctx ?? c.prompt?.own, prompt: c.prompt, text: '', sequence: c.sequence, startMs: c.startMs, endMs, durationMs: endMs - c.startMs })
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
  // A prompt row nothing claimed by the turn's end belongs to no later interaction.
  r.heldPrompt = undefined
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
  // In coherent mode a call sits under the interaction open now, or, a subagent's, under its Agent call's run (found when its spans
  // go, if the subagent is not known yet; where it was first seen, if no Agent call ever names it).
  let home: Home | undefined
  if (isCoherent(r)) {
    const parent = agentId ? r.agentCtx.get(agentId) : openCtx(r)
    if (agentId && !parent) looseHome(r, agentId)
    home = parent ? { traceId: parent.traceId, parentId: parent.spanId } : {}
  } else if (r.interaction?.rebuilt && r.interaction.ctx && !agentId) {
    // A rebuilt turn's call sits under its interaction. A subagent's rows there name their spans, in the Agent call's trace, which
    // its decision row moves onto the interaction's.
    home = { traceId: r.interaction.ctx.traceId, parentId: r.interaction.ctx.spanId }
  }
  const rebuilt = !isCoherent(r) && home !== undefined
  r.tools.set(id, { id, name, input, ...(agentId ? { agentId } : {}), ...(home ? { home } : {}), ...(rebuilt ? { rebuilt: true as const } : {}), startMs: nowMs, spanId: r.mint(16), sent: false, execWaits: false })
}

/** A coherent-mode call's trace and parent, settled the first time its spans or its subagent need them; undefined in any other mode. */
function homeOfTool(r: Rebuild, tool: Tool): Home | undefined {
  const home = tool.home
  if (home === undefined || home.traceId !== undefined) return home
  const agent = tool.agentId ? r.agentCtx.get(tool.agentId) : undefined
  tool.home = agent ? { traceId: agent.traceId, parentId: agent.spanId } : tool.agentId ? looseHome(r, tool.agentId) : { traceId: r.mint(32) }
  return tool.home
}

/** An Agent call started a subagent, inside another subagent or not. */
export function agentSpawned(r: Rebuild, toolUseId: string, agentId: string, parentAgentId: string | undefined): void {
  r.agentTool.set(toolUseId, agentId)
  if (parentAgentId) r.parentAgent.set(agentId, parentAgentId)
  const tool = r.tools.get(toolUseId)
  if (tool) tool.spawned = agentId
  // In coherent mode the Agent call's run is made now, so the subagent's requests and calls have their parent from the start. A call
  // that starts several agents (a workflow) has one run, the parent of each.
  const home = tool ? homeOfTool(r, tool) : undefined
  // Coherent mode alone: in a rebuilt turn the subagent's rows name the run themselves.
  if (tool && isCoherent(r) && home?.traceId !== undefined && !r.agentCtx.has(agentId)) {
    const exec = (tool.execId ??= r.execOfAgent.get(agentId) ?? r.mint(16))
    r.execOfAgent.set(agentId, exec)
    r.agentCtx.set(agentId, { traceId: home.traceId, spanId: exec })
  }
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
  const home = homeOfTool(r, tool)
  const parentId = (tool.result?.ctx ? respan(r, tool.result.ctx.spanId) : undefined) ?? (home ? home.parentId : tool.agentId ? r.execOfAgent.get(tool.agentId) : r.interaction?.prompt?.ctx?.spanId ?? r.interaction?.ctx?.spanId)
  const traceId = retrace(r, tool.decision?.ctx?.traceId ?? tool.result?.ctx?.traceId ?? home?.traceId ?? r.interaction?.prompt?.ctx?.traceId ?? r.mint(32))
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
      traceId: retrace(r, d.ctx?.traceId ?? traceId),
      spanId: d.ctx?.spanId ?? d.own ?? r.mint(16),
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
  const traceId = retrace(r, tool.decision?.ctx?.traceId ?? tool.result?.ctx?.traceId ?? homeOfTool(r, tool)?.traceId ?? r.mint(32))
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
  // A command handed to a model turn waits for that turn (it takes the command over), or goes alone if none comes.
  out = merge(out, takeReady(r))
  const c = r.command
  if (c !== undefined && final && c.endMs === undefined) c.endMs = nowMs
  if (c !== undefined && c.endMs !== undefined && (final || nowMs - c.endMs >= (c.toTurn ? TURN_WAIT_MS : PAIR_WAIT_MS))) out = merge(out, sendCommand(r))
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
export const waits = (r: Rebuild) => r.waiting.length > 0 || r.steps.length > 0 || r.tools.size > 0 || r.command !== undefined || r.ready.spans.length > 0

/** Sends any Agent call's execution its subagent has just named. */
export function namedExecutions(r: Rebuild): Emit {
  let out = none()
  for (const tool of [...r.tools.values()]) {
    if (tool.execWaits && tool.sent && tool.spawned && r.execOfAgent.has(tool.spawned)) out = merge(out, sendExecution(r, tool))
  }
  return out
}
