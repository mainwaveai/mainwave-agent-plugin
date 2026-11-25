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
// row waits for the session's identity, which Claude Code's rows carry.
//
// A third says what the plugin found wrong with the session's telemetry setup (`plugin_status`, setup.ts): one per session as its first
// turn ends, and again when that changes. When no row of Claude Code's reaches the plugin by then (a built-in plugin that runs first can
// send them on past it), the plugin's own rows and its markers go under the identity in Claude's account file instead, until a row
// names one.
//
// Where no row has reached the plugin by the time the first turn of a load begins (a built-in plugin runs first and sends them on
// past it), the plugin builds the rows Mainwave reads a session from out of Claude Code's own events instead (rowless.ts): a prompt
// row as each turn begins, a request row as each model request answers, and a decision and a result row for each tool call (its
// permission settled as `tool.check`, `tool.judge` and `tool.run` say), with what the session spends outside them in the cost metric. They go through the rebuild and the copy as Claude Code's rows would, under the
// host's identity or the account file's, so the spans and metrics go too. The first row of Claude Code's that comes ends it for the
// load, and a row seen before a reload keeps it from starting.

import { atom, read, update } from 'claude-code'
import type { CatchHandler, EngineInterface, Frozen, Hook, Next, Register, StreamHook, TelemetryAttribute, TelemetryLogResult, TelemetryRecordEntry, Timer, TurnStepResult } from 'claude-code'

import type { RowIdentity } from '../types'
import { captureCommit, capturePrompt, captureTool, dropStreamedText, loopKey, newCapture, rowFill, streamChunk, streamedText, streamedThinking, streamStart, type Capture } from './capture.ts'
import { MCP_SERVER_ROW, PLUGIN_STATUS_ROW, SKILL_PROMPT_ROW, type Switch } from './catalog.ts'
import { clientPlatformIn } from './client.ts'
import { HELPER_SOURCES, mcpParts } from './derive.ts'
import { allows, configureGate, currentGate, gateAttributes, gateMarker, gateMeasure, gateRow, gateSpan, metricAllowed, openGate, resetPacks, setOptIn, setOverrides, type RowFill } from './gate.ts'
import { classifyGlab, glabConfigDir, glabHosts, glabTexts, instanceOf, mrAttributes, mrFromApi, mrLookup, mrUrlOf, parseMrJson, repositoryIdOf, sameUrl, stripDraft, type MrDetails, type MrRef } from './glab.ts'
import { endSession } from './http.ts'
import { identityOf, isOrgId, mergeIdentity } from './identity.ts'
import { add, collect, newMeter, type Meter } from './meter.ts'
import {
  against, apiErrorIn, CHANGE_OPENED, cliCanSend, cliHookKinds, COMMIT_CREATED, commitAttributes, commitLookup, commitsInOutput, gitCommits, JIRA_TOOL, jiraTicket, KIND_SPAN, LINEAR_TOOL,
  linearTicket, MARKER_IDENTITY, MARKER_KEYS, markerResource, outputTexts, parseNumstat, parsePrStats, placeAttributes, prAttributes, prCreateOf, prLookup, prNumberOf, prUrlOf, STOP_FAILURE,
  opaqueId, STOP_FAILURE_ERROR, SUBSCRIPTION_SNAPSHOT, ticketSpan, type MarkerKind,
} from './markers.ts'
import { isCowork, isTruthy, parseResourceAttributes, type BuiltSpan, type CopiedRow } from './otlp.ts'
import {
  agentSpawned, callerCtx, commandEnd, commandStart, newRebuild, observeRow, parseTraceparent, promptDropped, promptSubmitted, randomHex, sessionStarted, takeReady, stepEnd, stepStart, sweep, toolEnd, toolJoinsTurn, toolStart, turnComplete, turnPrompted, turnStart, waits, type Emit, type Rebuild, type RowIn,
} from './rebuild.ts'
import {
  accountDeviceOf, agentLedgerOf, agentTranscriptPath, costOf, holdCost, runCostOf, decisionOf, decisionRow, headOf, hostIdentityOf, joinPath, madeCommit, newRowless, promptIdFrom, promptRow, providerOf, remoteSessionIdOf, repoAttributes, requestIdIn, requestRow, responseRow,
  handoffPrompt, handoverIn, helperRow, hostContinue, ledgerGrowth, permissionRules, personPrompt, responseTextOf, resultRow, rowHead, seedCost, sessionIdentityOf, stepRequestId, typedText, uuidOf, type Handover, type HostFacts, type HostIdentityEnv, type HelperFacts, type MadeCommit, type ModelTokens, type Rowless, type Verdict,
} from './rowless.ts'
import { applyStoredSettings, ensureFetching, noteSessionIdentity, resetOrgSettings, settingsPending, settingsSummary, settingsUnavailable } from './orgsettings.ts'
import { contentLimit } from './protect.ts'
import { adopt, collectorMalformed, collectorOf, configure, enqueue, ensureTimer, finish, isCopying, readOptions, snapshot } from './sender.ts'
import {
  approvalsOf, approved, permitted, DESKTOP_UNDER_APPDATA, DESKTOP_UNDER_HOME, distinct, enabledPlugins, fileServers, foldersUp, globalServers, join, managedDirs, manifestServerFiles, MAX_PLUGINS, parse,
  pluginServers, projectEntry, serverAttributes, toolSpelling, type Approvals, type McpServer,
} from './servers.ts'
import { accountIdentityOf, exporterOf, issuesOf, signedInElsewhere, signedInWithKey, type ExporterEnv, type SignInEnv } from './setup.ts'
import { snapshotOfText } from './snapshot.ts'
import { applyStamps, BUILT_FROM_STAMP, CLIENT_PLATFORM_STAMP, entrypointOf, filterStamps, issuesStamp, PLUGIN_NAME, stripOwned, type IssueCode } from './stamps.ts'
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
type ToolCheckParams = Parameters<Hook<'tool.check'>>
type ToolRunParams = Parameters<Hook<'tool.run'>>
type ToolRunCatchParams = Parameters<CatchHandler<Hook<'tool.run'>>>
type ToolJudgeParams = Parameters<Hook<'tool.judge'>>
type MeasureParams = Parameters<Hook<'session.measure'>>
type PromptParams = Parameters<Hook<'prompt.submit'>>
type PromptCatchParams = Parameters<CatchHandler<Hook<'prompt.submit'>>>
type CommandParams = Parameters<Hook<'command.run'>>
type CommandCatchParams = Parameters<CatchHandler<Hook<'command.run'>>>
type SpawnParams = Parameters<Hook<'agent.spawn'>>
type SpawnCatchParams = Parameters<CatchHandler<Hook<'agent.spawn'>>>
type SkillParams = Parameters<Hook<'skill.prompt'>>
type SkillCatchParams = Parameters<CatchHandler<Hook<'skill.prompt'>>>
type AppendParams = Parameters<Hook<'session.append'>>
type AppendCatchParams = Parameters<CatchHandler<Hook<'session.append'>>>

/**
 * The calls on `$` the floor's declarations (2.1.326) may not type as the latest Claude Code declares them: `$.session.info()`, a range of a file, the
 * session's newest messages. Each call is spelled on `$` as ever, typed through this so the type check holds on the floor's
 * declarations too; on an engine without one, the call throws, and its caller catches.
 */
type Newer = {
  session: {
    info: () => Promise<{ promptId?: string; transcriptPath?: string; platform?: string }>
    messages: (args: { last: number }) => Promise<readonly { role: string; uuid?: string; text?: unknown; toolResults?: readonly unknown[] }[] | { deny: string }>
  }
  fs: { read: (path: string, range: { offset: number; length: number }) => Promise<string> }
}

/** The session's identity as its rows say (types/index.d.ts). */
const identityAtom = atom({ plugin: 'mainwave', key: 'identity' } as const, {})
/** Whether this process has counted its session in `claude_code.session.count` (types/index.d.ts): once, whatever reloads. */
const sessionCountedAtom = atom({ plugin: 'mainwave', key: 'sessionCounted' } as const, false)
const rowsSeenAtom = atom({ plugin: 'mainwave', key: 'rowsSeen' } as const, false)

/** Claude Code's metric export interval when `OTEL_METRIC_EXPORT_INTERVAL` names none. */
export const METRIC_INTERVAL_MS = 60_000
/** How often records waiting for their pair are looked at. */
export const SWEEP_MS = 1_000
const ROUTE = filterStamps({ 'mainwave.telemetry.route': 'plugin' }).kept
const BUILT = filterStamps({ 'mainwave.telemetry.route': 'plugin', [BUILT_FROM_STAMP]: 'events' }).kept
/** What every span and measure the plugin sends carries: its route, and while it builds the rows itself, that it does. */
const routeStamps = () => (rowless ? BUILT : ROUTE)

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

/** Whether a row of Claude Code's has reached the plugin this load. */
let rowSeen = false
/** No row of Claude Code's reaches the plugin: it builds them from Claude Code's events (rowless.ts), until one does. */
let rowless = false
let rowlessState: Rowless = newRowless()
/** Whether this Claude Code hands the plugins a row as each loads (`plugin_loaded`, 2.1.326 on), asked once per load. */
let rowsAtLoad: Promise<boolean> | null = null
/** Model requests streaming now, the main loop's and subagents': a cost the session adds while none is belongs to none of them. */
let stepsInFlight = 0
/**
 * The model request streaming now in each loop whose rows the plugin builds, by loop (`loopKey`): where its transcript is and how long
 * it was as the request began, and the ID of the last row of the model's the loop's conversation kept since (`session.append`).
 */
let stepRows = new Map<string, StepRows>()
/**
 * The WebFetch and WebSearch calls running now whose rows the plugin builds, by call, with the loop each runs in: each makes a model
 * request of its own in its run (`HELPER_SOURCES`), whose share of the session's cost is read from its run's start to its end.
 */
let helperRuns = new Map<string, { agentId?: string }>()
/**
 * Each subagent's ledger (`$.agent.list()`'s tokens by model) as last read while such a call of its runs: as the first of them begins
 * to run, and again as each ends, so what the ledger grew by is the requests' of the calls that ran (`ledgerGrowth`).
 */
let agentLedgers = new Map<string, Promise<ModelTokens[] | undefined>>()
/** The subagents whose ledger is read once the step streaming now in their loop ends: a call it asked for began to run before it did. */
let ledgerWaits = new Set<string>()
/** The built rows of the requests whose ID is looked for in the transcript, sent in order as each is found: a turn's end waits for them. */
let requestRows: Promise<void> = Promise.resolve()
let requestRowsPending = 0
/** The main loop's last built rows in that chain: a main-loop turn's end waits for these alone. */
let mainRequestRows: Promise<void> = Promise.resolve()
/** The session is ending: a request's rows still looking for their ID read the transcript once more, then go without it. */
let requestIdsEnding = false
/** The request IDs the built rows carried lately: a transcript's ID goes on one request alone. */
let requestIdsUsed: string[] = []
/** The grace found no row: the rows are built from the next main-loop turn on, never from the middle of one. */
let rowlessPending = false
/** When this load first ran a hook, in `$.clock.now()`'s milliseconds: a session that began well before has its cost sent already. */
let loadedAtMs: number | undefined
/** The readings of the session's cost, taken one at a time, in order (`takeCost`). */
let costChain: Promise<unknown> = Promise.resolve()
/** Since when the next reading of the cost seeds the shares (`seedCost`): the load, or the change of session; and the baseline before. */
let seedSince: { atMs?: number; previous?: number } = {}
/** `OTEL_RESOURCE_ATTRIBUTES`, read once per load: Claude Code puts them first on each of its rows. */
let resourceAttrs: Promise<Record<string, string>> | null = null
/**
 * The text of the last prompt submitted while the session was idle (no turn running) that runs no slash command, until the main-loop
 * turn it starts begins. A host may start that turn with no text of its own (`turn.start`'s `''`), as a continuation's: the turn
 * takes this text instead, for its prompt row and its interaction.
 */
let idleSubmitted: { text: string } | undefined
/** A main-loop turn is running, from its `turn.start` to its `turn.complete`: a prompt submitted then is not one a turn starts with. */
let mainTurnOpen = false
/** A main-loop turn has begun in this load. */
let mainTurnSeen = false
/**
 * The load's first main-loop turn, begun with no text and no prompt at the transcript's end: its prompt row is built at its first model
 * request, whose messages the transcript holds by then, timed at the turn's start. The turn may be the rest of one begun before the
 * plugin's hooks were in place (as in Cowork): there the prompt is read back past the turn's calls.
 */
let promptLater: { turnId: string; atMs: number } | undefined
/** How many of the transcript's newest messages a turn begun with no text reads back for its prompt (`personPrompt`). */
const TRANSCRIPT_WALK = 500
/**
 * Main-loop calls that ran before the load's first turn began, while the plugin builds the rows: as in Cowork, where Claude Code runs
 * the call the chat part of the conversation left without its result as it takes the conversation over, just before the turn that
 * call is part of starts. Their rows wait for that turn's prompt row, so they carry its prompt (`releaseEarlyCalls`).
 */
let earlyCalls: CallRows[] = []
const MAX_EARLY_CALLS = 50
/** A main-loop call began before the load's first turn, in Cowork: a handover's first turn may take the person's carried-over message. */
let earlySeen = false
/** When each of those calls began, by its id, while it runs: the first turn's prompt row is timed no later (`earliestStart`). */
let earlyRunning = new Map<string, number>()
/** When each tool call the plugin builds rows for began, by its id, until it ends. */
let callStarts = new Map<string, number>()
/** The permission check's verdict on each of those calls (`allow`, `deny` or `ask`), by its id, until it ends. */
let verdicts = new Map<string, Verdict>()
/** What auto mode's classifier answered about each of those calls it was asked about (`tool.judge`), by its id, until it ends. */
let judgments = new Map<string, string>()
/** When each of those calls began to run, allowed (`tool.run`), by its id, until it ends. */
let runs = new Map<string, number>()
/** For a call allowed after an ask: whether the check now allows it outright (the permission was saved), by its id, until it ends. */
let saved = new Map<string, Promise<boolean | undefined>>()
/** The session's repository, as its `origin` remote names it, for the rows built: read as each main-loop turn begins. */
let repoNow: Promise<Record<string, string>> | null = null
/** Each subagent's type and whether Claude Code ships it, by its id, as its spawn said. */
let agentTypes = new Map<string, { type: string; builtIn: boolean }>()
/** Where the session's requests go and whether a person types into it, read once per load. */
let hostFacts: Promise<HostFacts> | null = null
/** The session takes no input from a person, as its start said. */
let nonInteractive = false
/** In a session on a key of its own, the account file's device ID alone, for the rows built: no one is named. */
let keyDevice: Promise<Record<string, string>> | null = null
const MAX_VERDICTS = 500
/** The session's identity from Claude's account file, read once; and in use, once a turn ended with no row of Claude Code's seen. */
let account: Promise<Record<string, string>> | null = null
let accountCommon: Record<string, string> | undefined
/** The session's status: when its first main-loop turn ended, the codes last queued, how many rows, the check waiting for rows. */
let firstTurnAtMs: number | undefined
let lastIssues: string | undefined
let statusRows = 0
let statusTimer: Timer | null = null
/** When this load's first model request ended: each one raises a row, so none seen past the grace means rows don't reach the plugin. */
let firstStepAtMs: number | undefined
/** Counts the status's resets: a check that began before a /clear queues nothing for the session after it. */
let statusEpoch = 0

/**
 * One of the plugin's own rows; `text`, for a skill's row, the text it carries, marked sent once the row is queued; `issues`, for the
 * status row, its codes, stamped as it is queued.
 */
type OwnRow = { event: string; atMs: number; attributes: Record<string, TelemetryAttribute>; text?: string; issues?: readonly IssueCode[] }
/** A marker (markers.ts), waiting for the session's identity like an own row; `account`, a snapshot's, sent only for the session's. */
type OwnMarker = { kind: MarkerKind; name: string; atMs: number; attributes: Record<string, TelemetryAttribute>; account?: string; session?: TelemetryAttribute }
/** The markers waiting for the session's identity; and, once read for this load, the kinds whose markers the CLI's hooks send. */
let markers: OwnMarker[] = []
let cliKinds: Promise<ReadonlySet<MarkerKind>> | null = null
/** The kinds whose CLI hook runs with its script on this machine, key or not: read once per load, for the status's code too. */
let cliHooks: Promise<ReadonlySet<MarkerKind>> | null = null
/** The marker work under way, beside the calls and prompts it came from: the session's end waits a little for it. */
let making = new Set<Promise<void>>()

/** How many own rows wait at most; how many skill texts keep their ID; how long, and how many, arguments are remembered. */
const MAX_OWN = 1_000
const MAX_SKILL_TEXTS = 200
const ARGS_MS = 60_000
const MAX_ARGS = 20
const MAX_PENDING = 50
/** How long after the first turn's end rows may still come before the plugin counts them as not reaching it; status rows at most. */
export const STATUS_GRACE_MS = 5_000
const MAX_STATUS_ROWS = 10
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
 * Claude Code sends it), the length limit, the organization's settings in the store (its explicit settings and what it gives in force), and the data points the person opts in to in their own
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

/**
 * Whether the repository goes on the records the plugin builds where no row comes: only where its data point is on in its own right,
 * as for everything else the plugin reads itself. Claude Code would add it only with its own switch on, and none of its rows come.
 */
function builtRepoAllowed(gate: ReturnType<typeof currentGate>): boolean {
  return allows(gate, 'repo', false)
}

/** Attributes without the repository's (`vcs.*`): what the plugin built, where the repository may not go on it. */
function withoutRepo<T>(attributes: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(attributes).filter(([k]) => !k.startsWith('vcs.')))
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
    // While the rows are built and the organization's settings have yet to first answer, everything is built: what goes is decided
    // once the answer is in (`emit`).
    gate: () => (rowless && settingsPending() !== undefined ? openGate() : currentGate()),
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
  if (out.spans.length === 0 && out.measures.length === 0) return
  // Built while the organization's settings have yet to first answer: it waits for the answer, as a row's copy does.
  const pending = rowless ? settingsPending() : undefined
  if (pending !== undefined) {
    ensureTimer($)
    holdCopy($, pending, () => emitNow($, out, true))
    return
  }
  await emitNow($, out, rowless)
}

/**
 * Queues spans and measures through the gate in force. `built`, what the plugin built where no row comes: strictly, only what is on
 * in its own right, as for what it reads itself into a row, and with the repository only where it may go on what the plugin builds.
 */
async function emitNow($: EngineInterface, out: Emit, built: boolean): Promise<void> {
  const gate = await gateOf($)
  const strip = built && !builtRepoAllowed(gate)
  for (const m of out.measures) {
    const attributes = strip ? withoutRepo(m.attributes) : m.attributes
    if (metricAllowed(gate, m.name, built)) add(meter, { ...m, attributes: { ...gateMeasure(gate, m.name, attributes, built), ...routeStamps() } })
  }
  for (const span of out.spans) {
    const gated = gateSpan(gate, strip ? { ...span, attributes: withoutRepo(span.attributes) } : span, built)
    await enqueue($, { s: 'traces', d: { ...gated, attributes: { ...gated.attributes, ...routeStamps() } } })
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
  if (r === null) return
  const common = Object.keys(r.common).length > 0 ? r.common : await accountCommonOf($)
  if (common === undefined) return
  if (endedSession !== undefined && common['session.id'] === endedSession) return
  endedSession = undefined
  // This session's sets: a /clear while a row is being queued starts new ones, which the old session's texts stay out of.
  const sent = textsSent
  const waiting = textsWaiting
  const gate = await gateOf($)
  entrypoint ??= readEntrypoint($)
  const ep = await entrypoint
  for (let o = own.shift(); o !== undefined; o = own.shift()) {
    const at = new Date(o.atMs).toISOString()
    const attributes = {
      ...applyStamps({ ...(rowless && !builtRepoAllowed(gate) ? withoutRepo(common) : common), 'event.name': o.event, 'event.timestamp': at, ...o.attributes }, {
        'mainwave.plugin.name': PLUGIN_NAME, 'mainwave.plugin.version': VERSION, 'mainwave.plugin.entrypoint': ep, 'mainwave.telemetry.route': 'plugin',
      }),
      ...issuesStamp(o.issues ?? []),
    }
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
      await sendMarker($, common, m, ep)
    } catch {
      // That marker is lost to the copy alone.
    }
  }
}

/** The session's id as the engine gives it; undefined when it can't be read. */
async function sessionIdOf($: EngineInterface): Promise<string | undefined> {
  try {
    const id = await $.session.id()
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}

/** What the plugin's own rows carry while no row of Claude Code's names the session: the account file's identity and the session's id. */
async function accountCommonOf($: EngineInterface): Promise<Record<string, string> | undefined> {
  if (accountCommon === undefined) return undefined
  const id = await sessionIdOf($)
  return { ...accountCommon, ...(id !== undefined ? { 'session.id': id } : {}) }
}

/** Claude's account file: `.claude.json` in `CLAUDE_CONFIG_DIR`, else the home folder, as Claude Code keeps it; undefined when there is none. */
async function readAccountFile($: EngineInterface): Promise<unknown> {
  const [home, profile, configDir] = await Promise.all([settle($.env.get('HOME')), settle($.env.get('USERPROFILE')), settle($.env.get('CLAUDE_CONFIG_DIR'))])
  const base = configDir || home || profile || undefined
  return base === undefined ? undefined : parse(await readText($, join(base, '.claude.json')))
}

/**
 * No row of Claude Code's reached the plugin: its own rows go under the session's identity as Claude Code reads it, the host's
 * variables (rowless.ts), else Claude's account file, and the organization's settings are asked for with it. A row that names the
 * session later takes over (`stampRow`).
 */
async function adoptAccount($: EngineInterface): Promise<void> {
  const [signIn, settings, hostEnv] = await Promise.all([readSignInEnv($), mergedSettings($), readHostIdentityEnv($)])
  // A session on a key or a provider of its own has no account to name. One a host hands its OAuth token goes under the account the
  // host names; the account file's login may then be someone else's.
  if (signedInWithKey(signIn, settings)) {
    // Still the installation's device ID, which Claude Code's rows carry whoever is signed in.
    keyDevice ??= readAccountFile($).then(accountDeviceOf, () => ({}))
    return
  }
  const host = hostIdentityOf(hostEnv)
  const elsewhere = signedInElsewhere(signIn, settings)
  if (elsewhere && host['organization.id'] === undefined) return
  // Signed in another way, the file's login says nothing of the session; its device ID, kept per installation, still does.
  account ??= readAccountFile($).then(elsewhere ? accountDeviceOf : accountIdentityOf, () => ({}))
  const who = sessionIdentityOf(host, await account)
  if (rowSeen || who['organization.id'] === undefined || who['user.email'] === undefined) return
  accountCommon = who
  try {
    await noteSessionIdentity($, { organizationId: who['organization.id'], email: who['user.email'] }, isCopying)
  } catch {
    // The settings in force stand.
  }
}

/** The variables a host sets to say who the session is, each spelled out. */
async function readHostIdentityEnv($: EngineInterface): Promise<HostIdentityEnv> {
  const [org, email, accountId] = await Promise.all([
    settle($.env.get('CLAUDE_CODE_ORGANIZATION_UUID')),
    settle($.env.get('CLAUDE_CODE_USER_EMAIL')),
    settle($.env.get('CLAUDE_CODE_ACCOUNT_UUID')),
  ])
  return { CLAUDE_CODE_ORGANIZATION_UUID: org, CLAUDE_CODE_USER_EMAIL: email, CLAUDE_CODE_ACCOUNT_UUID: accountId }
}

/** The variables that sign a session in another way than the account file's login, each spelled out. */
async function readSignInEnv($: EngineInterface): Promise<SignInEnv> {
  const [apiKey, authToken, oauthToken, oauthFd, refresh, apiKeyFd, gateway, gatewayFd, bedrock, vertex, foundry] = await Promise.all([
    settle($.env.get('ANTHROPIC_API_KEY')),
    settle($.env.get('ANTHROPIC_AUTH_TOKEN')),
    settle($.env.get('CLAUDE_CODE_OAUTH_TOKEN')),
    settle($.env.get('CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR')),
    settle($.env.get('CLAUDE_CODE_OAUTH_REFRESH_TOKEN')),
    settle($.env.get('CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR')),
    settle($.env.get('CLAUDE_CODE_GATEWAY_TOKEN')),
    settle($.env.get('CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR')),
    settle($.env.get('CLAUDE_CODE_USE_BEDROCK')),
    settle($.env.get('CLAUDE_CODE_USE_VERTEX')),
    settle($.env.get('CLAUDE_CODE_USE_FOUNDRY')),
  ])
  return {
    ANTHROPIC_API_KEY: apiKey, ANTHROPIC_AUTH_TOKEN: authToken, CLAUDE_CODE_OAUTH_TOKEN: oauthToken, CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: oauthFd,
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refresh, CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: apiKeyFd, CLAUDE_CODE_GATEWAY_TOKEN: gateway,
    CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: gatewayFd, CLAUDE_CODE_USE_BEDROCK: bedrock, CLAUDE_CODE_USE_VERTEX: vertex, CLAUDE_CODE_USE_FOUNDRY: foundry,
  }
}

/** The exporter's variables, each spelled out: the engine lists the variables a module reads from its calls. */
async function readExporterEnv($: EngineInterface): Promise<ExporterEnv> {
  const [on, endpoint, logs, metrics, traces, headers, logsHeaders, metricsHeaders, tracesHeaders] = await Promise.all([
    settle($.env.get('CLAUDE_CODE_ENABLE_TELEMETRY')),
    settle($.env.get('OTEL_EXPORTER_OTLP_ENDPOINT')),
    settle($.env.get('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')),
    settle($.env.get('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT')),
    settle($.env.get('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')),
    settle($.env.get('OTEL_EXPORTER_OTLP_HEADERS')),
    settle($.env.get('OTEL_EXPORTER_OTLP_LOGS_HEADERS')),
    settle($.env.get('OTEL_EXPORTER_OTLP_METRICS_HEADERS')),
    settle($.env.get('OTEL_EXPORTER_OTLP_TRACES_HEADERS')),
  ])
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: on, OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: logs, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: metrics,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: traces, OTEL_EXPORTER_OTLP_HEADERS: headers, OTEL_EXPORTER_OTLP_LOGS_HEADERS: logsHeaders,
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: metricsHeaders, OTEL_EXPORTER_OTLP_TRACES_HEADERS: tracesHeaders,
  }
}

/**
 * What is wrong with the session's telemetry setup now (setup.ts). `graceElapsed`: rows had their time to come (the grace's timer, the
 * session's end). The environment is read each time: an env block in managed settings can arrive after the first turn.
 */
async function setupIssues($: EngineInterface, graceElapsed: boolean): Promise<IssueCode[]> {
  const gate = await gateOf($)
  const [settings, env, now, cli] = await Promise.all([mergedSettings($), readExporterEnv($), $.clock.now(), cliHooksOf($)])
  // Only once a model request has ended: a turn that asks no model (a local command) raises no row.
  const rowsSkipped = !rowSeen && firstStepAtMs !== undefined && (graceElapsed || now - firstStepAtMs >= STATUS_GRACE_MS)
  return issuesOf({
    rowsSkipped,
    cliHooks: cli.size > 0,
    cliKeyed: cliCanSend(env.OTEL_EXPORTER_OTLP_ENDPOINT, env.OTEL_EXPORTER_OTLP_HEADERS, settings['otelHeadersHelper']),
    exporter: exporterOf(env, settings),
    settingsUnavailable: settingsUnavailable(),
    redactionHeld: 'held' in gate.redaction ? gate.redaction.held : undefined,
    dropped: snapshot().dropped,
  })
}

/**
 * Queues the status row, once the session's first main-loop turn has ended: the first time whatever it says, then only when what it
 * says changed, `MAX_STATUS_ROWS` at most.
 */
async function checkStatus($: EngineInterface, graceElapsed = false): Promise<void> {
  if (!isCopying() || firstTurnAtMs === undefined) return
  // Neither a row nor a model request yet: nothing is known of whether rows reach the plugin, and nothing names the session.
  if (!rowSeen && firstStepAtMs === undefined) return
  const epoch = statusEpoch
  const issues = await setupIssues($, graceElapsed)
  if (issues.includes('rows_skipped') && accountCommon === undefined) await adoptAccount($)
  // No row came by the grace though one was due: the rows are built from the next turn on, if they were not already.
  if (issues.includes('rows_skipped') && !rowless && !rowSeen) rowlessPending = true
  // A /clear or a resume while this ran: what it found is the ended session's, and the next one checks for itself.
  if (epoch !== statusEpoch) return
  const key = issues.join(',')
  if (key === lastIssues || statusRows >= MAX_STATUS_ROWS) return
  lastIssues = key
  statusRows += 1
  await queueOwn($, [{ event: PLUGIN_STATUS_ROW, atMs: await $.clock.now(), attributes: {}, issues }])
}

/**
 * A main-loop turn ended: the status is checked. While no row has been seen and the first model request ended less than
 * `STATUS_GRACE_MS` ago, the first check waits for the grace to pass, as a row can trail its request.
 */
async function statusAtTurnEnd($: EngineInterface): Promise<void> {
  if (!isCopying()) return
  const now = await $.clock.now()
  firstTurnAtMs ??= now
  if (!rowSeen && lastIssues === undefined && firstStepAtMs !== undefined && now - firstStepAtMs < STATUS_GRACE_MS) {
    // The grace has passed when this runs, whatever the clock reads: a timer can fire a millisecond early.
    statusTimer ??= $.clock.after(firstStepAtMs + STATUS_GRACE_MS - now, () => {
      statusTimer = null
      void checkStatus($, true).catch(() => undefined)
    })
    return
  }
  await checkStatus($)
}

/** The status starts over, for a new session or a new load. */
function resetStatus(): void {
  statusEpoch += 1
  statusTimer?.cancel()
  statusTimer = null
  firstTurnAtMs = undefined
  lastIssues = undefined
  statusRows = 0
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

/**
 * Whether a regular file is at a path (a link followed), as the CLI's hook command tests it (`[ -f "$f" ]`): its metadata alone, never
 * its contents. A script there that can't be read counts as there, as it does for that test: the CLI's hook then fails and sends
 * nothing, and so does the plugin. That is the price of never reading it.
 */
async function isFile($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
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
    const [endpoint, headers] = await Promise.all([settle($.env.get('OTEL_EXPORTER_OTLP_ENDPOINT')), settle($.env.get('OTEL_EXPORTER_OTLP_HEADERS'))])
    if (!cliCanSend(endpoint, headers, settings['otelHeadersHelper'])) return new Set<MarkerKind>()
    return cliHooksOf($)
  })().catch(() => new Set<MarkerKind>())
  return cliKinds
}

/**
 * The kinds of marker whose CLI hook the merged settings run with its script on this machine, read once per load, whether or not the
 * CLI has a key to send with: those its hooks would send. Where the CLI was never installed its hook command does nothing.
 */
async function cliHooksOf($: EngineInterface): Promise<ReadonlySet<MarkerKind>> {
  cliHooks ??= (async () => {
    const [settings, home] = await Promise.all([mergedSettings($), settle($.env.get('HOME'))])
    const out = new Set<MarkerKind>()
    const there = new Map<string, Promise<boolean>>()
    for (const [kind, scripts] of cliHookKinds(settings, home || undefined)) {
      for (const script of scripts) {
        if (!there.has(script)) there.set(script, isFile($, script))
        if (await there.get(script)) {
          out.add(kind)
          break
        }
      }
    }
    return out
  })().catch(() => new Set<MarkerKind>())
  return cliHooks
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

/**
 * The session a marker was made in: the one the engine names as its event runs (`$.session.id()`), else the one the plugin's rows
 * last named. The engine's is right even just after a /clear, before any row of the new session has come.
 */
async function sessionOf($: EngineInterface): Promise<TelemetryAttribute | undefined> {
  const named = opaqueId(await sessionIdOf($))
  if (named !== undefined) return named
  const r = await rebuildOf($)
  return r?.common['session.id']
}

/** What `$.session.info()` says of the session (the prompt it is on, its transcript); empty where it can't be read, or has no such call (2.1.325 and earlier). */
async function infoOf($: EngineInterface): Promise<{ promptId?: string; transcriptPath?: string }> {
  try {
    const info: unknown = await ($ as unknown as Newer).session.info()
    if (!isRecord(info)) return {}
    return {
      ...(typeof info['promptId'] === 'string' ? { promptId: info['promptId'] } : {}),
      ...(typeof info['transcriptPath'] === 'string' && info['transcriptPath'] !== '' ? { transcriptPath: info['transcriptPath'] } : {}),
    }
  } catch {
    return {}
  }
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
        platform = (await ($ as unknown as Newer).session.info()).platform
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

/** One tool call that ended, as the marker work reads it: the tool, its own arguments, the call's id and the subagent that made it. */
type EndedCall = { tool: string; input: Record<string, unknown>; toolUseId?: string; agentId?: string }

/** Whether a call can make a marker at all: a shell command that commits or opens a request, or a Linear or Jira save. */
function mayMark(call: EndedCall): boolean {
  if (call.tool === 'Bash') {
    const command = call.input['command']
    return typeof command === 'string' && (gitCommits(command).length > 0 || prCreateOf(command) !== undefined || classifyGlab(command) !== undefined)
  }
  return LINEAR_TOOL.test(call.tool) || JIRA_TOOL.test(call.tool)
}

/**
 * The markers of one tool call that ended: a shell command's commits, pull request and merge request; an MCP save's ticket. `response`
 * is the tool's record (`result`): Bash's `{ stdout, stderr }`, an MCP tool's content blocks. The folder a commit is looked up in is
 * the session's as the call ended.
 */
async function toolMarkers($: EngineInterface, call: EndedCall, response: unknown): Promise<void> {
  const [session, folder] = await Promise.all([sessionOf($), settle($.session.cwd())])
  const { tool, input, agentId } = call
  const cwd = folder || undefined
  const made: OwnMarker[] = []
  if (tool === 'Bash') {
    const command = input['command']
    if (typeof command !== 'string') return
    const calls = gitCommits(command)
    const pr = prCreateOf(command)
    const glab = classifyGlab(command)
    if (calls.length === 0 && pr === undefined && glab === undefined) return
    const place = await placeOf($, agentId, call.toolUseId)
    const texts = outputTexts(response)
    if (calls.length > 0) made.push(...(await commitMarkers($, calls, texts, cwd, place)))
    if (pr !== undefined) made.push(...(await prMarker($, pr.title, texts, place)))
    if (glab !== undefined) made.push(...(await mrMarker($, glab, response, place)))
  } else if (LINEAR_TOOL.test(tool) || JIRA_TOOL.test(tool)) {
    const linear = LINEAR_TOOL.test(tool)
    const ticket = linear ? linearTicket(tool, input, response) : jiraTicket(tool, response)
    if (ticket === undefined || !(await markerWanted($, linear ? 'linear' : 'jira'))) return
    made.push({ kind: linear ? 'linear' : 'jira', name: ticketSpan(ticket), atMs: await $.clock.now(), attributes: { ...ticket, ...(await placeOf($, agentId, call.toolUseId)) } })
  }
  await queueMarkers($, made, session)
}

/** The plan snapshot for a prompt, from Claude Code's account record, when its data point is on and the CLI's hook does not send it. */
async function snapshotMarker($: EngineInterface): Promise<void> {
  // The session and the prompt the session is on, before anything waits. A prompt typed into a running turn joins that turn's prompt:
  // its snapshot carries that prompt's ID, as UserPromptSubmit's `prompt_id` does.
  const [session, { promptId }] = await Promise.all([sessionOf($), infoOf($)])
  if (!(await markerWanted($, 'snapshot'))) return
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

/**
 * How much of the transcript's end is read for a failed turn's message, four times more at each read that does not find it (a large
 * line written after it, such as a pasted image's, can push it out), up to what one read takes; how often, and how long apart.
 */
export const TRANSCRIPT_TAIL_BYTES = 65_536
export const TRANSCRIPT_TRIES = 5
/** The most `$.fs.read` takes in one read: 4 MiB. */
const MAX_READ_BYTES = 4 * 1024 * 1024
export const TRANSCRIPT_RETRY_MS = 100

/**
 * The kind of API error a main-loop turn ended on: the `error` its transcript records on the message Claude Code wrote in place of
 * the failed response, the turn's last (StopFailure's). Read from the transcript's end, a few times while the line is not written yet;
 * undefined where there is no transcript, the last message records no API error, or it can't be read.
 */
async function turnErrorOf($: EngineInterface, transcriptPath: string, messageId: string): Promise<string | undefined> {
  for (let i = 0; i < TRANSCRIPT_TRIES; i++) {
    if (i > 0) await $.clock.sleep(TRANSCRIPT_RETRY_MS)
    try {
      const size = (await $.fs.stat(transcriptPath)).size
      const window = Math.min(TRANSCRIPT_TAIL_BYTES * 4 ** i, MAX_READ_BYTES)
      const text = await ($ as unknown as Newer).fs.read(transcriptPath, { offset: Math.max(0, size - window), length: window })
      const error = apiErrorIn(text, messageId)
      if (error !== null) return error
    } catch {
      // Not there yet, or not readable this time: read again.
    }
  }
  return undefined
}

/** The clients of the session's latest prompts, by prompt (`clientOf`): undefined where the prompt names none. */
const promptClients = new Map<string, string | undefined>()
/** How many prompts' clients are kept: a row of an earlier prompt's (a background task's) still finds its own. */
const PROMPT_CLIENTS_KEPT = 16

/**
 * The client a remote Cowork prompt was sent from (`clientPlatformIn`), read from the end of the session's transcript, where Cowork's
 * host writes it on the prompt's row and no event carries it: kept per prompt once read. `settle`: the prompt's row is written by now,
 * so the read goes further back, four times more at each read that does not find it, up to what one read takes, and a prompt with no
 * row of its own is kept as naming none; else only the end is read, and a prompt whose row isn't there is read again for its next row.
 * A read that fails keeps nothing. Undefined outside remote Cowork (the entry point `remote_cowork`), for no prompt, or where the
 * transcript can't be read.
 */
async function clientOf($: EngineInterface, promptId: unknown, settle: boolean): Promise<string | undefined> {
  if (typeof promptId !== 'string' || promptId === '') return undefined
  if (promptClients.has(promptId)) return promptClients.get(promptId)
  entrypoint ??= readEntrypoint($)
  if ((await entrypoint) !== 'remote_cowork') return undefined
  let found: string | undefined | null | false = null
  try {
    const { transcriptPath } = await infoOf($)
    if (transcriptPath === undefined) return undefined
    const size = (await $.fs.stat(transcriptPath)).size
    for (let window = TRANSCRIPT_TAIL_BYTES; ; window *= 4) {
      const length = Math.min(window, size, MAX_READ_BYTES)
      found = clientPlatformIn(await ($ as unknown as Newer).fs.read(transcriptPath, { offset: size - length, length }), promptId)
      if (found !== null || !settle || length >= size || length >= MAX_READ_BYTES) break
    }
  } catch {
    return undefined
  }
  const client = typeof found === 'string' ? found : undefined
  if (found === undefined || typeof found === 'string' || settle) {
    promptClients.set(promptId, client)
    for (const old of promptClients.keys()) if (promptClients.size > PROMPT_CLIENTS_KEPT) promptClients.delete(old)
  }
  return client
}

/** The stamp of a row's client (`clientOf`), by the prompt it carries: none where it has none. `settle` as `clientOf` takes it. */
async function clientStamp($: EngineInterface, attributes: Readonly<Record<string, TelemetryAttribute>>, settle: boolean): Promise<Record<string, string>> {
  const client = await clientOf($, attributes['prompt.id'], settle).catch(() => undefined)
  return client === undefined ? {} : { [CLIENT_PLATFORM_STAMP]: client }
}

/** The id of the session's last message where it is the model's (a failed turn's is the one Claude Code wrote in its place). */
async function lastAnswerId($: EngineInterface): Promise<string | undefined> {
  try {
    const last = await ($ as unknown as Newer).session.messages({ last: 1 })
    const message = Array.isArray(last) ? last.at(-1) : undefined
    return message?.role === 'assistant' && typeof message.uuid === 'string' && message.uuid !== '' ? message.uuid : undefined
  } catch {
    return undefined
  }
}

/** A main-loop turn ended on an API error: the kind of error, and nothing else of it, where the transcript says which. */
async function stopMarker($: EngineInterface, place: Record<string, TelemetryAttribute>): Promise<void> {
  // The session, its prompt and the failed turn's message as the turn ended, before anything waits; the message only where there is
  // a transcript to find it in, read as soon as that is known.
  const info = infoOf($)
  const [session, { promptId, transcriptPath }, messageId] = await Promise.all([
    sessionOf($), info, info.then(i => (i.transcriptPath === undefined ? undefined : lastAnswerId($))),
  ])
  if (transcriptPath === undefined || messageId === undefined || !(await markerWanted($, 'stop'))) return
  const atMs = await $.clock.now()
  const error = await turnErrorOf($, transcriptPath, messageId)
  if (error === undefined) return
  await queueMarkers($, [{ kind: 'stop', name: STOP_FAILURE, atMs, attributes: { [STOP_FAILURE_ERROR]: error, ...placeAttributes({ promptId }), ...place } }], session)
}

/** A new session in the same process (/clear, resume): what the last one queued goes under its identity, and this one starts over. */
async function nextSession($: EngineInterface): Promise<void> {
  await serversRead
  await flushOwn($)
  const r = await rebuildOf($)
  endedSession = r !== null && Object.keys(r.common).length > 0 ? r.common['session.id'] : (await accountCommonOf($))?.['session.id']
  // A status row that could not go under the ended session's identity says nothing of the next: it is let go.
  own = own.filter(o => o.event !== PLUGIN_STATUS_ROW)
  resetStatus()
  textIds = new Map()
  textsSent = new Set()
  textsWaiting = new Set()
  pendingArgs = new Map()
  // A new session starts its sequence over, and its first reading of the cost seeds the shares again: a resume's restored cost was
  // sent already, a /clear starts over or carries on. What the ended session spent last went as it ended.
  seedSince = { atMs: await $.clock.now(), ...(rowlessState.costUsd !== undefined ? { previous: rowlessState.costUsd } : {}) }
  rowlessState = newRowless()
  // The readings of a tool's run start over with the session's: a call still running has no row of its request.
  helperRuns = new Map()
  agentLedgers = new Map()
  ledgerWaits = new Set()
  await startServers($)
}

/**
 * Reads one row into the rebuild: the row's own attributes as Claude Code raised them, before any stamp. Answers what it produced
 * and the ids the row's copy carries, where the rebuild gives them; null when the plugin does not rebuild.
 */
async function observe($: EngineInterface, e: Frozen<TelemetryRecordEntry>, call?: string): Promise<(Emit & { rowCtx?: { traceId: string; spanId: string } }) | null> {
  const r = await rebuildOf($)
  if (r === null) return null
  const atMs = Date.parse(e.loggedAt)
  const span = e.span === undefined ? undefined : { traceId: e.span.traceId, spanId: e.span.spanId }
  return observeRow(r, { event: e.event, atMs: Number.isFinite(atMs) ? atMs : await $.clock.now(), ...(span ? { span } : {}), ...(call !== undefined ? { call } : {}), attributes: e.attributes })
}

/**
 * Stamps one collector row and queues the plugin's copy of it. A row that names an organization carries the plugin's name, version,
 * entry point and route (`exporter`), and in remote Cowork the client its prompt was sent from (`clientOf`); one that does not goes
 * on without any key the plugin owns. Either way the row goes on to the exporter, and the copy, where the plugin copies at all, is
 * queued with route `plugin`.
 */
export async function stampRow($: RowParams[0], e: RowParams[1], next: RowParams[2]): Promise<TelemetryLogResult> {
  // Rows reach the plugin: what they say of the session stands, not the account file's, and the rows are theirs, not built.
  if (!rowSeen) void update($, rowsSeenAtom, () => true).catch(() => undefined)
  rowSeen = true
  accountCommon = undefined
  endRowless()
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
      // Claude Code may log a prompt's own row as the prompt's row in the transcript is written: a row that follows it in the turn
      // reads again, and settles.
      ...(await clientStamp($, e.attributes, e.event !== 'user_prompt')),
    })
  } else {
    attributes = stripOwned(e.attributes)
  }
  if (isCopying()) await copyRow($, e, attributes)
  return next({ ...e, attributes })
}

/**
 * Reads one row into the rebuild and queues its copy, `attributes` its stamped attributes: a row of Claude Code's, or one the plugin
 * built from its events (`feedRow`). The rebuild reads the row first, so its copy carries the ids the plugin's spans give it. The copy
 * is the plugin's own: a fault in either never holds the exporter's row, and a fault in the rebuild never holds the copy. The row's
 * copy is queued before what the row completes, as the row came first.
 */
async function copyRow($: EngineInterface, e: Frozen<TelemetryRecordEntry>, attributes: Record<string, TelemetryAttribute>, built = false, given?: RowFill, call?: string): Promise<void> {
  let out: Awaited<ReturnType<typeof observe>> = null
  try {
    out = await observe($, e, call)
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
    // What the plugin read is taken now, for this row alone (a built row may bring its own). Where the organization's settings have
    // yet to first answer and nothing of theirs applies, the copy waits for them beside the row, a few seconds at most: the row goes on
    // at once.
    const fill = given ?? rowFill(capture, e.event, e.attributes)
    const copy = async () => {
      const gate = await gateOf($)
      // A row the plugin built carries the repository only where it may go on what the plugin builds.
      const gated = gateAttributes(gate, e.event, built && !builtRepoAllowed(gate) ? withoutRepo(attributes) : attributes, fill)
      await enqueue($, { s: 'logs', d: copyOf(e, gated, out?.rowCtx) })
    }
    const pending = settingsPending()
    if (pending === undefined) await copy()
    else {
      // The send timer runs from the row, as it would for a copy queued at once.
      ensureTimer($)
      holdCopy($, pending, copy)
    }
  } catch {
    // Lost to the copy alone.
  }
  if (out !== null) await emit($, out).catch(() => undefined)
  // The session's identity may be known now: the plugin's own rows waiting for it go, beside the row.
  if (own.length > 0 || markers.length > 0) void flushOwn($).catch(() => undefined)
}

/** How long a row's copy waits, at most, for the organization's settings to first answer. */
export const SETTINGS_WAIT_MS = 6_000
/** The copies waiting for the settings' first answer, and what ends their wait at once (the session's end). */
const heldCopies = new Set<Promise<void>>()
/** The last copy held: each goes after the one before, so they are queued in the order their rows came. */
let lastHeld: Promise<void> = Promise.resolve()
let releaseHeld: () => void = () => {}
let released = new Promise<void>(resolve => (releaseHeld = resolve))

/** Queues a row's copy once the settings have first answered, `SETTINGS_WAIT_MS` have passed, or the session ends. Never throws. */
function holdCopy($: EngineInterface, pending: Promise<void>, copy: () => Promise<void>): void {
  // A timer, not a sleep: a sleep is the row's hook's own, and ends with it.
  const limit = new Promise<void>(resolve => {
    try {
      const timer = $.clock.after(SETTINGS_WAIT_MS, () => resolve())
      void pending.then(() => timer.cancel())
    } catch {
      resolve()
    }
  })
  const before = lastHeld
  const p = Promise.race([pending, limit, released]).then(() => before).then(copy).catch(() => undefined)
  lastHeld = p
  heldCopies.add(p)
  void p.finally(() => heldCopies.delete(p))
}

/** The copies still waiting go now, through the settings in force: the session is ending. */
async function flushHeldCopies(): Promise<void> {
  releaseHeld()
  if (heldCopies.size > 0) await Promise.allSettled([...heldCopies])
  // After a /clear or a resume the process goes on: a later copy may wait again.
  released = new Promise<void>(resolve => (releaseHeld = resolve))
}

// ── Rowless: the rows built from Claude Code's events (rowless.ts) ──────────────────────────────────────────────────────────────

/** Whether the session's Claude Code hands each plugin a `plugin_loaded` row as it loads: 2.1.326 and later. */
async function readRowsAtLoad($: EngineInterface): Promise<boolean> {
  try {
    const { version } = await $.session.version()
    const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/).map(Number)
    return major * 1e6 + minor * 1e3 + patch >= 2_001_326
  } catch {
    return false
  }
}

/**
 * Builds the rows from Claude Code's events from now on: the rebuild builds the trace itself, and the session's identity is read
 * where Claude Code reads it. Never once a row of Claude Code's has come.
 */
async function startRowless($: EngineInterface): Promise<void> {
  if (rowless || rowSeen || !isCopying()) return
  rowless = true
  rowlessPending = false
  // The cost the session had before the rows began: none of it for the rows to carry where an earlier load or process sent it.
  await takeCost($, () => undefined).catch(() => undefined)
  if (accountCommon === undefined) await adoptAccount($).catch(() => undefined)
  const r = await rebuildOf($)
  if (r !== null && !rowSeen) r.rowless = true
}

/**
 * As a main-loop turn begins: where rows reach the plugin, one has come by now (each plugin's `plugin_loaded` as it loaded, and the
 * turn's prompt row before the turn), in this load or, before a reload, in this process. Where none has, a built-in plugin runs first
 * and sends them on past it, and the rows are built from here on. On a Claude Code that hands no row at load, the grace decides instead
 * (`checkStatus`).
 */
async function decideRowless($: EngineInterface): Promise<void> {
  if (rowless || rowSeen || !isCopying()) return
  // A load that sees no session start (a reload) begins here: the session began before it.
  loadedAtMs ??= await $.clock.now()
  if (rowlessPending) return startRowless($)
  rowsAtLoad ??= readRowsAtLoad($)
  if (!(await rowsAtLoad)) return
  const seenBefore = await read($, rowsSeenAtom).catch(() => false)
  if (seenBefore === true || rowSeen) return
  await startRowless($)
}

/**
 * The cost the session added while no model request of a turn streamed (a session title, a compaction, a memory or a suggestion
 * after a turn), sent as Claude Code's exporter sends the cost of requests outside the main loop: in `cost.usage`, `query_source`
 * `auxiliary`. Its model and tokens no event says. Nothing while a request streams, or a WebFetch or WebSearch call runs: its own row
 * takes what the session added. With `ending`, as the session ends, past a call still running, whose request then has no row.
 */
async function flushOutsideCost($: EngineInterface, ending = false): Promise<void> {
  const busy = () => stepsInFlight > 0 || (!ending && helperRuns.size > 0)
  if (!rowless || busy()) return
  const r = await rebuildOf($)
  if (r === null || Object.keys(r.common).length === 0) return
  const usd = await takeCost($, ({ costUsd }) => (busy() ? undefined : costOf(rowlessState, costUsd)))
  if (usd === undefined || usd <= 0) return
  const attributes = { ...r.common, query_source: 'auxiliary' }
  await emit($, { spans: [], measures: [{ name: 'claude_code.cost.usage', value: usd, attributes, atMs: await $.clock.now() }] })
}

/** The engine measured the session: a cost it added outside a turn's requests goes now. The measure goes on unchanged. */
export async function measureHook($: MeasureParams[0], e: MeasureParams[1], next: MeasureParams[2]) {
  try {
    if (rowless && (e as { changed?: readonly string[] }).changed?.includes('cost')) await flushOutsideCost($)
  } catch {
    // It goes with the next request's, or at the session's end.
  }
  return next(e)
}

/** Ends building the rows: a row of Claude Code's came, and the rows that follow are its. */
function endRowless(): void {
  if (!rowless) return
  rowless = false
  void rebuild?.then(r => (r.rowless = false)).catch(() => undefined)
}

/** The attributes the rows built now start with: the organization's resource attributes, the device, the session and who it is. */
async function rowlessHead($: EngineInterface): Promise<Record<string, TelemetryAttribute>> {
  resourceAttrs ??= settle($.env.get('OTEL_RESOURCE_ATTRIBUTES')).then(parseResourceAttributes, () => ({}))
  const facts = hostFactsOf($)
  entrypoint ??= readEntrypoint($)
  repoNow ??= readRepo($)
  const [resource, sessionId, host, device, ep, repo] = await Promise.all([resourceAttrs, sessionIdOf($), facts, keyDevice ?? {}, entrypoint, repoNow])
  // No person types into it: its start said so, or it runs under an SDK (`claude -p` among them), which a reload's load still knows.
  return rowHead(resource, accountCommon ?? device, sessionId, { ...host, nonInteractive: nonInteractive || ep.startsWith('sdk') }, repo)
}

/** Where the session's requests go and whether it is Cowork's, read once per load. */
function hostFactsOf($: EngineInterface): Promise<HostFacts> {
  hostFacts ??= Promise.all([
    readSignInEnv($), settle($.env.get('ANTHROPIC_BASE_URL')), settle($.env.get('CLAUDE_CODE_IS_COWORK')), settle($.env.get('CLAUDE_CODE_ENTRYPOINT')),
    settle($.env.get('CLAUDE_CODE_REMOTE_SESSION_ID')),
  ]).then(([signIn, baseUrl, isCoworkVar, ep, remote]) => {
    const remoteSessionId = remoteSessionIdOf(remote)
    return {
      provider: providerOf(signIn), customBaseUrl: (baseUrl ?? '').trim() !== '', nonInteractive: false,
      cowork: isCowork({ CLAUDE_CODE_IS_COWORK: isCoworkVar, CLAUDE_CODE_ENTRYPOINT: ep }),
      ...(remoteSessionId !== undefined ? { remoteSessionId } : {}),
    }
  })
  return hostFacts
}

/**
 * The person's message the transcript's newest turn began with (`personPrompt`, back past the turn's calls with `acrossCalls`), as the
 * text of a turn that began with none: what a host submitted before the plugin's hooks were in place. '' where the newest messages hold
 * none, or can't be read.
 */
async function transcriptPrompt($: EngineInterface, acrossCalls: boolean): Promise<string> {
  try {
    const newest = await ($ as unknown as Newer).session.messages({ last: TRANSCRIPT_WALK })
    return Array.isArray(newest) ? personPrompt(newest, acrossCalls) : ''
  } catch {
    return ''
  }
}

/** How much of the transcript's end is read for what Cowork's host marks on the rows of a handover from chat (`handoverOf`). */
const HANDOVER_TAIL_BYTES = 1_048_576

/**
 * What the end of the session's transcript says of a handover from chat (`handoverIn`): the fields Cowork's host writes on the rows,
 * which neither `$.session.messages` nor the hooks' events carry. Undefined where there is no transcript, or it can't be read.
 */
async function handoverOf($: EngineInterface): Promise<Handover | undefined> {
  try {
    const { transcriptPath } = await infoOf($)
    if (transcriptPath === undefined) return undefined
    const size = (await $.fs.stat(transcriptPath)).size
    const length = Math.min(size, HANDOVER_TAIL_BYTES)
    return handoverIn(await ($ as unknown as Newer).fs.read(transcriptPath, { offset: size - length, length }))
  } catch {
    return undefined
  }
}

/** The session's newest messages, read back for a handover's prompt (`handoffPrompt`); undefined where they can't be read. */
async function handoffWalk($: EngineInterface, host?: string): Promise<string | undefined> {
  try {
    const newest = await ($ as unknown as Newer).session.messages({ last: TRANSCRIPT_WALK })
    return Array.isArray(newest) ? handoffPrompt(newest, host) : undefined
  } catch {
    return undefined
  }
}

/**
 * The prompt of the load's first turn in Cowork, where Cowork handed the conversation over from chat; undefined where nothing shows a
 * handover, and the turn's text stands. By the fields the host writes on the transcript's rows (`handoverOf`), where they are there:
 *
 * - a turn whose text is the newest prompt row, one the host wrote after the handover (`textNotTyped`: its message asking to run the
 *   chat's last call, not run): the person's last message in chat, from the transcript, else read back through the session's messages
 *   past the host's; '' where neither finds one, as the host's text is never the person's;
 * - a turn begun with no text, whose newest prompt row is the person's message carried over (`handedOff`), after a call began before
 *   it (the cut-off call Claude Code runs as it takes the conversation over): that message. A later load's first turn, with no such
 *   call, never takes it, though the rows of a past handover still end the transcript until the person's next message is written.
 *
 * Without them: a turn whose text is the host's message by its words (`hostContinue`), after the call's not-run result, with the
 * handover's row in the transcript.
 */
async function handoverPrompt($: EngineInterface, text: string): Promise<string | undefined> {
  const t = await handoverOf($)
  if (t === undefined || !t.relay) return undefined
  if (text !== '' && t.hostWritten && t.newest !== undefined && typedText(t.newest).trim() === typedText(text).trim()) return t.person ?? (await handoffWalk($, text)) ?? ''
  if (text === '' && t.handedOff && t.person !== undefined && earlySeen) return t.person
  if (text !== '' && hostContinue(text)) return handoffWalk($)
  return undefined
}

/** The session's repository, as its `origin` remote names it (`repoAttributes`); none where it is in none, or it can't be read. */
async function readRepo($: EngineInterface): Promise<Record<string, string>> {
  try {
    const [repo, remote] = await Promise.all([$.session.repo(), settle($.env.get('CLAUDE_CODE_REMOTE'))])
    return repoAttributes(repo?.remote, { remoteSession: isTruthy(remote) })
  } catch {
    return {}
  }
}

/** How long the read of HEAD for a call's commit may take, after the call: its result row waits for it. */
export const HEAD_READ_MS = 500

/**
 * Where HEAD is in the repository the session is in: the git folder found from the session's directory up (a `.git` folder, or a
 * worktree's `.git` file naming its own), read with `$.fs`, as no host command runs in Cowork. Undefined where none is found.
 */
async function readHead($: EngineInterface): Promise<MadeCommit | undefined> {
  const read = async (path: string) => {
    const text = await $.fs.read(path)
    if (typeof text !== 'string') throw new Error('not text')
    return text
  }
  let dir = (await $.session.cwd()).replace(/\\/g, '/').replace(/\/+$/, '')
  for (let depth = 0; depth < 64 && dir !== ''; depth++) {
    const pointer = await read(`${dir}/.git`).catch(() => undefined)
    const gitDir = pointer !== undefined ? /^gitdir: (.+)$/m.exec(pointer)?.[1]?.trim() : undefined
    if (gitDir !== undefined) return headOf(joinPath(dir, gitDir), read)
    if (await read(`${dir}/.git/HEAD`).then(() => true, () => false)) return headOf(`${dir}/.git`, read)
    const up = dir.slice(0, dir.lastIndexOf('/'))
    if (up === dir) break
    dir = up
  }
  return undefined
}

/** A row built from Claude Code's events, as Claude Code's own go: stamped (its prompt's client among them), through the rebuild, and copied. */
async function feedRow($: EngineInterface, row: RowIn, fill?: RowFill): Promise<void> {
  // A tool's own request names its call, which the rebuild puts it under; the row's copy carries no more than Claude Code's.
  entrypoint ??= readEntrypoint($)
  const ep = await entrypoint
  const e = { to: 'collector', event: row.event, attributes: row.attributes, loggedAt: new Date(row.atMs).toISOString() } as Frozen<TelemetryRecordEntry>
  const attributes = applyStamps(row.attributes, {
    'mainwave.plugin.name': PLUGIN_NAME, 'mainwave.plugin.version': VERSION, 'mainwave.plugin.entrypoint': ep, [BUILT_FROM_STAMP]: 'events',
    // Built at the turn's start or later, when the prompt's row in the transcript is written.
    ...(await clientStamp($, row.attributes, true)),
  })
  await copyRow($, e, attributes, true, fill, row.call)
}

/** Claude Code's id of the prompt the session is on, so the rows built of its turn carry the one its own records do; undefined where it can't be read. */
async function promptIdOf($: EngineInterface): Promise<string | undefined> {
  try {
    return promptIdFrom(await ($ as unknown as Newer).session.info())
  } catch {
    return undefined
  }
}

/** The session's cost so far and when it began, as `$.session.usage()` reads them; each undefined where it can't be read. */
async function usageOf($: EngineInterface): Promise<{ startedAt?: number; costUsd?: number }> {
  try {
    const usage = await $.session.usage()
    const usd = usage.cost?.usd
    return {
      ...(typeof usage.startedAt === 'number' ? { startedAt: usage.startedAt } : {}),
      ...(typeof usd === 'number' && Number.isFinite(usd) ? { costUsd: usd } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Reads the session's cost and applies `take` to it, one reading at a time, in the order asked: so no reading is taken against a later
 * one's baseline, and the shares never sum past the session's cost.
 */
function takeCost<T>($: EngineInterface, take: (usage: { startedAt?: number; costUsd?: number }, nowMs: number) => T): Promise<T> {
  const next = costChain.then(async () => {
    const [usage, now] = await Promise.all([usageOf($), $.clock.now()])
    // The first reading since the rows began, or since the session changed, says where the shares start.
    seedCost(rowlessState, usage, seedSince.atMs ?? loadedAtMs ?? now, seedSince.previous)
    return take(usage, now)
  })
  costChain = next.catch(() => undefined)
  return next
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
      // For the rows the plugin builds, where none comes: Claude Code's terminal type for a session no person types into.
      nonInteractive = (e as { isInteractive?: unknown }).isInteractive === false
      loadedAtMs ??= await $.clock.now()
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

/** A main-loop turn's prompt row, built where none comes: what the session spent between turns (a compaction, a suggestion) goes first. */
async function buildPromptRow($: EngineInterface, text: string, atMs: number): Promise<void> {
  await flushOutsideCost($).catch(() => undefined)
  await feedRow($, promptRow(rowlessState, await rowlessHead($), text, atMs, (await promptIdOf($)) ?? uuidOf(randomHex(32))))
}

/** The person's message as a main-loop turn takes it: in Cowork, without the blocks Cowork puts ahead of what the person typed. */
async function turnText($: EngineInterface, text: string): Promise<string> {
  return text !== '' && (await hostFactsOf($)).cowork === true ? typedText(text) : text
}

/**
 * The first model request of the load's first turn, where that turn began with no prompt at the transcript's end: the request's
 * messages are in the transcript now, the person's among them, read back past what the turn has done (a turn begun before the plugin's
 * hooks were in place). Its prompt row goes before the request's rows, timed at the turn's start (or the start of a call that ran
 * before it began, if earlier), and the turn's interaction takes its text. The rows of the calls that ran before the turn began follow
 * it.
 */
async function promptAtFirstStep($: EngineInterface, e: { turnId: string; agentId?: string }): Promise<void> {
  const later = promptLater
  if (later === undefined || e.agentId !== undefined || e.turnId !== later.turnId) return
  promptLater = undefined
  const r = await rebuildOf($)
  try {
    if (r === null || !rowless) return
    const text = await turnText($, await transcriptPrompt($, true))
    if (text === '') return
    if (isCopying()) capturePrompt(capture, text)
    turnPrompted(r, e.turnId, text)
    await buildPromptRow($, text, earliestStart(later.atMs))
  } finally {
    await releaseEarlyCalls($, r)
  }
}

/** A main-loop turn began: an interaction opens. */
export async function turnStartHook($: TurnStartParams[0], e: TurnStartParams[1], next: TurnStartParams[2]) {
  let out: Emit | null = null
  // A main-loop turn takes the prompt submitted while the session was idle, if one was, whatever text it starts with.
  const submitted = e.agentId === undefined ? idleSubmitted?.text : undefined
  if (e.agentId === undefined) {
    idleSubmitted = undefined
    mainTurnOpen = true
    promptLater = undefined
  }
  try {
    // The turn's prompt: its own text, else (a host that starts the turn with none) the prompt submitted to start it, else, for the
    // load's first turn, the person's message the transcript's newest turn began with (a host can submit it before the plugin's hooks
    // are in place). In Cowork, without the blocks Cowork puts ahead of what the person typed, as Claude Code's own prompt rows go.
    let text = e.text !== '' ? e.text : (submitted ?? '')
    const first = e.agentId === undefined && !mainTurnSeen
    if (e.agentId === undefined) mainTurnSeen = true
    if (e.agentId === undefined) await decideRowless($)
    // Cowork handing a conversation begun in chat over (`handoverPrompt`): the turn begins with the host's own message, or with none,
    // and its prompt is the person's last message in chat ('' where none is found: the host's text is never taken for it).
    let handedOver = false
    if (first && rowless && (await hostFactsOf($)).cowork === true) {
      const found = await handoverPrompt($, text)
      if (found !== undefined) {
        text = found
        handedOver = true
      }
    }
    if (text === '' && first && rowless && !handedOver) text = await transcriptPrompt($, false)
    if (e.agentId === undefined) text = await turnText($, text)
    if (e.agentId === undefined && isCopying()) capturePrompt(capture, text)
    // The repository the turn runs in, read again each turn: the session may have moved to another, or the remote changed.
    if (rowless && e.agentId === undefined) repoNow = readRepo($)
    const r = await rebuildOf($)
    const nowMs = await $.clock.now()
    // The prompt row, built where none comes: before the turn, as Claude Code logs it. A turn no prompt began (a continuation) has no
    // prompt row, as in Claude Code. The load's first turn, whose prompt the transcript may not hold yet, looks again at its first
    // model request.
    if (r !== null && rowless && e.agentId === undefined && text !== '') {
      try {
        await buildPromptRow($, text, first ? earliestStart(nowMs) : nowMs)
      } catch {
        // The turn goes without its prompt row.
      }
    } else if (r !== null && rowless && first && text === '' && !handedOver) promptLater = { turnId: e.turnId, atMs: nowMs }
    if (r !== null) out = turnStart(r, { ...e, text }, nowMs)
    // The calls that ran before the turn began, under its prompt: now, unless the prompt waits for the turn's first request.
    if (first && promptLater === undefined) await releaseEarlyCalls($, r)
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
  if (e.agentId === undefined) mainTurnOpen = false
  // A main-loop turn an API error ended: where it failed, read before its interaction closes.
  let failedAt: Record<string, TelemetryAttribute> | undefined
  try {
    if (e.reason === 'error' && e.agentId === undefined && isCopying()) failedAt = await placeOf($, undefined)
  } catch {
    failedAt = undefined
  }
  try {
    const endMs = await $.clock.now()
    // A main-loop turn's requests' rows still waiting for their ID go first: each sits in the interaction this closes, which keeps
    // the turn's own end. A subagent's sit in its Agent call's run, which stays.
    if (e.agentId === undefined) await mainRequestRowsSent()
    const r = await rebuildOf($)
    // Calls that ran before the turn began and still wait (the turn made no request): theirs go before it closes.
    if (e.agentId === undefined && earlyCalls.length > 0) await releaseEarlyCalls($, r)
    if (r !== null) out = turnComplete(r, e, endMs)
  } catch {
    // The turn's interaction is not rebuilt.
  }
  const result = await next(e)
  if (out !== null) await emit($, out).catch(() => undefined)
  // Its marker, beside the turn's end, never holding it.
  if (failedAt !== undefined) {
    const place = failedAt
    beside(() => stopMarker($, place))
  }
  // The setup's status, as a main-loop turn ends: beside the turn, never holding it.
  if ((e as { agentId?: string }).agentId === undefined) void statusAtTurnEnd($).catch(() => undefined)
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

/** A model request streaming now whose rows the plugin builds: where its loop's transcript is, and the model's last row kept since. */
type StepRows = { at: Promise<{ path: string; from: number } | undefined>; last?: string; overlapped?: boolean }

/**
 * How many times, `TRANSCRIPT_RETRY_MS` apart, the transcript is read for a request's ID after the request ends: Claude Code writes
 * the rows it keeps a moment after keeping them, a tenth of a second or so.
 */
export const REQUEST_ID_TRIES = 10

/**
 * The transcript a loop's rows are written to (the main one, or a subagent's under it), and its length now, as a request begins: the
 * request's rows are written after. One not written yet (a new session's first request, a subagent's) is empty. Undefined where the
 * session keeps no transcript.
 */
async function transcriptAt($: EngineInterface, agentId: string | undefined): Promise<{ path: string; from: number } | undefined> {
  try {
    const { transcriptPath } = await infoOf($)
    if (transcriptPath === undefined) return undefined
    const path = agentId === undefined ? transcriptPath : agentTranscriptPath(transcriptPath, agentId)
    if (path === undefined) return undefined
    const from = await $.fs.stat(path).then(st => st.size, () => 0)
    return { path, from }
  } catch {
    return undefined
  }
}

const utf8Length = (text: string) => new TextEncoder().encode(text).length

/**
 * The ID of the API request that answered with the row `uuid` (`requestIdIn`), read from what the transcript has gained since the
 * request began, in order, as it is written: each read takes up where the last one's whole lines ended, as much as one read takes, so
 * a large row written after the request's (a tool's result) is read past, not over. Undefined where the row names none, or is not
 * written within `REQUEST_ID_TRIES` reads (one more once the session is ending), or the transcript can't be read.
 */
async function requestIdOf($: EngineInterface, at: StepRows['at'], uuid: string): Promise<string | undefined> {
  const where = await at
  if (where === undefined) return undefined
  let from = where.from
  for (let i = 0; i < REQUEST_ID_TRIES; i++) {
    const last = requestIdsEnding
    if (!last) await $.clock.sleep(TRANSCRIPT_RETRY_MS)
    try {
      for (;;) {
        const size = (await $.fs.stat(where.path)).size
        // Written over (a session's transcript starts again elsewhere): not this request's.
        if (size < from) return undefined
        if (size === from) break
        const length = Math.min(size - from, MAX_READ_BYTES)
        const text = await ($ as unknown as Newer).fs.read(where.path, { offset: from, length })
        const found = requestIdIn(text, uuid)
        if (found !== null) return found
        // On from the last whole line, counted back from the read's end: a character the read cut is never counted short.
        const whole = text.lastIndexOf('\n')
        if (whole < 0) {
          if (length < MAX_READ_BYTES) break
          // One line longer than a read: on past its first part, its row not this one's (`requestIdIn` matched no line).
          from += length
          continue
        }
        from = from + length - utf8Length(text.slice(whole + 1))
        if (length < MAX_READ_BYTES) break
      }
    } catch {
      // Not there yet, or not readable this time: read again.
    }
    if (last) return undefined
  }
  return undefined
}

/**
 * A request's built rows, its request row and its response row if any, sent with its ID. Where the transcript's is looked for
 * (`found`), they wait for it beside the request, which goes on at once, and go after the rows waiting before them; a main-loop turn's
 * end waits for them (`requestRowsSent`). Else they go now, with the ID that stands for the request's, unless rows still wait: then
 * after them. The transcript's ID goes on one request alone: one some request's rows carried lately is not taken again.
 */
async function sendRequestRows($: EngineInterface, request: RowIn, response: { row: RowIn; fill: RowFill } | undefined, lookup: Promise<string | undefined> | undefined, main: boolean): Promise<void> {
  const found = lookup?.catch(() => undefined)
  const send = async (read: string | undefined) => {
    const id = read !== undefined && !requestIdsUsed.includes(read) ? read : undefined
    if (id !== undefined) {
      requestIdsUsed.push(id)
      if (requestIdsUsed.length > REQUEST_IDS_KEPT) requestIdsUsed.shift()
    }
    // The ID in the place of the one that stood for it, among the rows' attributes.
    const withId = (row: RowIn): RowIn => (id === undefined ? row : { ...row, attributes: { ...row.attributes, request_id: id } })
    await feedRow($, withId(request))
    if (response !== undefined) await feedRow($, withId(response.row), response.fill)
  }
  if (found === undefined && requestRowsPending === 0) return send(undefined)
  requestRowsPending += 1
  const sent = requestRows.then(async () => send(await found))
  requestRows = sent.catch(() => undefined).finally(() => {
    requestRowsPending = Math.max(0, requestRowsPending - 1)
  })
  if (main) mainRequestRows = requestRows
}

/** How many request IDs the built rows carried are kept, so none goes on a second request. */
const REQUEST_IDS_KEPT = 256

/**
 * The built rows of the main loop's requests waiting for their ID now, and those before them, sent: before a main-loop turn's
 * interaction closes. Each waits `REQUEST_ID_TRIES` reads at most, from its request's end.
 */
async function mainRequestRowsSent(): Promise<void> {
  if (requestRowsPending > 0) await mainRequestRows
}

/** Every built row still waiting for its ID, sent as the session ends: each reads the transcript once more, then goes without it. */
async function requestRowsSent(): Promise<void> {
  if (requestRowsPending === 0) return
  requestIdsEnding = true
  try {
    await requestRows
  } finally {
    // After a /clear or a resume the process goes on: its next requests look for their IDs again.
    requestIdsEnding = false
  }
}

/**
 * A row of the model's response a conversation keeps (door `response`): while a request of the loop streams, the last one's ID is
 * noted, so its built rows carry the ID of the API request it came from. The row goes on unchanged.
 */
export async function appendHook($: AppendParams[0], e: AppendParams[1], next: AppendParams[2]) {
  try {
    const mine = stepRows.get(loopKey(e.agentId))
    if (mine !== undefined && e.origin?.kind === 'model' && typeof e.uuid === 'string' && e.uuid !== '') mine.last = e.uuid
  } catch {
    // The request's rows carry the ID that stands for its own.
  }
  return next(e)
}

/** A fault in the append hook: the row goes on as it came. */
export function appendCatch($: AppendCatchParams[0], e: AppendCatchParams[1], next: AppendCatchParams[2]) {
  return next(e)
}

/**
 * One model request: its start, and its stop reason and usage once it is whole; the text and thinking it streams are read for its
 * rows. The stream passes through untouched.
 */
export async function* stepHook($: StepParams[0], e: StepParams[1], next: StepParams[2]) {
  let r: Rebuild | null = null
  let startMs = 0
  // When the first piece of the response came, for a request row the plugin builds (its time to first token).
  let firstChunk: Promise<number | undefined> | undefined
  // The prompt of the load's first turn, where its start found none: before the request's own rows.
  await promptAtFirstStep($, e).catch(() => undefined)
  // Where the request's rows will be written in the transcript, for its built rows' request ID: noted beside the request, never holding it.
  const loop = loopKey(e.agentId)
  const mine: StepRows | undefined = rowless ? { at: transcriptAt($, e.agentId) } : undefined
  if (mine !== undefined) {
    // A loop streams one request at a time. Were two of one loop to overlap, which response row is whose can't be told: neither looks.
    const before = stepRows.get(loop)
    if (before !== undefined) before.overlapped = mine.overlapped = true
    stepRows.set(loop, mine)
  }
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
  const stream = r === null ? next(e) : watched(next(e), chunk => {
    // The first piece of the response itself: not the stream's envelope, nor a retry's marker.
    const kind = (chunk as { kind?: unknown } | null)?.kind
    if (kind === 'text' || kind === 'thinking' || kind === 'tool' || kind === 'input') firstChunk ??= $.clock.now().catch(() => undefined)
    streamChunk(capture, e.agentId, chunk)
  })
  stepsInFlight += 1
  let result: TurnStepResult
  // The request's share of the cost, read as it ends, before any reading outside a request can be taken.
  let costTaken: Promise<number | undefined> | undefined
  try {
    result = yield* stream
    if (rowless && r !== null && result?.usage) costTaken = takeCost($, ({ costUsd }) => costOf(rowlessState, costUsd)).catch(() => undefined)
  } finally {
    stepsInFlight = Math.max(0, stepsInFlight - 1)
    if (stepRows.get(loop) === mine) stepRows.delete(loop)
    // A call of a subagent's that began to run while this step streamed: the ledger is read now, the step's own tokens in it.
    if (e.agentId !== undefined && ledgerWaits.delete(e.agentId)) noteLedger($, e.agentId)
  }
  try {
    firstStepAtMs ??= await $.clock.now()
  } catch {
    // The next request's end counts instead.
  }
  if (r !== null) {
    try {
      const endMs = await $.clock.now()
      await emit($, stepEnd(r, e.agentId, startMs, result, endMs, streamedThinking(capture, e.agentId)))
      // The request row, built where none comes: after the step, which it pairs with as Claude Code's does. A request that brought no
      // response logs none here (Claude Code's error row says what failed, which no event does).
      if (rowless && result?.usage) {
        const [head, costUsd, firstChunkMs, ep] = await Promise.all([rowlessHead($), costTaken ?? takeCost($, ({ costUsd }) => costOf(rowlessState, costUsd)), firstChunk, (entrypoint ??= readEntrypoint($))])
        const agent = e.agentId !== undefined ? agentTypes.get(e.agentId) : undefined
        // Built now, in order, with the ID that stands for the request's where the transcript's isn't found (`stepRequestId`).
        const requestId = stepRequestId(e.turnId, e.index)
        const request = requestRow(rowlessState, head, {
          model: e.model, usage: result.usage, ...(e.effort !== undefined ? { effort: e.effort } : {}), ...(e.agentId !== undefined ? { agentId: e.agentId } : {}), ...(agent ? { agent } : {}),
          startMs, endMs, ...(firstChunkMs !== undefined ? { firstChunkMs } : {}), ...(costUsd !== undefined ? { costUsd } : {}), sdk: ep.startsWith('sdk'), requestId,
        })
        // Its response row, where it answered with text: the gate adds the text where `response.text` is on. The text is the step's
        // own answer, not the stream's pieces, which a retry inside the step may have sent twice. The row carries it; the stream's text
        // is let go now, so a row of Claude Code's that comes later fills nothing twice.
        const text = responseTextOf(result.answer, streamedText(capture, e.agentId))
        const response = text === undefined ? undefined : {
          row: responseRow(rowlessState, head, {
            length: text.length, model: result.usage.model ?? e.model, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}), ...(agent ? { agent } : {}), sdk: ep.startsWith('sdk'), atMs: endMs, requestId,
          }),
          fill: { attributes: { response: text } },
        }
        dropStreamedText(capture, e.agentId)
        const looked = mine?.last !== undefined && !mine.overlapped ? requestIdOf($, mine.at, mine.last) : undefined
        await sendRequestRows($, request, response, looked, e.agentId === undefined)
      }
    } catch {
      // The request's span goes without its stop reason.
    }
  }
  return result
}

/** A subagent's ledger as `$.agent.list()` answers it now; undefined where it can't be read, or not within half a second. */
async function ledgerOf($: EngineInterface, agentId: string): Promise<ModelTokens[] | undefined> {
  const read = ($ as unknown as { agent: { list: () => Promise<unknown> } }).agent.list().then(list => agentLedgerOf(list, agentId), () => undefined)
  return Promise.race([read, $.clock.sleep(HEAD_READ_MS).then(() => undefined)]).catch(() => undefined)
}

/**
 * A WebFetch or WebSearch call begins to run, its rows built: the reading its request's share starts from. As the first such call
 * begins, what the session's cost grew by before it is held for the next request (`holdCost`), and its subagent's ledger is read. The
 * run waits for the cost's reading, half a second at most: one that comes later is taken where it falls.
 */
async function helperStarts($: EngineInterface, id: string, agentId: string | undefined): Promise<void> {
  const first = helperRuns.size === 0
  const agentFirst = agentId !== undefined && ![...helperRuns.values()].some(h => h.agentId === agentId)
  helperRuns.set(id, agentId !== undefined ? { agentId } : {})
  // A tool may begin to run while the step that asked for it still streams: its ledger is read once that step has ended.
  if (agentFirst && stepRows.has(loopKey(agentId))) ledgerWaits.add(agentId)
  else if (agentFirst) noteLedger($, agentId)
  if (first) await Promise.race([takeCost($, ({ costUsd }) => holdCost(rowlessState, costUsd)).catch(() => undefined), $.clock.sleep(HEAD_READ_MS)])
}

/** Reads a subagent's ledger now: the reading its running calls' requests are counted from. */
function noteLedger($: EngineInterface, agentId: string): void {
  agentLedgers.delete(agentId)
  agentLedgers.set(agentId, ledgerOf($, agentId))
  if (agentLedgers.size > MAX_VERDICTS) agentLedgers.delete(agentLedgers.keys().next().value!)
}

/**
 * What the request a WebFetch or WebSearch call made in its run cost, read as the call ends: what the session's cost grew by since the
 * last reading, the run's (`runCostOf`), so it is this request's, not the next one's; and in a subagent, its model and tokens, what the
 * subagent's ledger grew by since it was last read (`ledgerGrowth`). Undefined where the call made none (nothing grew) or none of it
 * could be read. It waits half a second at most for a reading: one that comes later is not taken, and its share goes to the next.
 */
async function helperOf($: EngineInterface, call: { tool: string; id: string; agentId?: string }, runStartMs: number, endMs: number): Promise<HelperFacts | undefined> {
  if (!helperRuns.has(call.id)) return undefined
  // The reading, once taken, is this request's whatever the timer says; one not taken by then never is, and its share stays.
  let late = false
  let decided = false
  const taken = takeCost($, ({ costUsd }) => {
    if (late) return undefined
    decided = true
    return runCostOf(rowlessState, costUsd)
  }).catch(() => undefined)
  const share = Promise.race([taken, $.clock.sleep(HEAD_READ_MS).then(() => (decided ? taken : ((late = true), undefined)))])
  const agentId = call.agentId
  // The subagent's next reading counts from this one at once, so two calls that end together never count the same tokens twice.
  const before = agentId !== undefined ? agentLedgers.get(agentId) : undefined
  let grown: Promise<ModelTokens | undefined> = Promise.resolve(undefined)
  if (agentId !== undefined && before !== undefined) {
    const was = before.catch(() => undefined)
    const now = ledgerOf($, agentId)
    agentLedgers.set(agentId, Promise.all([was, now]).then(([w, n]) => n ?? w))
    grown = Promise.all([was, now]).then(([w, n]) => (w !== undefined && n !== undefined ? ledgerGrowth(w, n) : undefined))
  }
  const [usd, usage] = await Promise.all([share, grown.catch(() => undefined)])
  if ((usd === undefined || usd <= 0) && usage === undefined) return undefined
  return {
    tool: call.tool, toolUseId: call.id, ...(agentId !== undefined ? { agentId } : {}), runStartMs, endMs,
    ...(usd !== undefined ? { costUsd: usd } : {}), ...(usage !== undefined ? { usage } : {}),
  }
}

/** A WebFetch or WebSearch call ended, however: it no longer runs, and its subagent's ledger is let go once none of its calls does. */
function helperEnds(id: string): void {
  const run = helperRuns.get(id)
  if (run === undefined) return
  helperRuns.delete(id)
  if (run.agentId !== undefined && ![...helperRuns.values()].some(h => h.agentId === run.agentId)) {
    agentLedgers.delete(run.agentId)
    ledgerWaits.delete(run.agentId)
  }
}

/** The call's own arguments, and who made it: what the engine adds beside the arguments is not the tool's input. */
function endedCall(e: ToolCallParams[1]): EndedCall {
  const { tool, tool_use_id: id, agentId, consent: _consent, requestMeta: _meta, ...input } = e as unknown as { tool: string; tool_use_id?: string; agentId?: string; consent?: string; requestMeta?: unknown } & Record<string, unknown>
  return { tool, input, ...(typeof id === 'string' && id !== '' ? { toolUseId: id } : {}), ...(typeof agentId === 'string' && agentId !== '' ? { agentId } : {}) }
}

/**
 * What a tool call that ended leaves for the rebuild and its rows: the call, its result and end; with `decision`, the rows are built
 * (its decision row); with `ran`, it ran (its result row).
 */
type CallRows = {
  id: string | undefined
  call: { tool: string; id: string; agentId?: string }
  result: unknown
  startMs: number
  endMs: number
  decision?: { refused: boolean; source?: string; atMs: number }
  ran?: { startMs: number; runStartMs?: number; endMs: number; isError: boolean; input: Readonly<Record<string, unknown>>; text?: string; commit?: MadeCommit }
  /** The model request the tool made in its run (WebFetch's, WebSearch's): its row goes between the call's decision and its result. */
  helper?: HelperFacts
}

/** A tool call's decision row, its end in the rebuild, then its result row: the decision first, so a refused call's spans go as it ends. */
async function sendCall($: EngineInterface, r: Rebuild, c: CallRows): Promise<void> {
  const built = c.decision !== undefined && rowless
  const head = built ? await rowlessHead($) : undefined
  if (built) await feedRow($, decisionRow(rowlessState, head!, { ...c.call, ...c.decision! }, c.decision!.atMs))
  const helper = built && c.helper !== undefined ? helperRow(rowlessState, head!, c.helper) : undefined
  if (helper !== undefined) await feedRow($, { ...helper, call: c.call.id })
  await emit($, toolEnd(r, c.id, c.result as never, c.endMs))
  if (built && c.ran !== undefined) await feedRow($, resultRow(rowlessState, head!, { ...c.call, ...c.ran }))
}

/**
 * The calls that ran before the load's first turn began (`earlyCalls`), once that turn's prompt row is built, or none comes: their rows,
 * timed as they ran, under the turn's prompt, and their spans under its interaction.
 */
async function releaseEarlyCalls($: EngineInterface, r: Rebuild | null): Promise<void> {
  const calls = earlyCalls
  earlyCalls = []
  if (r === null) return
  for (const c of calls) {
    try {
      if (c.id !== undefined) toolJoinsTurn(r, c.id)
      await sendCall($, r, c)
    } catch {
      // That call goes without its rows.
    }
  }
}

/**
 * When the load's first turn's prompt row is timed: as the turn began, or as the first call that began before it, if earlier, ended or
 * still running.
 */
const earliestStart = (atMs: number) => Math.min(earlyCalls.reduce((min, c) => Math.min(min, c.startMs), atMs), ...earlyRunning.values())

/**
 * One tool call: when it began and ended, and what it did; once it ended without error, its markers, beside it. The call and its
 * result pass through untouched.
 */
export async function toolCallHook($: ToolCallParams[0], e: ToolCallParams[1], next: ToolCallParams[2]) {
  let r: Rebuild | null = null
  let ended: EndedCall | undefined
  try {
    ended = endedCall(e)
  } catch {
    ended = undefined
  }
  // A main-loop call before the load's first turn began, in Cowork (`earlyCalls`): whether the plugin builds the rows is decided as it
  // ends, as that turn's start would decide it, so what its check and run say is kept meanwhile.
  let early = false
  // What the transcript's end says of a handover, for a call begun before the first turn: read as it begins, its rows written by then.
  let handover: Promise<Handover | undefined> | undefined
  try {
    r = await rebuildOf($)
    if (r !== null) {
      early = e.agentId === undefined && !mainTurnSeen && !mainTurnOpen && !rowSeen && typeof e.tool_use_id === 'string' && e.tool_use_id !== '' && (await hostFactsOf($)).cowork === true
      if (early) {
        earlySeen = true
        handover = handoverOf($)
      }
      if (ended !== undefined) captureTool(capture, ended.toolUseId, ended.tool, ended.input)
      const startMs = await $.clock.now()
      if (early) earlyRunning.set(e.tool_use_id!, startMs)
      toolStart(r, e as never, startMs)
      if ((rowless || early) && e.tool_use_id !== undefined) callStarts.set(e.tool_use_id, startMs)
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
  // When the call began, where its rows are built: let go however the call ends.
  const id = e.tool_use_id
  const startMs = id !== undefined ? callStarts.get(id) : undefined
  try {
    result = await next(e)
  } catch (err) {
    if (id !== undefined) {
      earlyRunning.delete(id)
      helperEnds(id)
    }
    throw err
  } finally {
    if (withArgs) argsInFlight -= 1
    if (id !== undefined) callStarts.delete(id)
  }
  if (r !== null) {
    try {
      const endMs = await $.clock.now()
      // Begun before the first turn, in a handover from chat (the transcript's newest prompt is the person's message carried over, from
      // before the handover's row): the plugin builds the rows from here on where no row of Claude Code's reaches it, as that turn's start
      // would decide. Their rows wait for the turn's prompt row while it is still to come; where the turn has begun and has it, they go
      // now, under its interaction.
      // Its read waits no longer than HEAD's does: a read that hangs never holds the call's result.
      const handed = handover !== undefined && (await Promise.race([handover, $.clock.sleep(HEAD_READ_MS).then(() => undefined)]))?.carried === true
      if (handed) await decideRowless($).catch(() => undefined)
      const hold = handed && rowless && (!mainTurnSeen || promptLater !== undefined) && earlyCalls.length < MAX_EARLY_CALLS
      const joins = handed && rowless && !hold
      const verdict = id !== undefined ? verdicts.get(id) : undefined
      const judged = id !== undefined ? judgments.get(id) : undefined
      const ranAtMs = id !== undefined ? runs.get(id) : undefined
      const permanent = id !== undefined ? saved.get(id) : undefined
      if (id !== undefined) {
        verdicts.delete(id)
        judgments.delete(id)
        runs.delete(id)
        saved.delete(id)
      }
      // The decision and result rows, built where none comes: a refused call has its decision alone, as in Claude Code. The decision
      // goes first, so a refused call's spans go as it ends.
      const built = rowless && id !== undefined && startMs !== undefined
      const settled = result as { isError?: boolean; deny?: unknown; text?: unknown; result?: unknown } | undefined
      const isError = settled?.isError === true
      // Whether it was refused, who settled it and when: the check's verdict, the classifier's, whether it ran, and whether the
      // permission an ask was answered with was saved (asked of the check as the call began to run, answered by now).
      const decision = decisionOf({
        ...(verdict !== undefined ? { verdict } : {}),
        ...(judged !== undefined ? { judged } : {}),
        ...(ranAtMs !== undefined ? { ranAtMs } : {}),
        ...(built && permanent !== undefined ? { permanent: (await Promise.race([permanent, $.clock.sleep(HEAD_READ_MS).then(() => undefined)])) === true } : {}),
        startMs: startMs ?? endMs, endMs, denied: settled?.deny !== undefined, isError, text: settled?.text,
      })
      const refused = decision.refused
      const call = { tool: e.tool, id: id!, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) }
      let ran: CallRows['ran']
      if (built && !refused) {
        const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, requestMeta: _meta, ...input } = e as unknown as Record<string, unknown>
        const text = settled?.text
        // A shell call that reported a commit: HEAD's, where HEAD now names it, as Claude Code's result row names it. Read only where the
        // repository may go on the row (or may yet, the settings' first answer pending).
        const repoMayGo = settingsPending() !== undefined || builtRepoAllowed(currentGate())
        const reported = !isError && repoMayGo && ended?.tool === 'Bash' ? commitsInOutput(outputTexts(settled?.result)) : []
        const commit = reported.length > 0 ? madeCommit(reported, await Promise.race([readHead($).catch(() => undefined), $.clock.sleep(HEAD_READ_MS).then(() => undefined)])) : undefined
        if (commit !== undefined) captureCommit(capture, id!, commit)
        ran = { startMs: startMs!, ...(ranAtMs !== undefined ? { runStartMs: ranAtMs } : {}), endMs, isError, input, ...(typeof text === 'string' ? { text } : {}), ...(commit !== undefined ? { commit } : {}) }
      }
      // A WebFetch or WebSearch call that answered made a model request in its run: its cost is read now, before the next request's.
      const helper = ran !== undefined && !isError && HELPER_SOURCES[e.tool] !== undefined ? await helperOf($, call, ranAtMs ?? startMs!, endMs).catch(() => undefined) : undefined
      const rows: CallRows = {
        id, call, result, startMs: startMs ?? endMs, endMs, ...(built ? { decision: { refused, ...(decision.source !== undefined ? { source: decision.source } : {}), atMs: decision.atMs } } : {}), ...(ran !== undefined ? { ran } : {}),
        ...(helper !== undefined ? { helper } : {}),
      }
      if (hold && built) earlyCalls.push(rows)
      else {
        if (joins && id !== undefined) toolJoinsTurn(r, id)
        await sendCall($, r, rows)
      }
    } catch {
      // The call's spans go with what the rows say.
    }
  }
  // Held by now where it waits, or sent: no longer running before the first turn; its request's reading, if any, taken.
  if (id !== undefined) {
    earlyRunning.delete(id)
    helperEnds(id)
  }
  // A refused or failed call makes no marker.
  try {
    if (ended !== undefined && result.deny === undefined && result.isError !== true && isCopying() && mayMark(ended)) {
      const marking = ended
      const response: unknown = result.result
      beside(() => toolMarkers($, marking, response))
    }
  } catch {
    // No marker for that call.
  }
  return result
}

/**
 * A tool call's permission check, while the plugin builds the rows: its verdict, kept for the call's decision row. The check goes on
 * and its verdict comes back unchanged.
 */
export async function toolCheckHook($: ToolCheckParams[0], e: ToolCheckParams[1], next: ToolCheckParams[2]) {
  const verdict = await next(e)
  try {
    const id = (e as { tool_use_id?: unknown }).tool_use_id
    const approver = (e as { approver?: unknown }).approver
    const v = verdict as Verdict | undefined
    if (typeof id === 'string' && (rowless || callStarts.has(id)) && typeof v?.decision === 'string') {
      verdicts.set(id, {
        decision: v.decision, ...(typeof v.rule === 'string' ? { rule: v.rule } : {}), ...(typeof v.hook === 'string' ? { hook: v.hook } : {}),
        ...(typeof v.setting === 'string' ? { setting: v.setting } : {}), ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
        ...(typeof approver === 'string' ? { approver } : {}),
      })
      if (verdicts.size > MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value!)
    }
  } catch {
    // The call's decision row says accept.
  }
  return verdict
}

/**
 * Auto mode's classifier answered about a call, while the plugin builds the rows: its answer, kept for the call's decision row (an
 * ask it settled is the mode's, not a person's). The question goes on and the answer comes back unchanged.
 */
export async function toolJudgeHook($: ToolJudgeParams[0], e: ToolJudgeParams[1], next: ToolJudgeParams[2]) {
  const answer = await next(e)
  try {
    const id = (e as { tool_use_id?: unknown }).tool_use_id
    const decision = (answer as { decision?: unknown } | undefined)?.decision
    if (typeof id === 'string' && (rowless || callStarts.has(id)) && typeof decision === 'string') {
      judgments.set(id, decision)
      if (judgments.size > MAX_VERDICTS) judgments.delete(judgments.keys().next().value!)
    }
  } catch {
    // The call's decision names no classifier.
  }
  return answer
}

/**
 * A call was allowed and is about to run, while the plugin builds the rows: when, which ends the wait for its permission
 * (`claude_code.tool.blocked_on_user`) and starts its run. After an ask someone answered, the check is asked again, beside the call,
 * whether it now allows the call outright: the answer was saved. The call runs untouched; nothing here holds it but a WebFetch or
 * WebSearch call's, for the reading of the session's cost its request's share starts from (`helperStarts`), half a second at most.
 */
export async function toolRunHook($: ToolRunParams[0], e: ToolRunParams[1], next: ToolRunParams[2]) {
  try {
    const id = e.tool_use_id
    if (typeof id === 'string' && callStarts.has(id)) {
      runs.set(id, await $.clock.now())
      // A WebFetch or WebSearch call, its rows built: its request's share is read from here.
      if (rowless && HELPER_SOURCES[e.tool] !== undefined) await helperStarts($, id, typeof e.agentId === 'string' && e.agentId !== '' ? e.agentId : undefined)
      if (runs.size > MAX_VERDICTS) runs.delete(runs.keys().next().value!)
      const v = verdicts.get(id)
      if (v?.decision === 'ask' && (v.approver === 'person' || v.approver === 'host') && judgments.get(id) !== 'allow') {
        const { input } = endedCall(e as unknown as ToolCallParams[1])
        saved.set(id, $.tool.check({ tool: e.tool, input }).then(r => (r.decision === 'allow' && typeof r.rule === 'string' ? ruleSavedIn($, r.rule) : false), () => undefined))
        if (saved.size > MAX_VERDICTS) saved.delete(saved.keys().next().value!)
      }
    }
  } catch {
    // The call's decision goes as it began.
  }
  return next(e)
}

/**
 * Whether a permission rule is written in a settings file, the person's, the project's or its local one: an answer saved there is
 * Claude Code's `user_permanent`. One kept for the session alone, or a mode the answer switched to, is not.
 */
async function ruleSavedIn($: EngineInterface, rule: string): Promise<boolean> {
  const layers = await Promise.all((['user', 'project', 'local'] as const).map(source => $.settings.read({ source }).catch(() => undefined)))
  return layers.some(layer => permissionRules(layer).includes(rule))
}

/** A call runs whatever the hook did: the hook calls `next` last, so it never had. */
export function toolRunCatch($: ToolRunCatchParams[0], e: ToolRunCatchParams[1], next: ToolRunCatchParams[2]) {
  return next(e)
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
  // Submitted while idle, it starts a turn: held for that turn's start, which comes before `next` resolves. Not one submitted over a
  // running turn (a plugin's own carries no `turnId` even then), nor one the person never sees as typed (`isMeta`).
  let held: { text: string } | undefined
  try {
    const idle = e.turnId === undefined && !mainTurnOpen
    if (idle && e.command === undefined && e.isMeta !== true && typeof e.text === 'string') held = idleSubmitted = { text: e.text }
  } catch {
    held = undefined
  }
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
  let result: Awaited<ReturnType<typeof next>>
  try {
    result = await next(e)
  } finally {
    // Its turn has started by now, or none will (a dropped prompt): no later turn takes its text.
    if (held !== undefined && idleSubmitted === held) idleSubmitted = undefined
  }
  // The plan snapshot, beside the prompt that entered, never holding it.
  try {
    if (result.drop === undefined && isCopying()) beside(() => snapshotMarker($))
  } catch {
    // No snapshot for that prompt.
  }
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
    // Its type, for the rows built of its requests: Claude Code's own agents are `builtin`, any other `custom`.
    if (result.deny === undefined && result.agentId && typeof e.subagentType === 'string') {
      agentTypes.set(result.agentId, { type: e.subagentType, builtIn: (e as { provider?: { tier?: string } }).provider?.tier === 'core' })
      if (agentTypes.size > MAX_VERDICTS) agentTypes.delete(agentTypes.keys().next().value!)
    }
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
      await flushOutsideCost($, true).catch(() => undefined)
      await requestRowsSent()
      // Calls that ran before a first turn that never came: theirs go, with no prompt.
      if (earlyCalls.length > 0) await releaseEarlyCalls($, await rebuildOf($)).catch(() => undefined)
      await sweepNow($, true)
      // What waits for the settings' first answer goes now, before the meter collects for the last time.
      await flushHeldCopies()
      // The setup's status as the session ends, rows given their time: queued with the own rows below.
      statusTimer?.cancel()
      statusTimer = null
      await checkStatus($, true).catch(() => undefined)
      // The plugin's own rows still waiting go under the session's identity, those of the settings read beside its start too.
      await serversRead
      await flushOwn($).catch(() => undefined)
      // Claude Code's meter collects once more as the process ends; after a /clear or a resume the process goes on, and so does it.
      if (e.reason !== 'clear' && e.reason !== 'resume') await collectNow($)
    }
    await flushHeldCopies()
    await finish($, next.budget)
    // Never the value: only that it does not fit.
    if (collectorMalformed()) $.ui.log('mainwave: copy off: the collectorUrl option is not an https URL (or http on loopback)', { to: 'debug' })
    // Never the value: only why.
    const redaction = currentGate().redaction
    if (isCopying() && 'held' in redaction) $.ui.log(`mainwave: identifier and content values held back: the redaction packs chosen ${redaction.held === 'unreadable' ? "can't be read" : "name a pack this plugin does not have, or a custom rule it can't use"}`, { to: 'debug' })
    if (isCopying()) {
      const s = snapshot()
      const refusals = s.refusedIdentities > 0 ? `, ${s.refusedIdentities} organization and email refused` : ''
      const stopped = s.stopped ? ', refused: nothing more sent or queued this session' : ''
      const status = lastIssues === undefined ? '' : `; setup: ${lastIssues === '' ? 'no issues' : lastIssues}${accountCommon !== undefined ? " (identity from the host's variables or the account file)" : ''}`
      $.ui.log(`mainwave: copy to ${collectorOf()} (keyless): ${s.sent} sent, ${s.dropped} dropped, ${s.queued} kept for a later session, ${s.withheld} held back (no organization and email)${refusals}${stopped}; data collection settings: ${settingsSummary()}${status}`, { to: 'debug' })
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
  cliHooks = null
  making = new Set()
  rowSeen = false
  rowless = false
  rowlessState = newRowless()
  rowsAtLoad = null
  stepsInFlight = 0
  stepRows = new Map()
  helperRuns = new Map()
  agentLedgers = new Map()
  ledgerWaits = new Set()
  requestRows = Promise.resolve()
  requestRowsPending = 0
  mainRequestRows = Promise.resolve()
  requestIdsEnding = false
  requestIdsUsed = []
  rowlessPending = false
  loadedAtMs = undefined
  costChain = Promise.resolve()
  seedSince = {}
  resourceAttrs = null
  idleSubmitted = undefined
  mainTurnOpen = false
  mainTurnSeen = false
  promptLater = undefined
  earlyCalls = []
  earlySeen = false
  earlyRunning = new Map()
  callStarts = new Map()
  verdicts = new Map()
  judgments = new Map()
  runs = new Map()
  saved = new Map()
  repoNow = null
  agentTypes = new Map()
  hostFacts = null
  nonInteractive = false
  keyDevice = null
  firstStepAtMs = undefined
  account = null
  accountCommon = undefined
  resetStatus()
  configure()

  on('session.start', sessionStart)

  on('telemetry.log', { to: 'collector' }, stampRow).catch(rowCatch)

  on('turn.start', turnStartHook)
  on('turn.step', stepHook)
  on('turn.complete', turnCompleteHook)
  on('tool.call', toolCallHook).catch(toolCatch)
  on('tool.check', toolCheckHook)
  on('tool.judge', toolJudgeHook)
  on('tool.run', toolRunHook).catch(toolRunCatch)
  on('session.measure', measureHook)
  on('command.run', commandHook).catch(commandCatch)
  on('prompt.submit', promptHook).catch(promptCatch)
  on('agent.spawn', spawnHook).catch(spawnCatch)
  on('skill.prompt', skillHook).catch(skillCatch)
  on('session.append', { door: 'response' }, appendHook).catch(appendCatch)

  on('session.end', sessionEnd)
}
