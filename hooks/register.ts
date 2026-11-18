// The plugin's hooks module. It stamps the telemetry rows Claude Code exports to the organization's collector (where the organization
// configured one), keeps the identity those rows carry for the session, and sends its own copy of each row to Mainwave's dev collector
// (sender.ts), keyless or with the person's dev ingest key, with the spans and metrics it rebuilds beside them (rebuild.ts, meter.ts).
// It draws nothing and registers no command or tool.
//
// The exporter's row always goes on: the copy is queued beside it, never in its place. Fail open: a hook that throws never holds up a
// row, a turn, a tool call or the session. A row whose stamping failed goes on without any key the plugin owns, as Claude Code wrote
// it otherwise. The hooks that watch turns, model requests, tool calls, slash commands, spawns and skill prompts only observe: each
// passes its event on unchanged, and its result back unchanged.
//
// Two data points no Claude Code row carries come in rows the plugin makes itself, each sent only while its data point is on: the MCP
// servers set up for the session (`mcp.url`, read from Claude's MCP settings at session start, and named when a call first names a
// server not read there), and each skill's text as the engine expands it for the model (`skill.text`, the `skill.prompt` hook). Such a
// row waits for the session's identity, which only Claude Code's rows carry.

import { atom, update } from 'claude-code'
import type { CatchHandler, EngineInterface, Frozen, Hook, Next, Register, StreamHook, TelemetryAttribute, TelemetryLogResult, TelemetryRecordEntry, Timer } from 'claude-code'

import type { RowIdentity } from '../types'
import { capturePrompt, captureTool, newCapture, rowFill, streamChunk, streamedThinking, streamStart, type Capture } from './capture.ts'
import { MCP_SERVER_ROW, SKILL_PROMPT_ROW, type Switch } from './catalog.ts'
import { mcpParts } from './derive.ts'
import { allows, configureGate, currentGate, gateAttributes, gateRow, gateSpan, metricAllowed, OVERRIDES_KEY, overridesOf, resetPacks, setOptIn, setOverrides } from './gate.ts'
import { endSession } from './http.ts'
import { identityOf, isOrgId, mergeIdentity } from './identity.ts'
import { add, collect, newMeter, type Meter } from './meter.ts'
import type { CopiedRow } from './otlp.ts'
import {
  agentSpawned, commandEnd, commandStart, newRebuild, observeRow, parseTraceparent, promptDropped, promptSubmitted, randomHex, sessionStarted, takeReady, stepEnd, stepStart, sweep, toolEnd, toolStart, turnComplete, turnStart, waits, type Emit, type Rebuild,
} from './rebuild.ts'
import { contentLimit } from './protect.ts'
import { adopt, configure, enqueue, ensureTimer, finish, isCopying, keyMalformed, readOptions, snapshot } from './sender.ts'
import {
  approvalsOf, approved, permitted, DESKTOP_UNDER_APPDATA, DESKTOP_UNDER_HOME, distinct, enabledPlugins, fileServers, foldersUp, globalServers, join, managedDirs, manifestServerFiles, MAX_PLUGINS, parse,
  pluginServers, projectEntry, serverAttributes, toolSpelling, type Approvals, type McpServer,
} from './servers.ts'
import { applyStamps, entrypointOf, filterStamps, PLUGIN_NAME, stripOwned } from './stamps.ts'
import { VERSION } from './version.ts'

export { VERSION }

// The hook stands on the collector stream only ({ to: 'collector' }), so its event and next are the collector record's.
type CollectorNext = Next<'telemetry.log', TelemetryRecordEntry, TelemetryLogResult, { 'telemetry.log': TelemetryRecordEntry }>
type CollectorHook = ($: EngineInterface, e: Frozen<TelemetryRecordEntry>, next: CollectorNext) => TelemetryLogResult | Promise<TelemetryLogResult>
type RowParams = Parameters<CollectorHook>
type RowCatchParams = Parameters<CatchHandler<CollectorHook>>
type SessionStartParams = Parameters<Hook<'session.start'>>
type SessionEndParams = Parameters<Hook<'session.end'>>
type TurnStartParams = Parameters<Hook<'turn.start'>>
type TurnCompleteParams = Parameters<Hook<'turn.complete'>>
type StepParams = Parameters<StreamHook<'turn.step'>>
type ToolCallParams = Parameters<Hook<'tool.call'>>
type ToolCatchParams = Parameters<CatchHandler<Hook<'tool.call'>>>
type PromptParams = Parameters<Hook<'prompt.submit'>>
type PromptCatchParams = Parameters<CatchHandler<Hook<'prompt.submit'>>>
type CommandParams = Parameters<Hook<'command.run'>>
type CommandCatchParams = Parameters<CatchHandler<Hook<'command.run'>>>
type SpawnParams = Parameters<Hook<'agent.spawn'>>
type SpawnCatchParams = Parameters<CatchHandler<Hook<'agent.spawn'>>>
type SkillParams = Parameters<Hook<'skill.prompt'>>
type SkillCatchParams = Parameters<CatchHandler<Hook<'skill.prompt'>>>

/** The session's identity as its rows say (types/index.d.ts). */
const identityAtom = atom({ plugin: 'mainwave', key: 'identity' } as const, {})
/** Whether this process has counted its session in `claude_code.session.count` (types/index.d.ts): once, whatever reloads. */
const sessionCountedAtom = atom({ plugin: 'mainwave', key: 'sessionCounted' } as const, false)

/** Claude Code's metric export interval when `OTEL_METRIC_EXPORT_INTERVAL` names none. */
export const METRIC_INTERVAL_MS = 60_000
/** How often records waiting for their pair are looked at. */
export const SWEEP_MS = 1_000
const ROUTE = filterStamps({ 'mainwave.telemetry.route': 'plugin' }).kept

// Per load of the module: a reload starts these over. `$.state` outlives a reload, so the first row after one writes the identity again.
let entrypoint: Promise<string> | null = null
let held: RowIdentity = {}
let rebuild: Promise<Rebuild> | null = null
let meter: Meter = newMeter()
let sweepTimer: Timer | null = null
let meterTimer: Timer | null = null
let gateRead: Promise<void> | null = null
let capture: Capture = newCapture()
/** The plugin's own rows, waiting for the session's identity (`r.common`). */
let own: OwnRow[] = []
/** The session a /clear or resume ended: the own rows of the session that follows wait for a row of its own, not this one's. */
let endedSession: TelemetryAttribute | undefined
/** The MCP servers sent this session, as a tool's name spells them; and the reading of Claude's MCP settings, once started. */
let serversSent = new Set<string>()
let serversRead: Promise<void> | null = null
/**
 * Each skill text's ID this session, the texts a queued row carried, and those a waiting row carries; the runs given arguments not yet
 * expanded, by name, with when each was given.
 */
let textIds = new Map<string, string>()
let textsSent = new Set<string>()
let textsWaiting = new Set<string>()
let argsInFlight = 0
let pendingArgs = new Map<string, number[]>()
let recentArgs: { text: string; atMs: number }[] = []

/** One of the plugin's own rows; `text`, for a skill's row, the text it carries, marked sent once the row is queued. */
type OwnRow = { event: string; atMs: number; attributes: Record<string, TelemetryAttribute>; text?: string }

/** How many own rows wait at most; how many skill texts keep their ID; how long, and how many, arguments are remembered. */
const MAX_OWN = 1_000
const MAX_SKILL_TEXTS = 200
const ARGS_MS = 60_000
const MAX_ARGS = 20
const MAX_PENDING = 50
/** How long a run given arguments waits to expand: a queued prompt waits for the turn before it. */
const PENDING_MS = 30 * 60_000

/** `CLAUDE_CODE_ENTRYPOINT`, normalized; `other` when it cannot be read. */
async function readEntrypoint($: EngineInterface): Promise<string> {
  try {
    return entrypointOf(await $.env.get('CLAUDE_CODE_ENTRYPOINT'))
  } catch {
    return 'other'
  }
}

/**
 * Keeps what the row says about who the session is, writing `$.state` only when the row adds something. The write merges into the
 * stored value, not this module's copy, so two rows that land together each keep their fields.
 */
async function noteIdentity($: EngineInterface, attributes: Readonly<Record<string, unknown>>): Promise<void> {
  const seen = identityOf(attributes)
  if (mergeIdentity(held, seen) === held) return
  let merged = held
  await update($, identityAtom, stored => (merged = mergeIdentity(stored, seen)))
  held = merged
}

/**
 * The copy of a row the plugin sends: plain data, its route `plugin`. Its ids are those of the span it ran in as the plugin's spans
 * have it (`ctx`, from the rebuild), where the rebuild says; else the row's own.
 */
function copyOf(e: Frozen<TelemetryRecordEntry>, attributes: Record<string, TelemetryAttribute>, ctx?: { traceId: string; spanId: string }): CopiedRow {
  const span = ctx !== undefined
    ? { traceId: ctx.traceId, spanId: ctx.spanId, traceFlags: e.span?.traceFlags ?? 1 }
    : e.span === undefined ? undefined : { traceId: e.span.traceId, spanId: e.span.spanId, traceFlags: e.span.traceFlags }
  const route = filterStamps({ 'mainwave.telemetry.route': 'plugin' }).kept
  return { event: e.event, loggedAt: e.loggedAt, ...(span ? { span } : {}), attributes: { ...attributes, ...route } }
}

/** A whole number of milliseconds of at least 1 from an environment variable, or undefined. */
function positiveInt(raw: string | undefined): number | undefined {
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** An environment read that answers undefined when it fails. */
async function settle(read: Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await read
  } catch {
    return undefined
  }
}

const truthy = (raw: string | undefined) => ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase())

/**
 * Whether Claude Code traces, as it decides it: `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, else `ENABLE_ENHANCED_TELEMETRY_BETA`, is on.
 * A read that fails counts as on, so the rebuild mirrors the rows as it always has rather than build a trace of its own.
 */
async function readClaudeTraces($: EngineInterface): Promise<boolean> {
  try {
    const [beta, legacy] = await Promise.all([$.env.get('CLAUDE_CODE_ENHANCED_TELEMETRY_BETA'), $.env.get('ENABLE_ENHANCED_TELEMETRY_BETA')])
    return truthy(beta ?? legacy)
  } catch {
    return true
  }
}

/**
 * The gate's settings for this load, read once: Claude Code's switches from the environment (one set to `0` keeps what it governs as
 * Claude Code sends it), the length limit, the explicit settings in the store, and the data points the person opts in to in their own
 * user settings. A read that fails counts as unset.
 */
async function readGate($: EngineInterface): Promise<void> {
  // Each name spelled out: the engine lists the variables a module reads from its calls.
  const [details, content, prompts, responses, repository, contentMax, anyLimit, rowLimit, spanLimit] = await Promise.all([
    settle($.env.get('OTEL_LOG_TOOL_DETAILS')),
    settle($.env.get('OTEL_LOG_TOOL_CONTENT')),
    settle($.env.get('OTEL_LOG_USER_PROMPTS')),
    settle($.env.get('OTEL_LOG_ASSISTANT_RESPONSES')),
    settle($.env.get('OTEL_METRICS_INCLUDE_REPOSITORY')),
    settle($.env.get('CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH')),
    settle($.env.get('OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT')),
    settle($.env.get('OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT')),
    settle($.env.get('OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT')),
  ])
  const switches: Partial<Record<Switch, string | undefined>> = {
    OTEL_LOG_TOOL_DETAILS: details, OTEL_LOG_TOOL_CONTENT: content, OTEL_LOG_USER_PROMPTS: prompts, OTEL_LOG_ASSISTANT_RESPONSES: responses, OTEL_METRICS_INCLUDE_REPOSITORY: repository,
  }
  configureGate(switches, contentLimit({
    CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH: contentMax, OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: anyLimit, OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT: rowLimit, OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: spanLimit,
  }))
  await readOverrides($)
  await readOptions($)
}

/** The explicit settings per data point the store keeps, if any. A store that cannot be read leaves those held. */
async function readOverrides($: EngineInterface): Promise<void> {
  try {
    setOverrides(overridesOf(await $.store.get(OVERRIDES_KEY)))
  } catch {
    // Those held stand.
  }
}

/** The gate in force, once this load has read its settings. */
async function gateOf($: EngineInterface) {
  gateRead ??= readGate($).catch(() => undefined)
  await gateRead
  return currentGate()
}

/** The rebuild for this load, its settings read from the environment once. */
async function makeRebuild($: EngineInterface): Promise<Rebuild> {
  await gateOf($)
  const [traceparent, spanLimit, anyLimit, claudeTraces] = await Promise.all([
    settle($.env.get('TRACEPARENT')),
    settle($.env.get('OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT')),
    settle($.env.get('OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT')),
    readClaudeTraces($),
  ])
  const limit = positiveInt(spanLimit) ?? positiveInt(anyLimit)
  return newRebuild({
    gate: currentGate,
    claudeTraces,
    ...(parseTraceparent(traceparent) ? { traceparent: parseTraceparent(traceparent)! } : {}),
    ...(limit !== undefined ? { valueLengthLimit: limit } : {}),
  })
}

/** Starts the timers that send what waited too long for its pair and collect the metrics, if they are not running. */
async function ensureRebuildTimers($: EngineInterface): Promise<void> {
  if (sweepTimer === null) sweepTimer = $.clock.every(SWEEP_MS, () => void sweepNow($, false))
  if (meterTimer === null) {
    const interval = positiveInt(await settle($.env.get('OTEL_METRIC_EXPORT_INTERVAL'))) ?? METRIC_INTERVAL_MS
    meterTimer ??= $.clock.every(interval, () => void collectNow($))
  }
}

/** The rebuild, when the plugin copies at all; null otherwise, or when it cannot be had. */
async function rebuildOf($: EngineInterface): Promise<Rebuild | null> {
  if (!isCopying()) return null
  try {
    rebuild ??= makeRebuild($)
    const r = await rebuild
    await ensureRebuildTimers($)
    return r
  } catch {
    return null
  }
}

/**
 * Queues what the rebuild produced, through the gate: each span with route `plugin`, each measure added to its counter with route
 * `plugin`, a measure of a data point that is off not at all.
 */
async function emit($: EngineInterface, out: Emit): Promise<void> {
  const gate = await gateOf($)
  for (const m of out.measures) {
    if (metricAllowed(gate, m.name)) add(meter, { ...m, attributes: { ...gateAttributes(gate, m.name, m.attributes), ...ROUTE } })
  }
  for (const span of out.spans) {
    const gated = gateSpan(gate, span)
    await enqueue($, { s: 'traces', d: { ...gated, attributes: { ...gated.attributes, ...ROUTE } } })
  }
}

/** Sends what waited too long for its pair; at the end of a session, everything that has ended. */
async function sweepNow($: EngineInterface, final: boolean): Promise<void> {
  try {
    if (rebuild === null || !isCopying()) return
    const r = await rebuild
    if (!final && !waits(r)) return
    await emit($, sweep(r, await $.clock.now(), final))
  } catch {
    // Next sweep.
  }
}

/** One metric collection: a delta point per series measured since the last, queued. */
async function collectNow($: EngineInterface): Promise<void> {
  try {
    if (!isCopying()) return
    for (const d of collect(meter, await $.clock.now())) await enqueue($, { s: 'metrics', d })
  } catch {
    // The measures since are lost to the copy alone.
  }
}

/**
 * Queues the plugin's own rows that wait, once a row of Claude Code's has said who the session is (after a /clear, a row of the
 * session that follows); until then they wait on. Taken one at a time, so a fault loses one row at most.
 */
async function flushOwn($: EngineInterface): Promise<void> {
  if (own.length === 0 || !isCopying()) return
  const r = await rebuildOf($)
  if (r === null || Object.keys(r.common).length === 0) return
  if (endedSession !== undefined && r.common['session.id'] === endedSession) return
  endedSession = undefined
  // This session's sets: a /clear while a row is being queued starts new ones, which the old session's texts stay out of.
  const sent = textsSent
  const waiting = textsWaiting
  const gate = await gateOf($)
  entrypoint ??= readEntrypoint($)
  const ep = await entrypoint
  for (let o = own.shift(); o !== undefined; o = own.shift()) {
    const at = new Date(o.atMs).toISOString()
    const attributes = applyStamps({ ...r.common, 'event.name': o.event, 'event.timestamp': at, ...o.attributes }, {
      'mainwave.plugin.name': PLUGIN_NAME, 'mainwave.plugin.version': VERSION, 'mainwave.plugin.entrypoint': ep, 'mainwave.telemetry.route': 'plugin',
    })
    const row = gateRow(gate, { event: o.event, loggedAt: at, attributes })
    try {
      // A text counts as sent once a row carrying it is queued; one held back or not queued is carried by the next run of it.
      if (row !== null && (await enqueue($, { s: 'logs', d: row })) && o.text !== undefined && row.attributes['skill.text'] !== undefined) sent.add(o.text)
    } finally {
      if (o.text !== undefined) waiting.delete(o.text)
    }
  }
}

/** Adds the plugin's own rows to those waiting, and queues them if the session's identity is known. */
async function queueOwn($: EngineInterface, rows: readonly OwnRow[]): Promise<void> {
  own.push(...rows)
  // The oldest go first; a text one carried is carried by the next run of it instead.
  if (own.length > MAX_OWN) for (const o of own.splice(0, own.length - MAX_OWN)) if (o.text !== undefined) textsWaiting.delete(o.text)
  await flushOwn($)
}

/** A file's text; undefined when it cannot be read. */
async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

/** The settings merged over every source, as Claude Code reads them; `{}` when they cannot be read. */
async function mergedSettings($: EngineInterface): Promise<Record<string, unknown>> {
  try {
    const v = (await $.settings.read()) as unknown
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The MCP servers set up for the session, as Claude's settings files list them (servers.ts). Reads nothing else in those files. */
async function readServers($: EngineInterface): Promise<McpServer[]> {
  const [home, profile, appData, configDir] = await Promise.all([
    settle($.env.get('HOME')), settle($.env.get('USERPROFILE')), settle($.env.get('APPDATA')), settle($.env.get('CLAUDE_CONFIG_DIR')),
  ])
  const homeDir = home || profile || undefined
  const read = async (path: string) => parse(await readText($, path))
  const settings = await mergedSettings($)
  const notDenied = (servers: McpServer[], a: Approvals) => servers.filter(s => permitted(a, s.name))
  // A managed file has exclusive control: only its servers load.
  const managed = await Promise.all(managedDirs(home || undefined, profile || undefined).map(d => read(join(d, 'managed-mcp.json'))))
  if (managed.some(m => m !== undefined)) return distinct(notDenied(managed.flatMap(m => fileServers(m, 'managed')), approvalsOf(settings, undefined)))
  let root: string | undefined
  try {
    root = await $.session.root()
  } catch {
    root = undefined
  }
  const base = configDir || homeDir
  const globalJson = base === undefined ? undefined : await read(join(base, '.claude.json'))
  const global = globalServers(globalJson, root)
  const approvals = approvalsOf(settings, projectEntry(globalJson, root))
  const project = root === undefined ? [] : (await Promise.all(foldersUp(root).map(d => read(join(d, '.mcp.json'))))).flatMap(m => fileServers(m, 'project')).filter(s => approved(approvals, s.name))
  const claudeDir = configDir || (homeDir === undefined ? undefined : join(homeDir, '.claude'))
  let plugins: McpServer[] = []
  if (claudeDir !== undefined) {
    const installed = enabledPlugins(await read(join(claudeDir, 'plugins', 'installed_plugins.json')), settings['enabledPlugins']).slice(0, MAX_PLUGINS)
    plugins = (await Promise.all(installed.map(async p => {
      const manifest = await read(join(p.path, '.claude-plugin', 'plugin.json'))
      const files = await Promise.all(manifestServerFiles(manifest).map(f => read(join(p.path, f))))
      return pluginServers(p.name, await read(join(p.path, '.mcp.json')), manifest, files)
    }))).flat()
  }
  entrypoint ??= readEntrypoint($)
  const desktopPaths = /desktop|cowork|local-agent/.test(await entrypoint)
    ? [...(homeDir === undefined ? [] : DESKTOP_UNDER_HOME.map(p => join(homeDir, ...p))), ...(appData ? [join(appData, ...DESKTOP_UNDER_APPDATA)] : [])]
    : []
  const desktop = (await Promise.all(desktopPaths.map(read))).flatMap(m => fileServers(m, 'desktop'))
  return distinct(notDenied([...global.local, ...project, ...global.user, ...plugins, ...desktop], approvals))
}

/** The rows for the MCP servers Claude's settings list, once per session, when their data point is on. */
async function noteServers($: EngineInterface): Promise<void> {
  const servers = (await readServers($)).filter(s => !serversSent.has(toolSpelling(s.name)))
  const atMs = await $.clock.now()
  for (const s of servers) serversSent.add(toolSpelling(s.name))
  if (servers.length > 0) await queueOwn($, servers.map(s => ({ event: MCP_SERVER_ROW, atMs, attributes: serverAttributes(s) })))
}

/** Reads Claude's MCP settings for the session that is starting, beside it, when MCP server addresses are on. */
async function startServers($: EngineInterface): Promise<void> {
  serversSent = new Set()
  serversRead = null
  if (allows(await gateOf($), 'mcp.url', false)) serversRead = noteServers($).catch(() => undefined)
}

/**
 * A call's `tool_result` row named an MCP server not sent yet (a claude.ai connector, one the host app provides, one set on the
 * command line): its row, with the name its tools are called by and the scope the row gives.
 */
async function noteCalledServer($: EngineInterface, attributes: Readonly<Record<string, TelemetryAttribute>>, tool: string | undefined): Promise<void> {
  const name = tool ?? (typeof attributes['tool_name'] === 'string' ? attributes['tool_name'] : undefined)
  const server = name === undefined ? undefined : mcpParts(name)?.server
  if (server === undefined || !allows(await gateOf($), 'mcp.url', false)) return
  // What the settings list goes first: the called server may be there, with its address.
  await serversRead
  if (serversSent.has(server)) return
  serversSent.add(server)
  const scope = typeof attributes['mcp_server_scope'] === 'string' ? attributes['mcp_server_scope'] : 'unknown'
  await queueOwn($, [{ event: MCP_SERVER_ROW, atMs: await $.clock.now(), attributes: serverAttributes({ name: server, scope }) }])
}

/** Two names for the same skill: equal, or one the other with its plugin's prefix (`tools:review`). */
const sameSkill = (a: string, b: string) => a === b || a.endsWith(`:${b}`) || b.endsWith(`:${a}`)

/**
 * A skill or slash command run given arguments: its name is held until a skill of that name expands, whenever that is, and the
 * arguments a short while, so a text that holds words the person typed is known for one.
 */
function expectArgs(name: unknown, args: unknown, atMs: number): boolean {
  if (typeof args !== 'string' || args.trim() === '') return false
  if (typeof name === 'string' && name !== '' && (pendingArgs.has(name) || pendingArgs.size < MAX_PENDING)) pendingArgs.set(name, [...(pendingArgs.get(name) ?? []), atMs].slice(-MAX_PENDING))
  recentArgs = [...recentArgs.filter(a => atMs - a.atMs < ARGS_MS), { text: args.trim(), atMs }].slice(-MAX_ARGS)
  return true
}

/**
 * Takes one run given arguments of this skill, if one waits; runs that waited too long are let go. One left over (a slash command
 * counted at its prompt and at its run) only holds the next text back.
 */
function takeArgs(skill: string, atMs: number): boolean {
  for (const [name, times] of pendingArgs) {
    const live = times.filter(t => atMs - t < PENDING_MS)
    if (live.length === 0) pendingArgs.delete(name)
    else pendingArgs.set(name, live)
  }
  for (const [name, times] of pendingArgs) {
    if (!sameSkill(name, skill)) continue
    if (times.length > 1) pendingArgs.set(name, times.slice(1))
    else pendingArgs.delete(name)
    return true
  }
  return false
}

/** A slash command typed as a prompt: its name and what follows it. */
function slashCommand(text: unknown): { name: string; args: string } | undefined {
  const m = typeof text === 'string' ? /^\/([^\s/]+)\s+([\s\S]+)$/.exec(text) : null
  return m ? { name: m[1]!, args: m[2]! } : undefined
}

/**
 * Whether a skill's text holds words the person typed: a run given arguments waits to expand under its name or is running, its text
 * holds arguments given lately, or it ends with the arguments Claude Code appends to a skill that names no placeholder.
 */
function holdsArgs(skill: string, text: string, atMs: number): boolean {
  const waited = takeArgs(skill, atMs)
  return waited || argsInFlight > 0 || /\nARGUMENTS: \S/.test(text) || recentArgs.some(a => atMs - a.atMs < ARGS_MS && text.includes(a.text))
}

/**
 * One skill run's row: its name, where it comes from, its text's ID, and the text itself until a row carrying it is queued this
 * session. A text with arguments filled in is sent only where prompts are (gate.ts).
 */
function skillRow(skill: string, source: string, text: string, atMs: number): OwnRow {
  const hasArgs = holdsArgs(skill, text, atMs)
  let id = textIds.get(text)
  if (id === undefined) {
    id = randomHex(16)
    if (textIds.size < MAX_SKILL_TEXTS) textIds.set(text, id)
  }
  const withText = !textsSent.has(text) && !textsWaiting.has(text)
  if (withText) textsWaiting.add(text)
  return {
    event: SKILL_PROMPT_ROW,
    atMs,
    attributes: { 'skill.name': skill, 'skill.source': source, 'skill.text_id': id, 'skill.has_arguments': hasArgs, ...(withText ? { 'skill.text': text } : {}) },
    ...(withText ? { text } : {}),
  }
}

/** A new session in the same process (/clear, resume): what the last one queued goes under its identity, and this one starts over. */
async function nextSession($: EngineInterface): Promise<void> {
  await serversRead
  await flushOwn($)
  const r = await rebuildOf($)
  endedSession = r?.common['session.id']
  textIds = new Map()
  textsSent = new Set()
  textsWaiting = new Set()
  pendingArgs = new Map()
  await startServers($)
}

/**
 * Reads one row into the rebuild: the row's own attributes as Claude Code raised them, before any stamp. Answers what it produced
 * and the ids the row's copy carries, where the rebuild gives them; null when the plugin does not rebuild.
 */
async function observe($: EngineInterface, e: Frozen<TelemetryRecordEntry>): Promise<(Emit & { rowCtx?: { traceId: string; spanId: string } }) | null> {
  const r = await rebuildOf($)
  if (r === null) return null
  const atMs = Date.parse(e.loggedAt)
  const span = e.span === undefined ? undefined : { traceId: e.span.traceId, spanId: e.span.spanId }
  return observeRow(r, { event: e.event, atMs: Number.isFinite(atMs) ? atMs : await $.clock.now(), ...(span ? { span } : {}), attributes: e.attributes })
}

/**
 * Stamps one collector row and queues the plugin's copy of it. A row that names an organization carries the plugin's name, version,
 * entry point and route (`exporter`); one that does not goes on without any key the plugin owns. Either way the row goes on to the
 * exporter, and the copy, where the plugin copies at all, is queued with route `plugin`.
 */
export async function stampRow($: RowParams[0], e: RowParams[1], next: RowParams[2]): Promise<TelemetryLogResult> {
  let attributes: Record<string, TelemetryAttribute>
  if (isOrgId(e.attributes['organization.id'])) {
    entrypoint ??= readEntrypoint($)
    const ep = await entrypoint
    try {
      await noteIdentity($, e.attributes)
    } catch {
      // The identity is the session's to keep, not the row's: a failed write never holds the row.
    }
    attributes = applyStamps(e.attributes, {
      'mainwave.plugin.name': PLUGIN_NAME,
      'mainwave.plugin.version': VERSION,
      'mainwave.plugin.entrypoint': ep,
      'mainwave.telemetry.route': 'exporter',
    })
  } else {
    attributes = stripOwned(e.attributes)
  }
  if (isCopying()) {
    // The rebuild reads the row first, so its copy carries the ids the plugin's spans give it. The copy is the plugin's own: a fault
    // in either never holds the exporter's row, and a fault in the rebuild never holds the copy.
    // The row's copy is queued before what the row completes, as the row came first.
    let out: Awaited<ReturnType<typeof observe>> = null
    try {
      out = await observe($, e)
    } catch {
      out = null
    }
    if (e.event === 'tool_result') {
      // Its call's name as the hook saw it (the row's may read `mcp_tool`), before the row's fill lets the call go.
      const id = e.attributes['tool_use_id']
      const tool = typeof id === 'string' ? capture.tools.get(id)?.name : undefined
      void noteCalledServer($, e.attributes, tool).catch(() => undefined)
    }
    try {
      // The copy goes through the gate: what it holds back removed, what the plugin read and it allows added, the protections applied.
      const gated = gateAttributes(await gateOf($), e.event, attributes, rowFill(capture, e.event, e.attributes))
      await enqueue($, { s: 'logs', d: copyOf(e, gated, out?.rowCtx) })
    } catch {
      // Lost to the copy alone.
    }
    if (out !== null) await emit($, out).catch(() => undefined)
    // The session's identity may be known now: the plugin's own rows waiting for it go, beside the row.
    if (own.length > 0) void flushOwn($).catch(() => undefined)
  }
  return next({ ...e, attributes })
}

/**
 * A row is always delivered. When stamping failed before the row went on, it goes on without any key the plugin owns; if even that
 * fails, as it came. When it had gone on already, the result it settled to is replayed and nothing beneath runs twice.
 */
export function rowCatch($: RowCatchParams[0], e: RowCatchParams[1], next: RowCatchParams[2]) {
  if (next.called) return next(e)
  let row = e
  try {
    row = { ...e, attributes: stripOwned(e.attributes) }
  } catch {
    // Not even the strip worked: the row goes on as it came.
  }
  return next(row)
}

/**
 * Starts the send timer, takes over outboxes earlier sessions left, and counts the session once per process in
 * `claude_code.session.count`; the event goes on unchanged.
 */
export async function sessionStart($: SessionStartParams[0], e: SessionStartParams[1], next: SessionStartParams[2]) {
  if (isCopying()) {
    try {
      ensureTimer($)
      const r = await rebuildOf($)
      let first = false
      await update($, sessionCountedAtom, counted => ((first = counted !== true), true))
      if (first && r !== null) await emit($, sessionStarted(r, await $.clock.now()))
      await adopt($)
      // A new session: its servers and skill texts are sent again (after a /clear, `session.end` starts them over). Claude's settings
      // are read beside the session's start, never holding it.
      textIds = new Map()
      textsSent = new Set()
      textsWaiting = new Set()
      await startServers($)
    } catch {
      // Sending starts with the next row instead.
    }
  }
  return next(e)
}

/** A main-loop turn began: an interaction opens. */
export async function turnStartHook($: TurnStartParams[0], e: TurnStartParams[1], next: TurnStartParams[2]) {
  let out: Emit | null = null
  try {
    if (e.agentId === undefined && isCopying()) capturePrompt(capture, e.text)
    const r = await rebuildOf($)
    if (r !== null) out = turnStart(r, e, await $.clock.now())
  } catch {
    // The turn's interaction is not rebuilt.
  }
  const result = await next(e)
  // Queued after the turn has gone on: the send queue never holds it.
  if (out !== null) await emit($, out).catch(() => undefined)
  return result
}

/** A turn ended: a main-loop interaction is sent. */
export async function turnCompleteHook($: TurnCompleteParams[0], e: TurnCompleteParams[1], next: TurnCompleteParams[2]) {
  let out: Emit | null = null
  try {
    const r = await rebuildOf($)
    if (r !== null) out = turnComplete(r, e, await $.clock.now())
  } catch {
    // The turn's interaction is not rebuilt.
  }
  const result = await next(e)
  if (out !== null) await emit($, out).catch(() => undefined)
  return result
}

/**
 * The stream as it came, each piece shown to `see` on its way: next, return and throw go to it as `yield*` sends them. A fault in
 * `see` is the watcher's alone.
 */
function watched<T, R>(inner: AsyncGenerator<T, R, unknown>, see: (chunk: T) => void): AsyncGenerator<T, R, unknown> {
  const look = (step: IteratorResult<T, R>) => {
    if (!step.done) {
      try {
        see(step.value)
      } catch {
        // Not read.
      }
    }
    return step
  }
  const it: AsyncGenerator<T, R, unknown> = {
    next: async (...v: [] | [unknown]) => look(await inner.next(...v)),
    return: async v => inner.return(v),
    throw: async err => look(await inner.throw(err)),
    [Symbol.asyncIterator]: () => it,
  } as AsyncGenerator<T, R, unknown>
  return it
}

/**
 * One model request: its start, and its stop reason and usage once it is whole; the text and thinking it streams are read for its
 * rows. The stream passes through untouched.
 */
export async function* stepHook($: StepParams[0], e: StepParams[1], next: StepParams[2]) {
  let r: Rebuild | null = null
  let startMs = 0
  try {
    r = await rebuildOf($)
    if (r !== null) {
      stepStart(r, e.agentId, e.model)
      streamStart(capture, e.agentId)
      startMs = await $.clock.now()
    }
  } catch {
    r = null
  }
  // A stream closed early (interrupted, or no longer read) leaves here and sends nothing: its row, if one comes, goes alone.
  const stream = r === null ? next(e) : watched(next(e), chunk => streamChunk(capture, e.agentId, chunk))
  const result = yield* stream
  if (r !== null) {
    try {
      await emit($, stepEnd(r, e.agentId, startMs, result, await $.clock.now(), streamedThinking(capture, e.agentId)))
    } catch {
      // The request's span goes without its stop reason.
    }
  }
  return result
}

/** One tool call: when it began and ended, and what it did. The call and its result pass through untouched. */
export async function toolCallHook($: ToolCallParams[0], e: ToolCallParams[1], next: ToolCallParams[2]) {
  let r: Rebuild | null = null
  try {
    r = await rebuildOf($)
    if (r !== null) {
      // The call's own arguments: what the engine adds beside them is not the tool's input.
      const { tool, tool_use_id: id, agentId: _agent, consent: _consent, requestMeta: _meta, ...input } = e as unknown as { tool: string; tool_use_id?: string; agentId?: string; consent?: string; requestMeta?: unknown } & Record<string, unknown>
      captureTool(capture, id, tool, input)
      toolStart(r, e as never, await $.clock.now())
    }
  } catch {
    r = null
  }
  // A skill given arguments: the text it expands to holds them.
  let withArgs = false
  try {
    const input = e as unknown as { skill?: unknown; args?: unknown }
    withArgs = e.tool === 'Skill' && expectArgs(input.skill, input.args, await $.clock.now())
  } catch {
    withArgs = false
  }
  if (withArgs) argsInFlight += 1
  let result: Awaited<ReturnType<typeof next>>
  try {
    result = await next(e)
  } finally {
    if (withArgs) argsInFlight -= 1
  }
  if (r !== null) {
    try {
      await emit($, toolEnd(r, e.tool_use_id, result as never, await $.clock.now()))
    } catch {
      // The call's spans go with what the rows say.
    }
  }
  return result
}

/**
 * A slash command: when it ran, so one that asks no model (`/plugins`, `/cost`, `/exit`) is an interaction of its own, as Claude Code
 * counts it. The command and its result pass through untouched.
 */
export async function commandHook($: CommandParams[0], e: CommandParams[1], next: CommandParams[2]) {
  let r: Rebuild | null = null
  try {
    r = await rebuildOf($)
    if (r !== null) commandStart(r, await $.clock.now())
  } catch {
    r = null
  }
  let withArgs = false
  try {
    withArgs = expectArgs(e.command, e.args, await $.clock.now())
  } catch {
    withArgs = false
  }
  if (withArgs) argsInFlight += 1
  try {
    return await next(e)
  } finally {
    if (withArgs) argsInFlight -= 1
    // Ended however the command ends, a refused or failed one too, so it never waits on to be taken by a later turn.
    if (r !== null) {
      try {
        commandEnd(r, await $.clock.now())
        await emit($, takeReady(r))
      } catch {
        // The command's interaction goes with what the rows say, on the next sweep.
      }
    }
  }
}

/** A prompt submitted: one that runs no slash command sends the command waiting first. The prompt goes on untouched. */
export async function promptHook($: PromptParams[0], e: PromptParams[1], next: PromptParams[2]) {
  let r: Rebuild | null = null
  let out: Emit | null = null
  try {
    const slash = slashCommand(e.text)
    if (slash !== undefined) expectArgs(slash.name, slash.args, await $.clock.now())
    r = await rebuildOf($)
    if (r !== null) {
      capturePrompt(capture, e.text)
      out = promptSubmitted(r, e, await $.clock.now())
    }
  } catch {
    r = null
  }
  const result = await next(e)
  // Queued after the prompt has gone on: the send queue never holds it. A dropped prompt starts no turn to take its command over.
  try {
    if (r !== null && result.drop !== undefined) out = { spans: [...(out?.spans ?? []), ...promptDropped(r, await $.clock.now()).spans], measures: [...(out?.measures ?? [])] }
    if (out !== null) await emit($, out)
  } catch {
    // The command waiting goes on the next sweep.
  }
  return result
}

/** A prompt goes on whatever the hook did; once it has gone on, its result stands. */
export function promptCatch($: PromptCatchParams[0], e: PromptCatchParams[1], next: PromptCatchParams[2]) {
  return next(e)
}

/** A command goes on whatever the hook did; once it has gone on, its result stands. */
export function commandCatch($: CommandCatchParams[0], e: CommandCatchParams[1], next: CommandCatchParams[2]) {
  return next(e)
}

/** A tool call goes on whatever the hook did; once it has gone on, its result stands. */
export function toolCatch($: ToolCatchParams[0], e: ToolCatchParams[1], next: ToolCatchParams[2]) {
  return next(e)
}

/** An Agent call started a subagent: which call, so the subagent's rows can name the call's execution span. */
export async function spawnHook($: SpawnParams[0], e: SpawnParams[1], next: SpawnParams[2]) {
  const result = await next(e)
  try {
    const r = await rebuildOf($)
    if (r !== null && result.deny === undefined && result.agentId) agentSpawned(r, e.tool_use_id, result.agentId, e.parentAgentId)
  } catch {
    // The subagent's execution span goes with an id of its own.
  }
  return result
}

/** A spawn goes on whatever the hook did; once it has gone on, its result stands. */
export function spawnCatch($: SpawnCatchParams[0], e: SpawnCatchParams[1], next: SpawnCatchParams[2]) {
  return next(e)
}

/** A skill's prompt expanded for the model: its text, for `skill.text`. The text the model reads is the one `next` answers, unchanged. */
export async function skillHook($: SkillParams[0], e: SkillParams[1], next: SkillParams[2]) {
  const result = await next(e)
  try {
    if (isCopying() && typeof result.text === 'string') {
      // Queued beside the prompt: the text the model reads never waits on the plugin's work.
      if (allows(await gateOf($), 'skill.text', false)) void queueOwn($, [skillRow(e.skill, e.source, result.text, await $.clock.now())]).catch(() => undefined)
    }
  } catch {
    // The run's text is lost to the copy alone.
  }
  return result
}

/** A skill's prompt goes on whatever the hook did; once it has gone on, its result stands. */
export function skillCatch($: SkillCatchParams[0], e: SkillCatchParams[1], next: SkillCatchParams[2]) {
  return next(e)
}

/**
 * Sends what it can of the queue within the session's end bound and keeps the rest for a later session. Requests still waiting for
 * the ending session then answer `stopped` (http.ts); the event goes on unchanged.
 */
export async function sessionEnd($: SessionEndParams[0], e: SessionEndParams[1], next: SessionEndParams[2]) {
  try {
    if (isCopying()) {
      // The settings as they stand now: what is queued goes through them as it is sent.
      await readOverrides($)
      await sweepNow($, true)
      // The plugin's own rows still waiting go under the session's identity, those of the settings read beside its start too.
      await serversRead
      await flushOwn($).catch(() => undefined)
      // Claude Code's meter collects once more as the process ends; after a /clear or a resume the process goes on, and so does it.
      if (e.reason !== 'clear' && e.reason !== 'resume') await collectNow($)
    }
    await finish($, next.budget)
    // Never the value: only that it does not fit.
    if (keyMalformed()) $.ui.log('mainwave: copy off: the devIngestKey option holds a key of the wrong shape', { to: 'debug' })
    // Never the value: only why.
    const redaction = currentGate().redaction
    if (isCopying() && 'held' in redaction) $.ui.log(`mainwave: identifier and content values held back: the redaction packs chosen ${redaction.held === 'unreadable' ? "can't be read" : 'name a pack this plugin does not have'}`, { to: 'debug' })
    if (isCopying()) {
      const s = snapshot()
      const withheld = s.keyless ? `, ${s.withheld} held back (no organization and email)` : ''
      const refusals = s.refusedIdentities > 0 ? `, ${s.refusedIdentities} organization and email refused` : ''
      $.ui.log(`mainwave: copy to dev${s.keyless ? ' (keyless)' : ''}: ${s.sent} sent, ${s.dropped} dropped, ${s.queued} kept for a later session${withheld}${refusals}`, { to: 'debug' })
    }
  } catch {
    // What could not be kept is lost to the copy alone: the exporter's rows went on.
  }
  endSession()
  // After a /clear or a resume the process goes on under a new session id, with no `session.start`: its own rows start over.
  if ((e.reason === 'clear' || e.reason === 'resume') && isCopying()) await nextSession($).catch(() => undefined)
  return next(e)
}

export const register: Register = (on, options) => {
  entrypoint = null
  held = {}
  rebuild = null
  meter = newMeter()
  sweepTimer?.cancel()
  meterTimer?.cancel()
  sweepTimer = null
  meterTimer = null
  gateRead = null
  // The opt-in and the packs of an earlier load stand for nothing until this one reads them.
  setOptIn([])
  resetPacks()
  capture = newCapture()
  own = []
  serversSent = new Set()
  serversRead = null
  endedSession = undefined
  textIds = new Map()
  textsSent = new Set()
  textsWaiting = new Set()
  argsInFlight = 0
  pendingArgs = new Map()
  recentArgs = []
  configure(options)

  on('session.start', sessionStart)

  on('telemetry.log', { to: 'collector' }, stampRow).catch(rowCatch)

  on('turn.start', turnStartHook)
  on('turn.step', stepHook)
  on('turn.complete', turnCompleteHook)
  on('tool.call', toolCallHook).catch(toolCatch)
  on('command.run', commandHook).catch(commandCatch)
  on('prompt.submit', promptHook).catch(promptCatch)
  on('agent.spawn', spawnHook).catch(spawnCatch)
  on('skill.prompt', skillHook).catch(skillCatch)

  on('session.end', sessionEnd)
}
