// The plugin's hooks module. It stamps the telemetry rows Claude Code exports to the organization's collector (where the organization
// configured one), keeps the identity those rows carry for the session, and sends its own copy of each row to Mainwave's production
// collector (sender.ts), keyless, with the spans and metrics it rebuilds beside them (rebuild.ts, meter.ts).
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
import { allows, configureGate, currentGate, gateAttributes, gateMarker, gateRow, gateSpan, metricAllowed, resetPacks, setOptIn, setOverrides } from './gate.ts'
import { classifyGlab, glabConfigDir, glabHosts, glabTexts, instanceOf, mrAttributes, mrFromApi, mrLookup, mrUrlOf, parseMrJson, repositoryIdOf, sameUrl, stripDraft, type MrDetails, type MrRef } from './glab.ts'
import { endSession } from './http.ts'
import { identityOf, isOrgId, mergeIdentity } from './identity.ts'
import { add, collect, newMeter, type Meter } from './meter.ts'
import {
  against, CHANGE_OPENED, cliCanSend, cliHookKinds, COMMIT_CREATED, commitAttributes, commitLookup, commitsInOutput, errorTypeOf, gitCommits, JIRA_TOOL, jiraTicket, KIND_SPAN, LINEAR_TOOL,
  linearTicket, MARKER_IDENTITY, MARKER_KEYS, markerResource, outputTexts, parseNumstat, parsePrStats, placeAttributes, prAttributes, prCreateOf, prLookup, prNumberOf, prUrlOf, STOP_FAILURE,
  STOP_FAILURE_ERROR, SUBSCRIPTION_SNAPSHOT, ticketSpan, type MarkerKind,
} from './markers.ts'
import type { BuiltSpan, CopiedRow } from './otlp.ts'
import {
  agentSpawned, callerCtx, commandEnd, commandStart, newRebuild, observeRow, parseTraceparent, promptDropped, promptSubmitted, randomHex, sessionStarted, takeReady, stepEnd, stepStart, sweep, toolEnd, toolStart, turnComplete, turnStart, waits, type Emit, type Rebuild,
} from './rebuild.ts'
import { applyStoredSettings, ensureFetching, noteSessionIdentity, resetOrgSettings, settingsSummary } from './orgsettings.ts'
import { contentLimit } from './protect.ts'
import { adopt, collectorMalformed, collectorOf, configure, enqueue, ensureTimer, finish, isCopying, readOptions, snapshot } from './sender.ts'
import {
  approvalsOf, approved, permitted, DESKTOP_UNDER_APPDATA, DESKTOP_UNDER_HOME, distinct, enabledPlugins, fileServers, foldersUp, globalServers, join, managedDirs, manifestServerFiles, MAX_PLUGINS, parse,
  pluginServers, projectEntry, serverAttributes, toolSpelling, type Approvals, type McpServer,
} from './servers.ts'
import { snapshotOfText } from './snapshot.ts'
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
type PostToolParams = Parameters<Hook<'classic.PostToolUse'>>
type PostToolCatchParams = Parameters<CatchHandler<Hook<'classic.PostToolUse'>>>
type PromptSubmitParams = Parameters<Hook<'classic.UserPromptSubmit'>>
type PromptSubmitCatchParams = Parameters<CatchHandler<Hook<'classic.UserPromptSubmit'>>>
type StopFailureParams = Parameters<Hook<'classic.StopFailure'>>
type StopFailureCatchParams = Parameters<CatchHandler<Hook<'classic.StopFailure'>>>

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
/** A marker (markers.ts), waiting for the session's identity like an own row; `account`, a snapshot's, sent only for the session's. */
type OwnMarker = { kind: MarkerKind; name: string; atMs: number; attributes: Record<string, TelemetryAttribute>; account?: string; session?: TelemetryAttribute }
/** The markers waiting for the session's identity; and, once read for this load, the kinds whose markers the CLI's hooks send. */
let markers: OwnMarker[] = []
let cliKinds: Promise<ReadonlySet<MarkerKind>> | null = null
/** The marker work under way, beside the calls and prompts it came from: the session's end waits a little for it. */
let making = new Set<Promise<void>>()

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
  // The organization's settings follow who the session is: those kept for it apply, and the plugin asks Mainwave for them.
  try {
    await noteSessionIdentity($, mergeIdentity(held, seen), isCopying)
  } catch {
    // The settings in force stand.
  }
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

/**
 * The organization's settings in force (orgsettings.ts): this load's answer from Mainwave, else what the store keeps for the session's
 * organization. A store that cannot be read leaves the explicit settings held.
 */
async function readOverrides($: EngineInterface): Promise<void> {
  try {
    await applyStoredSettings($)
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
  if ((own.length === 0 && markers.length === 0) || !isCopying()) return
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
  for (let m = markers.shift(); m !== undefined; m = markers.shift()) {
    try {
      await sendMarker($, r.common, m, ep)
    } catch {
      // That marker is lost to the copy alone.
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

// ── Markers ───────────────────────────────────────────────────────────────────

/** How long the lookups of one tool call's markers may take: git's for its commits, gh's for a pull request, glab's for a merge request. */
export const GIT_LOOKUP_MS = 5_000
export const GH_LOOKUP_MS = 5_000
export const GLAB_LOOKUP_MS = 2_500
/** At most this many markers wait for the session's identity; and how long the session's end waits for those being made. */
const MAX_MARKERS = 200
export const MARKER_END_WAIT_MS = 500

/** Runs marker work beside the event it came from, never failing it; the session's end can wait for it. */
function beside(work: () => Promise<void>): void {
  const p = work().catch(() => undefined)
  making.add(p)
  void p.finally(() => making.delete(p))
}

/** Waits, a short while at most, for the markers being made: a commit made just before the session ends goes with it. */
async function markersMade($: EngineInterface): Promise<void> {
  if (making.size === 0) return
  await Promise.race([Promise.allSettled([...making]), $.clock.sleep(MARKER_END_WAIT_MS)])
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The kinds of marker the CLI's hooks send in this session, read once per load: those whose hook the merged settings run and whose
 * script is on this machine, where the session gives the CLI a key to send with. None where it has no key: its hooks then send
 * nothing, and the plugin's markers stand in; nor where the CLI was never installed, as its hook command then does nothing.
 */
async function cliKindsOf($: EngineInterface): Promise<ReadonlySet<MarkerKind>> {
  cliKinds ??= (async () => {
    const settings = await mergedSettings($)
    const [endpoint, headers, home] = await Promise.all([settle($.env.get('OTEL_EXPORTER_OTLP_ENDPOINT')), settle($.env.get('OTEL_EXPORTER_OTLP_HEADERS')), settle($.env.get('HOME'))])
    const out = new Set<MarkerKind>()
    if (!cliCanSend(endpoint, headers, settings['otelHeadersHelper'])) return out
    const there = new Map<string, Promise<boolean>>()
    for (const [kind, scripts] of cliHookKinds(settings, home || undefined)) {
      for (const script of scripts) {
        if (!there.has(script)) there.set(script, readText($, script).then(t => t !== undefined))
        if (await there.get(script)) {
          out.add(kind)
          break
        }
      }
    }
    return out
  })().catch(() => new Set<MarkerKind>())
  return cliKinds
}

/**
 * Whether a kind of marker goes from the plugin at all: the plugin copies, the data point of the marker's key is on, and the CLI's
 * hook for it does not send it already. Asked before any lookup, so nothing runs for a marker that would not go.
 */
async function markerWanted($: EngineInterface, kind: MarkerKind): Promise<boolean> {
  if (!isCopying()) return false
  const point = MARKER_KEYS[KIND_SPAN[kind]]?.point
  if (point !== undefined && !allows(await gateOf($), point, false)) return false
  return !(await cliKindsOf($)).has(kind)
}

/** Queues markers to go once the session's identity is known, as the plugin's own rows do. */
async function queueMarkers($: EngineInterface, made: readonly OwnMarker[], session?: TelemetryAttribute): Promise<void> {
  if (made.length === 0) return
  markers.push(...(session === undefined ? made : made.map(m => ({ ...m, session }))))
  if (markers.length > MAX_MARKERS) markers.splice(0, markers.length - MAX_MARKERS)
  await flushOwn($)
}

/**
 * One marker as a span of its own: the session's identity, the marker's attributes, the plugin's stamps, in a trace of its own, at
 * the time it was made; through the gate, and queued with its resource. A snapshot of an account other than the session's (the
 * account record names whoever signed in last) is not sent.
 */
async function sendMarker($: EngineInterface, common: Readonly<Record<string, TelemetryAttribute>>, m: OwnMarker, ep: string): Promise<void> {
  if (m.account !== undefined && (m.account !== common['user.account_uuid'] || (m.attributes['organization.id'] ?? common['organization.id']) !== common['organization.id'])) return
  const identity: Record<string, TelemetryAttribute> = {}
  for (const k of MARKER_IDENTITY) if (common[k] !== undefined) identity[k] = common[k]!
  // A marker made in a session a /clear has since ended goes under that session, not the one that follows.
  if (m.session !== undefined) identity['session.id'] = m.session
  const attributes = applyStamps({ ...identity, ...m.attributes }, {
    'mainwave.plugin.name': PLUGIN_NAME, 'mainwave.plugin.version': VERSION, 'mainwave.plugin.entrypoint': ep, 'mainwave.telemetry.route': 'plugin',
  })
  const span: BuiltSpan = { traceId: randomHex(32), spanId: randomHex(16), name: m.name, startMs: m.atMs, endMs: m.atMs, attributes }
  const gated = gateMarker(await gateOf($), span)
  if (gated !== null) await enqueue($, { s: 'traces', d: gated }, base => markerResource(base, m.kind))
}

/** A command on the host; undefined when it cannot run (no host commands here, as in Cowork), fails, or runs past its time. */
async function runQuietly($: EngineInterface, argv: readonly string[], init: { cwd?: string; env?: Record<string, string>; timeoutMs: number }): Promise<string | undefined> {
  if (init.timeoutMs <= 0) return undefined
  try {
    const r = await $.process.run(argv, init)
    return r.exitCode === 0 ? r.stdout : undefined
  } catch {
    return undefined
  }
}

/** Where a marker made at a tool call sits: the span the call ran in, the call, and the subagent. */
async function placeOf($: EngineInterface, agentId: string | undefined, toolCallId?: string): Promise<Record<string, TelemetryAttribute>> {
  const r = await rebuildOf($)
  const caller = r === null ? undefined : callerCtx(r, agentId)
  return placeAttributes({ ...(caller ? { caller } : {}), toolCallId, agentId })
}

/** The commits a shell command made: each looked up by the name git printed, in the folder it ran in, within one time budget. */
async function commitMarkers($: EngineInterface, calls: readonly { dir?: string }[], texts: readonly string[], cwd: string | undefined, place: Record<string, TelemetryAttribute>): Promise<OwnMarker[]> {
  const shas = commitsInOutput(texts)
  if (shas.length === 0 || !(await markerWanted($, 'git'))) return []
  const dirs = [...new Set([...calls.map(c => (c.dir === undefined ? cwd : against(cwd, c.dir))), cwd])]
  const atMs = await $.clock.now()
  const deadline = atMs + GIT_LOOKUP_MS
  const out: OwnMarker[] = []
  for (const sha of shas) {
    for (const dir of dirs) {
      const stdout = await runQuietly($, commitLookup(sha), { ...(dir !== undefined ? { cwd: dir } : {}), env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, timeoutMs: deadline - (await $.clock.now()) })
      const commit = parseNumstat(stdout)
      if (commit === undefined || !commit.sha.startsWith(sha)) continue
      out.push({ kind: 'git', name: COMMIT_CREATED, atMs, attributes: { ...commitAttributes(commit), ...place } })
      break
    }
  }
  return out
}

/** The pull request `gh pr create` opened, with its size where gh can say, looked up by its address. */
async function prMarker($: EngineInterface, title: string | undefined, texts: readonly string[], place: Record<string, TelemetryAttribute>): Promise<OwnMarker[]> {
  const url = prUrlOf(texts)
  const number = url === undefined ? undefined : prNumberOf(url)
  if (url === undefined || number === undefined || !(await markerWanted($, 'gh'))) return []
  const atMs = await $.clock.now()
  const stats = parsePrStats(await runQuietly($, prLookup(url), { timeoutMs: GH_LOOKUP_MS }))
  return [{ kind: 'gh', name: CHANGE_OPENED, atMs, attributes: { ...prAttributes(url, number, title, stats), ...place } }]
}

/** The session the plugin's rows say it is in now, if any has said. */
async function sessionNow($: EngineInterface): Promise<TelemetryAttribute | undefined> {
  const r = await rebuildOf($)
  return r?.common['session.id']
}

/**
 * The merge request glab opened: from a `glab api` answer, else the address glab printed; its project's ID from the answer, else from
 * `glab mr view`, run only for a host glab's own config names and believed only for the same address.
 */
async function mrMarker($: EngineInterface, call: { kind: 'create' | 'api'; title?: string }, response: unknown, place: Record<string, TelemetryAttribute>): Promise<OwnMarker[]> {
  const texts = glabTexts(response)
  let api: MrDetails = {}
  let mr: MrRef | undefined
  if (call.kind === 'api') {
    for (const t of texts) {
      const a = mrFromApi(t)
      if (!a.webUrl) continue
      api = a
      mr = mrUrlOf(a.webUrl)
      break
    }
  }
  for (const t of texts) mr ??= mrUrlOf(t)
  if (mr === undefined || !(await markerWanted($, 'glab'))) return []
  const atMs = await $.clock.now()
  let details: MrDetails = api
  if (api.projectId === undefined) {
    details = {}
    const home = await settle($.env.get('HOME'))
    if (home) {
      const legacy = await readText($, `${home}/.config/glab-cli/config.yml`)
      let platform: string | undefined
      try {
        platform = (await $.session.info()).platform
      } catch {
        platform = undefined
      }
      const dir = glabConfigDir(home, platform, legacy !== undefined)
      const config = legacy ?? (await readText($, `${dir}/config.yml`))
      if (glabHosts(config).has(instanceOf(mr.url) ?? '')) {
        const env = { HOME: home, GLAB_CONFIG_DIR: dir, GLAB_NO_PROMPT: '1', GLAB_SEND_TELEMETRY: '0' }
        const found = parseMrJson(await runQuietly($, mrLookup(mr), { cwd: home, env, timeoutMs: GLAB_LOOKUP_MS }))
        if (sameUrl(found.webUrl, mr.url)) details = found
      }
    }
  }
  const title = stripDraft(details.title ?? api.title ?? call.title)
  return [{ kind: 'glab', name: CHANGE_OPENED, atMs, attributes: { ...mrAttributes(mr, repositoryIdOf(mr.url, details.projectId), title, details.filesChanged), ...place } }]
}

/** The markers of one tool call that ended: a shell command's commits, pull request and merge request; an MCP save's ticket. */
async function toolMarkers($: EngineInterface, e: PostToolParams[1]): Promise<void> {
  const session = await sessionNow($)
  const tool = e.tool_name
  const input = isRecord(e.tool_input) ? e.tool_input : {}
  const agentId = typeof e.agent_id === 'string' && e.agent_id !== '' ? e.agent_id : undefined
  const cwd = typeof e.cwd === 'string' && e.cwd !== '' ? e.cwd : undefined
  const made: OwnMarker[] = []
  if (tool === 'Bash') {
    const command = input['command']
    if (typeof command !== 'string') return
    const calls = gitCommits(command)
    const pr = prCreateOf(command)
    const glab = classifyGlab(command)
    if (calls.length === 0 && pr === undefined && glab === undefined) return
    const place = await placeOf($, agentId, e.tool_use_id)
    const texts = outputTexts(e.tool_response)
    if (calls.length > 0) made.push(...(await commitMarkers($, calls, texts, cwd, place)))
    if (pr !== undefined) made.push(...(await prMarker($, pr.title, texts, place)))
    if (glab !== undefined) made.push(...(await mrMarker($, glab, e.tool_response, place)))
  } else if (LINEAR_TOOL.test(tool) || JIRA_TOOL.test(tool)) {
    const linear = LINEAR_TOOL.test(tool)
    const ticket = linear ? linearTicket(tool, input, e.tool_response) : jiraTicket(tool, e.tool_response)
    if (ticket === undefined || !(await markerWanted($, linear ? 'linear' : 'jira'))) return
    made.push({ kind: linear ? 'linear' : 'jira', name: ticketSpan(ticket), atMs: await $.clock.now(), attributes: { ...ticket, ...(await placeOf($, agentId, e.tool_use_id)) } })
  }
  await queueMarkers($, made, session)
}

/** A tool call ended (PostToolUse): its markers are made beside it, never holding it. The event and its result go on unchanged. */
export async function postToolHook($: PostToolParams[0], e: PostToolParams[1], next: PostToolParams[2]) {
  const result = await next(e)
  try {
    if (isCopying()) beside(() => toolMarkers($, e))
  } catch {
    // No marker for that call.
  }
  return result
}

/** A PostToolUse goes on whatever the hook did; once it has gone on, its result stands. */
export function postToolCatch($: PostToolCatchParams[0], e: PostToolCatchParams[1], next: PostToolCatchParams[2]) {
  return next(e)
}

/** The plan snapshot for a prompt, from Claude Code's account record, when its data point is on and the CLI's hook does not send it. */
async function snapshotMarker($: EngineInterface, promptId: unknown): Promise<void> {
  if (!(await markerWanted($, 'snapshot'))) return
  const session = await sessionNow($)
  const [home, profile, configDir] = await Promise.all([settle($.env.get('HOME')), settle($.env.get('USERPROFILE')), settle($.env.get('CLAUDE_CONFIG_DIR'))])
  const base = configDir || home || profile || undefined
  if (base === undefined) return
  const atMs = await $.clock.now()
  const snap = await snapshotOfText(await readText($, join(base, '.claude.json')))
  if (snap === undefined) return
  // No calling span: the prompt's interaction has not begun when it is submitted, and the one open is the turn before's.
  const attributes = { 'mainwave.subscription.trigger': 'UserPromptSubmit', ...placeAttributes({ promptId }), ...snap.attributes }
  await queueMarkers($, [{ kind: 'snapshot', name: SUBSCRIPTION_SNAPSHOT, atMs, attributes, account: snap.accountUuid }], session)
}

/** A prompt submitted (UserPromptSubmit): the plan snapshot goes beside it. The event and its result go on unchanged. */
export async function promptSubmitHook($: PromptSubmitParams[0], e: PromptSubmitParams[1], next: PromptSubmitParams[2]) {
  const result = await next(e)
  try {
    if (isCopying()) beside(() => snapshotMarker($, e.prompt_id))
  } catch {
    // No snapshot for that prompt.
  }
  return result
}

/** A UserPromptSubmit goes on whatever the hook did; once it has gone on, its result stands. */
export function promptSubmitCatch($: PromptSubmitCatchParams[0], e: PromptSubmitCatchParams[1], next: PromptSubmitCatchParams[2]) {
  return next(e)
}

/** A turn ended on an API error (StopFailure): the kind of error, and nothing else of it. The event and its result go on unchanged. */
export async function stopFailureHook($: StopFailureParams[0], e: StopFailureParams[1], next: StopFailureParams[2]) {
  const result = await next(e)
  try {
    const error = errorTypeOf(e.error)
    if (error !== undefined && isCopying()) {
      beside(async () => {
        if (!(await markerWanted($, 'stop'))) return
        const atMs = await $.clock.now()
        const place = await placeOf($, undefined)
        await queueMarkers($, [{ kind: 'stop', name: STOP_FAILURE, atMs, attributes: { [STOP_FAILURE_ERROR]: error, ...placeAttributes({ promptId: e.prompt_id }), ...place } }], await sessionNow($))
      })
    }
  } catch {
    // No span for that failure.
  }
  return result
}

/** A StopFailure goes on whatever the hook did; once it has gone on, its result stands. */
export function stopFailureCatch($: StopFailureCatchParams[0], e: StopFailureCatchParams[1], next: StopFailureCatchParams[2]) {
  return next(e)
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
    if (own.length > 0 || markers.length > 0) void flushOwn($).catch(() => undefined)
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
      // The organization's settings: asked for again as a session starts, where its rows have named who it is.
      ensureFetching($)
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
      await markersMade($)
      await sweepNow($, true)
      // The plugin's own rows still waiting go under the session's identity, those of the settings read beside its start too.
      await serversRead
      await flushOwn($).catch(() => undefined)
      // Claude Code's meter collects once more as the process ends; after a /clear or a resume the process goes on, and so does it.
      if (e.reason !== 'clear' && e.reason !== 'resume') await collectNow($)
    }
    await finish($, next.budget)
    // Never the value: only that it does not fit.
    if (collectorMalformed()) $.ui.log('mainwave: copy off: the collectorUrl option is not an https URL (or http on loopback)', { to: 'debug' })
    // Never the value: only why.
    const redaction = currentGate().redaction
    if (isCopying() && 'held' in redaction) $.ui.log(`mainwave: identifier and content values held back: the redaction packs chosen ${redaction.held === 'unreadable' ? "can't be read" : 'name a pack this plugin does not have'}`, { to: 'debug' })
    if (isCopying()) {
      const s = snapshot()
      const refusals = s.refusedIdentities > 0 ? `, ${s.refusedIdentities} organization and email refused` : ''
      const stopped = s.stopped ? ', refused: nothing more sent or queued this session' : ''
      $.ui.log(`mainwave: copy to ${collectorOf()} (keyless): ${s.sent} sent, ${s.dropped} dropped, ${s.queued} kept for a later session, ${s.withheld} held back (no organization and email)${refusals}${stopped}; data collection settings: ${settingsSummary()}`, { to: 'debug' })
    }
  } catch {
    // What could not be kept is lost to the copy alone: the exporter's rows went on.
  }
  endSession()
  // After a /clear or a resume the process goes on under a new session id, with no `session.start`: its own rows start over.
  if ((e.reason === 'clear' || e.reason === 'resume') && isCopying()) await nextSession($).catch(() => undefined)
  return next(e)
}

export const register: Register = on => {
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
  // Nor do its organization's settings: those kept in the store apply again once a row names the organization.
  setOverrides({})
  resetOrgSettings()
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
  markers = []
  cliKinds = null
  making = new Set()
  configure()

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

  on('classic.PostToolUse', postToolHook).catch(postToolCatch)
  on('classic.UserPromptSubmit', promptSubmitHook).catch(promptSubmitCatch)
  on('classic.StopFailure', stopFailureHook).catch(stopFailureCatch)

  on('session.end', sessionEnd)
}
