// The rows Claude Code would have handed the plugin, built from its own events where none reach it. Pure: the hooks (register.ts) call
// it, tests drive it.
//
// Since 2.1.328, in Team and Enterprise organizations and on machines with managed settings, Claude Code seats a built-in plugin
// first that sends every collector row, and every classic hook, on past the plugins installed in the `user` tier, which an org-synced
// plugin is (README, rows_skipped). The plugin then sees no row: nothing says who the session is, and nothing carries a request's
// tokens or a call's outcome. Its other hooks still run: each turn's start and end, each model request's model, effort, usage and stop
// reason (`turn.step`), each tool call and what it answered (`tool.call`), its permission check (`tool.check`, `tool.judge`) and when
// it began to run once allowed (`tool.run`), the session's repository (`$.session.repo()`), and its cost so far (`$.session.usage()`).
//
// Claude Code 2.1.326 and later hands each plugin a row as it loads, and a turn's prompt row before the turn, so a first turn that
// begins with no row seen means none comes (register.ts decides, and ends it as soon as one does). From those events, the plugin
// builds the four rows Mainwave reads a session from, under Claude Code's names, attributes and value types:
//
//   user_prompt     a main-loop turn began: its prompt's length (the text itself is the gate's to add, as for Claude Code's row); the
//                   turn's own text, or the prompt submitted while idle where the host starts the turn with none (register.ts)
//   api_request     a model request answered: its model, tokens, effort, duration, time to first token and cost
//   assistant_response  a model request answered with text: its length (the text itself is the gate's to add, as for Claude
//                   Code's row), after its request row
//   tool_decision   a tool call settled: refused (its permission check refused it, or asked and the call never ran) or accepted,
//                   at the time it was settled (the call began to run, or ended refused), and what settled it
//   tool_result     a tool call that was not refused ended: its outcome and duration
//
// They go through the rebuild and the copy as Claude Code's rows do, so the spans and metrics are built from them, and they carry
// `mainwave.telemetry.built_from` (`events`), so Mainwave can tell them from the copies of Claude Code's rows. Their identity is the
// session's as Claude Code reads it: the host's variables (`CLAUDE_CODE_ORGANIZATION_UUID`, `CLAUDE_CODE_USER_EMAIL`,
// `CLAUDE_CODE_ACCOUNT_UUID`), which Claude Code reads before its account file, else the account file (setup.ts).

import type { TelemetryAttribute } from 'claude-code'

import { identityOf } from './identity.ts'
import { COWORK_SURFACE, isTruthy } from './otlp.ts'
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

/** The device ID in Claude's account file (`userID`), which Claude Code keeps per installation, whoever is signed in. */
export function accountDeviceOf(json: unknown): Record<string, string> {
  const userId = json !== null && typeof json === 'object' ? (json as Record<string, unknown>)['userID'] : undefined
  const { deviceId } = identityOf({ 'user.id': userId })
  return deviceId === undefined ? {} : { 'user.id': deviceId }
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

/** What the session's environment says of where its requests go and where it runs, as Claude Code puts it on each row. */
export type HostFacts = {
  /** `anthropic.provider`: `firstParty`, or the cloud provider the session runs on. */
  provider: string
  /** `ANTHROPIC_BASE_URL` is set: requests go elsewhere than Anthropic's API (a gateway, a proxy). */
  customBaseUrl: boolean
  /** The session takes no input from a person (`claude -p`, an SDK host): `terminal.type` `non-interactive`. */
  nonInteractive: boolean
  /** The session is Cowork's (`isCowork`): its rows carry `cowork.surface`, as its host's variables put it on them. */
  cowork?: boolean
  /** The id of the remote session the host runs it in (`CLAUDE_CODE_REMOTE_SESSION_ID`): `ccr.session.id`. */
  remoteSessionId?: string
}

/** `anthropic.provider` as Claude Code names it, from the variables that pick a cloud provider. */
export function providerOf(env: { CLAUDE_CODE_USE_BEDROCK?: string | undefined; CLAUDE_CODE_USE_VERTEX?: string | undefined; CLAUDE_CODE_USE_FOUNDRY?: string | undefined }): string {
  return isTruthy(env.CLAUDE_CODE_USE_BEDROCK) ? 'bedrock' : isTruthy(env.CLAUDE_CODE_USE_VERTEX) ? 'vertex' : isTruthy(env.CLAUDE_CODE_USE_FOUNDRY) ? 'foundry' : 'firstParty'
}

/**
 * The attributes Claude Code puts first on each of its rows, in its order: the organization's resource attributes
 * (`OTEL_RESOURCE_ATTRIBUTES`), then the device, the session, the repository and who it is, then where requests go and the terminal
 * (an interactive session's terminal no event names). The rebuild reads them as the session's common attributes, as it reads a row's.
 *
 * In Cowork, its host's resource attributes name the surface (`cowork.surface`), so Claude Code's rows carry it: where they don't
 * (no Cowork export configured), the head starts with Cowork's, `remote`. The remote session's id (`ccr.session.id`) goes after the
 * session's, where the host names one.
 *
 * The repository (`repo`, from `repoAttributes`) goes as Claude Code adds it: where the resource attributes name its address, theirs
 * alone, where they stand; else the origin remote's. The gate keeps it only where the `repo` data point is on.
 */
export function rowHead(
  resource: Readonly<Record<string, string>>,
  identity: Readonly<Record<string, string>>,
  sessionId: string | undefined,
  host?: HostFacts,
  repo?: Readonly<Record<string, string>>,
): Attrs {
  const out: Attrs = host?.cowork && resource['cowork.surface'] === undefined ? { 'cowork.surface': COWORK_SURFACE, ...resource } : { ...resource }
  const put = (key: string, value: string | undefined) => {
    if (value === undefined) return
    delete out[key]
    out[key] = value
  }
  put('user.id', identity['user.id'])
  put('session.id', sessionId)
  put('ccr.session.id', host?.remoteSessionId)
  // Claude Code reads the remote only where the resource attributes name no address; a key they name keeps its place and value.
  const fromRemote = resource[REPO_URL] === undefined ? repo : undefined
  for (const key of REPO_KEYS) if (resource[key] === undefined && fromRemote?.[key] !== undefined) out[key] = fromRemote[key]
  put('organization.id', identity['organization.id'])
  put('user.email', identity['user.email'])
  put('user.account_uuid', identity['user.account_uuid'])
  if (host !== undefined) {
    out['anthropic.provider'] = host.provider
    if (host.customBaseUrl) out['anthropic.custom_base_url'] = true
    if (host.nonInteractive) out['terminal.type'] = 'non-interactive'
  }
  return out
}

const REPO_URL = 'vcs.repository.url.full'
/** The repository's attributes, in the order Claude Code writes them. */
const REPO_KEYS = [REPO_URL, 'vcs.owner.name', 'vcs.repository.name', 'vcs.provider.name'] as const

/** The hosts Claude Code names a provider for: each provider's own host and its SSH aliases. */
const PROVIDER_HOSTS: Readonly<Record<string, string>> = {
  'github.com': 'github', 'ssh.github.com': 'github', 'gitlab.com': 'gitlab', 'altssh.gitlab.com': 'gitlab', 'bitbucket.org': 'bitbucket', 'altssh.bitbucket.org': 'bitbucket',
}
/** The host Claude Code writes in a known provider's address, whichever alias the remote used. */
const WEB_HOST: Readonly<Record<string, string>> = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/

const validPath = (path: string) => path !== '' && !path.split('/').some(p => p === '..' || p === '.')

/**
 * A remote's `host/path`, lowercased, as Claude Code normalizes it: an scp-style `git@host:path`, or an `https`, `http` or `ssh` URL,
 * with any user and a trailing `.git` dropped. A remote session's git proxy on a loopback address (`/git/<owner>/<name>`) stands for
 * GitHub, or for the host its path starts with, in a remote session (`CLAUDE_CODE_REMOTE`) alone. Null for anything else (a local path,
 * a `file:` URL).
 */
function remoteSlug(raw: string, remoteSession: boolean): string | null {
  const text = raw.trim()
  const scp = /^git@([^:/@]+):(.+?)(?:\.git)?$/.exec(text)
  if (scp) return validPath(scp[2]!) ? `${scp[1]}/${scp[2]}`.toLowerCase() : null
  const url = /^(?:https?|ssh):\/\/(?:[^@/?#]*@)?([^/?#@]+)\/(.+?)(?:\.git)?$/i.exec(text)
  if (!url || !validPath(url[2]!)) return null
  const [host, path] = [url[1]!, url[2]!]
  if (remoteSession && LOOPBACK_HOST.test(host) && path.startsWith('git/')) {
    const rest = path.slice(4)
    const parts = rest.split('/')
    return (parts.length >= 3 && parts[0]!.includes('.') ? rest : `github.com/${rest}`).toLowerCase()
  }
  return `${host}/${path}`.toLowerCase()
}

/**
 * The repository's attributes from its `origin` remote, as Claude Code derives them: its address on the web (`https://`, then the
 * host, a known provider's own for its aliases, then the path), its owner (the path but the last part), its name (the last part), and
 * its provider where the host is a known one's. A Bitbucket Server remote (an `scm/` path, or SSH on port 7999) gets that server's
 * address and provider. Empty for a remote that is not a repository's address, or that carries credentials after a query.
 */
export function repoAttributes(remote: string | null | undefined, opts: { remoteSession?: boolean } = {}): Record<string, string> {
  if (typeof remote !== 'string') return {}
  const cut = remote.search(/[?#]/)
  if (cut >= 0 && remote.includes('@', cut)) return {}
  const slug = remoteSlug((cut >= 0 ? remote.slice(0, cut) : remote).replace(/\/+$/, ''), opts.remoteSession === true)
  if (slug === null) return {}
  const [first = '', ...rest] = slug.split('/')
  const host = first.replace(/:\d+$/, '')
  const segments = rest.filter(s => s.length > 0)
  const name = segments.at(-1)
  if (!host || !name || host.includes('@') || (host.includes(':') && !/^\[[0-9a-f:.]+\]$/i.test(host)) || segments.some(s => s.includes('@'))) return {}
  // A known provider's host is known with or without `www.`; any other host is written as the remote names it.
  const known = PROVIDER_HOSTS[host.replace(/^www\./, '')]
  const webHost = known !== undefined ? WEB_HOST[known]! : host
  const provider = known ?? (webHost === 'gitea.com' ? 'gitea' : undefined)
  const scmAt = segments.length - 3
  const scm = provider === undefined && scmAt >= 0 && segments[scmAt] === 'scm'
  const path = scm ? [...segments.slice(0, scmAt), ...segments.slice(scmAt + 1)] : segments
  const owners = path.slice(0, -1)
  const project = owners.at(-1)
  if (provider === undefined && project !== undefined && (scm || /^ssh:\/\/[^/?#]*:7999(?=[/?#]|$)/i.test(remote.trim()))) {
    const address = `https://${webHost}/${[...owners.slice(0, -1), 'projects', project, 'repos', name].join('/')}`
    return { [REPO_URL]: address, 'vcs.owner.name': project, 'vcs.repository.name': name, 'vcs.provider.name': 'bitbucket' }
  }
  return {
    [REPO_URL]: `https://${webHost}/${path.join('/')}`,
    ...(owners.length > 0 ? { 'vcs.owner.name': owners.join('/') } : {}),
    'vcs.repository.name': name,
    ...(provider !== undefined ? { 'vcs.provider.name': provider } : {}),
  }
}

/** The commit a call made, as Claude Code names it on the call's result: its full name, and the branch HEAD is on, if any. */
export type MadeCommit = { commitId: string; branch?: string }

/** A path joined to a folder, as git writes `commondir` and a `.git` file's `gitdir:` (relative to the folder, or absolute). */
export function joinPath(dir: string, path: string): string {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return path.replace(/\\/g, '/')
  const parts = dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  for (const p of path.split(/[\\/]/)) {
    if (p === '..') parts.pop()
    else if (p !== '.' && p !== '') parts.push(p)
  }
  return parts.join('/')
}

/**
 * Where HEAD is, from a repository's git folder, `read` reading its files (and rejecting a missing one): the branch HEAD names and the
 * commit that branch points at, from its loose ref or `packed-refs`, in the common folder where a worktree has one; the commit alone
 * for a detached HEAD. Undefined where it can't be read.
 */
export async function headOf(gitDir: string, read: (path: string) => Promise<string>): Promise<MadeCommit | undefined> {
  const head = (await read(`${gitDir}/HEAD`)).trim()
  if (SHA.test(head)) return { commitId: head }
  const ref = /^ref: (refs\/heads\/(\S+))$/.exec(head)
  if (!ref) return undefined
  const common = await read(`${gitDir}/commondir`).then(t => joinPath(gitDir, t.trim()), () => gitDir)
  let sha = await read(`${common}/${ref[1]}`).then(t => t.trim(), () => undefined)
  if (sha === undefined) {
    const packed = await read(`${common}/packed-refs`).catch(() => '')
    sha = packed.split('\n').map(l => l.trim().split(' ')).find(([, name]) => name === ref[1])?.[0]
  }
  return sha !== undefined && SHA.test(sha) ? { commitId: sha, branch: ref[2]! } : undefined
}

/**
 * The commit a shell call made, as Claude Code names it on the call's result: HEAD's, where the call's output reported a commit that
 * HEAD now names (a short name its full one starts with). Undefined otherwise.
 */
export function madeCommit(reported: readonly string[], head: MadeCommit | undefined): MadeCommit | undefined {
  return head !== undefined && reported.some(short => head.commitId.startsWith(short)) ? head : undefined
}

/** The state the rows are built with, one per load: their sequence, the turn's prompt id, and the session's cost at the last request. */
export type Rowless = { sequence: number; promptId?: string; costUsd?: number }

export const newRowless = (): Rowless => ({ sequence: 0 })

/**
 * Claude Code's id of the prompt the session is on, from what `$.session.info()` answers (Claude Code 2.1.326 on has it), where it
 * has the shape of an id; undefined otherwise, and the prompt row takes a new one.
 */
export function promptIdFrom(info: unknown): string | undefined {
  const id = info !== null && typeof info === 'object' ? (info as { promptId?: unknown }).promptId : undefined
  return typeof id === 'string' && /^[0-9A-Za-z._:-]{1,128}$/.test(id) ? id : undefined
}

/** The remote session's id from `CLAUDE_CODE_REMOTE_SESSION_ID`, where it has the shape of an id; undefined otherwise. */
export function remoteSessionIdOf(raw: string | undefined): string | undefined {
  const id = raw?.trim()
  return id !== undefined && /^[0-9A-Za-z._:-]{1,128}$/.test(id) ? id : undefined
}

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

/**
 * Whether a user message's text is one Claude Code inserted rather than one the person typed: a background task's notification, a
 * command's output or caveat, a compaction's summary, the mark an interrupted request leaves.
 */
export function insertedText(text: string): boolean {
  const t = typedText(text).trimStart()
  return /^<[a-z][a-z0-9-]*>/.test(t) || t.startsWith('This session is being continued from a previous conversation') || t.startsWith('[Request interrupted by user')
}

/**
 * The person's message the current turn began with, from the newest of the transcript's messages: walked back from the end past the
 * messages Claude Code inserted after it (a background task's notification, a command's output), up to the model's message or a tool's
 * results, so an earlier turn's prompt is never taken. '' where there is none.
 */
export function personPrompt(messages: readonly { role?: unknown; text?: unknown; toolResults?: readonly unknown[] }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'user' || (m.toolResults?.length ?? 0) > 0) return ''
    // A message of Cowork's reminders alone holds nothing the person typed: the walk goes on past it.
    if (typeof m.text === 'string' && typedText(m.text).trim() !== '' && !insertedText(m.text)) return m.text
  }
  return ''
}

/** The rules a settings layer's `permissions.allow` lists; none for a layer of another shape. */
export function permissionRules(layer: unknown): string[] {
  const permissions = layer !== null && typeof layer === 'object' ? (layer as { permissions?: unknown }).permissions : undefined
  const allow = permissions !== null && typeof permissions === 'object' ? (permissions as { allow?: unknown }).allow : undefined
  return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string') : []
}

/**
 * What the person typed, from a Cowork prompt's text: without the `<system-reminder>` blocks Cowork puts ahead of it (the person's
 * timezone and the time it was sent), as Claude Code's own prompt rows carry it.
 */
export function typedText(text: string): string {
  return text.replace(/^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+\s*/, '')
}

/** A main-loop turn began with `text`: a new prompt id, and its `user_prompt` row. */
export function promptRow(state: Rowless, head: Attrs, text: string, atMs: number, promptId: string): RowIn {
  state.promptId = promptId
  // Claude Code logs the length as a string, and the text as redacted unless prompts are logged: the gate adds it where it allows.
  return row(state, head, 'user_prompt', atMs, [['prompt_length', String(text.length)], ['prompt', '<REDACTED>'], ['prompt_text', '<REDACTED>']])
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
  /** The subagent's type and whether Claude Code ships it, as its spawn said; undefined where no spawn was seen. */
  agent?: { type: string; builtIn: boolean }
  startMs: number
  endMs: number
  firstChunkMs?: number
  /** The request's cost: what the session's grew by since the last reading (`costOf`); undefined where it could not be read. */
  costUsd?: number
  /** Whether the session is a print or SDK session: its main loop's requests' `query_source` is `sdk` there. */
  sdk: boolean
}

const whole = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined)

/**
 * What the session's cost grew by since the last reading taken: the share of the request that just ended, or of what the session
 * spent outside its requests. The caller takes readings one at a time, in order, so the shares sum to the session's cost, never more.
 * A reading below the last means the session's cost started over (a /clear): all of it is new. Undefined where it could not be read.
 */
export function costOf(state: Rowless, sessionCostUsd: number | undefined): number | undefined {
  if (sessionCostUsd === undefined || !Number.isFinite(sessionCostUsd) || sessionCostUsd < 0) return undefined
  const before = state.costUsd ?? 0
  state.costUsd = sessionCostUsd
  if (sessionCostUsd < before) return sessionCostUsd
  return Math.round((sessionCostUsd - before) * 1e10) / 1e10
}

/**
 * Where the shares start, at the first reading after the rows began to be built or the session changed (`sinceMs`; `previous`, the
 * baseline before a change). A session that began well before then (a resume counts from its first launch, a reload from the
 * session's start) had its cost so far sent already, by an earlier load, process or session: the shares start from its cost now. One
 * that began then starts from nothing, unless its cost carried on from the session before (a /clear that keeps the ledger): then from
 * where that one's left off.
 */
export function seedCost(state: Rowless, usage: { startedAt?: number; costUsd?: number }, sinceMs: number, previous?: number): void {
  if (state.costUsd !== undefined) return
  const earlier = typeof usage.startedAt === 'number' && usage.startedAt < sinceMs - SEED_MS
  if (earlier) state.costUsd = usage.costUsd ?? 0
  else state.costUsd = previous !== undefined && usage.costUsd !== undefined && usage.costUsd >= previous ? previous : 0
}

/** How long before the plugin loaded a session must have begun for its cost so far to be an earlier load's or process's. */
export const SEED_MS = 30_000

/**
 * Which of Claude Code's refusals a failed call's text is: the person's answer no (`reject`), the person's turn interrupted while it
 * asked (`abort`), or its refusal of an ask nobody could answer (`not_asked`). Undefined for any other text.
 */
export function refusalKind(text: unknown): 'reject' | 'abort' | 'not_asked' | undefined {
  if (typeof text !== 'string') return undefined
  return text.includes(REFUSED_BY_PERSON) ? 'reject' : text.includes(INTERRUPTED) ? 'abort' : NOT_ASKED.test(text) ? 'not_asked' : undefined
}

/** The start of the text Claude Code gives the model for a call the person refused. */
const REFUSED_BY_PERSON = "The user doesn't want to proceed with this tool use"
/** The start of the text Claude Code gives the model for a call cut off by the person's interruption. */
const INTERRUPTED = "The user doesn't want to take this action right now"
/** The text Claude Code gives the model for a call it could not ask anyone about. */
const NOT_ASKED = /Permission to use \S+ has been denied/

/** A model request answered: its `api_request` row, under Claude Code's attribute names and types. */
export function requestRow(state: Rowless, head: Attrs, f: RequestFacts): RowIn {
  const u = f.usage
  const cost = f.costUsd
  const effort = typeof f.effort === 'string' ? f.effort : undefined
  // Claude Code writes both lifetimes, 0 where no write named one.
  const noLifetime = u.ephemeral_5m_input_tokens === undefined && u.ephemeral_1h_input_tokens === undefined ? 0 : undefined
  const source = querySourceOf(f.agentId, f.agent, f.sdk)
  return row(state, head, 'api_request', f.endMs, [
    ['model', u.model ?? f.model],
    ['input_tokens', whole(u.input_tokens) ?? 0],
    ['output_tokens', whole(u.output_tokens) ?? 0],
    ['cache_read_tokens', whole(u.cache_read_input_tokens) ?? 0],
    ['cache_creation_tokens', whole(u.cache_creation_input_tokens) ?? 0],
    ['cache_creation_5m_tokens', whole(u.ephemeral_5m_input_tokens) ?? noLifetime],
    ['cache_creation_1h_tokens', whole(u.ephemeral_1h_input_tokens) ?? noLifetime],
    ['cost_usd', cost],
    ['cost_usd_micros', cost === undefined ? undefined : Math.round(cost * 1e6)],
    ['duration_ms', Math.max(0, Math.round(f.endMs - f.startMs))],
    ['ttft_ms', f.firstChunkMs === undefined ? undefined : Math.max(0, Math.round(f.firstChunkMs - f.startMs))],
    // A subagent's requests by its type, from its spawn; `agent:custom` where none was seen, which still reads as a subagent's.
    ['query_source', source],
    ['effort', effort],
    ['agent_id', f.agentId],
    ['agent.name', f.agent?.type],
  ])
}

/**
 * A model request that answered with text: its `assistant_response` row, after its request row, as Claude Code logs one. The length
 * is the text's as the stream gave it; the text, redacted here, is the gate's to add where `response.text` is on.
 */
export function responseRow(state: Rowless, head: Attrs, r: { length: number; model: string; agentId?: string; agent?: { type: string; builtIn: boolean }; sdk: boolean; atMs: number }): RowIn {
  return row(state, head, 'assistant_response', r.atMs, [
    ['response_length', r.length],
    ['response', '<REDACTED>'],
    ['model', r.model],
    ['query_source', querySourceOf(r.agentId, r.agent, r.sdk)],
    ['agent_id', r.agentId],
  ])
}

/**
 * The text a request answered with, for its response row: the step's own visible answer, where it gave one. Where the stream's
 * pieces, joined as Claude Code joins a response's blocks, read the same with whitespace aside, the stream's (Claude Code's own
 * spelling of the blocks' join). None where the answer is empty or blank.
 */
export function responseTextOf(answer: unknown, streamed: string | undefined): string | undefined {
  if (typeof answer !== 'string' || answer.trim() === '') return undefined
  if (streamed !== undefined && streamed.replace(/\s+/g, '') === answer.replace(/\s+/g, '')) return streamed
  return answer
}

/** A request's `query_source` as Claude Code names it: the main loop's by how the session runs, a subagent's by its type. */
function querySourceOf(agentId: string | undefined, agent: { type: string; builtIn: boolean } | undefined, sdk: boolean): string {
  if (agentId === undefined) return sdk ? 'sdk' : 'repl_main_thread'
  return agent === undefined ? 'agent:custom' : `agent:${agent.builtIn ? 'builtin' : 'custom'}:${agent.type}`
}

/**
 * A tool call's permission decision: its `tool_decision` row, at the time it was settled (`decisionOf`). Built once the call ends, as
 * only then is it known whether an ask was refused.
 */
export function decisionRow(state: Rowless, head: Attrs, call: { tool: string; id: string; agentId?: string; refused: boolean; source?: string }, atMs: number): RowIn {
  return row(state, head, 'tool_decision', atMs, [
    ['decision', call.refused ? 'reject' : 'accept'],
    ['source', call.source],
    ['tool_name', call.tool],
    ['tool_use_id', call.id],
    ['tool_source', call.tool.startsWith('mcp__') ? 'mcp' : 'builtin'],
    ['agent_id', call.agentId],
  ])
}

/**
 * A tool call's permission check, as `tool.check` answered it and when: its verdict, what it names behind it, and who answers an ask
 * (`approver`: `person` or `host`; absent where nobody can be asked).
 */
export type Verdict = { decision?: string; rule?: string; hook?: string; setting?: string; reason?: string; approver?: string; atMs?: number }

/**
 * Who decided a call the check settled by itself, under Claude Code's names: a hook (`hook`), else the session's rules, settings or
 * mode (`config`, as Claude Code names every decision it reached alone). Undefined for an ask, which someone else settles.
 */
export function decisionSource(v: Verdict | undefined): string | undefined {
  if (v === undefined || v.decision === 'ask') return undefined
  return typeof v.hook === 'string' ? 'hook' : 'config'
}

/** What a call's events say of how its permission was settled, beside its check's verdict. */
export type Settling = {
  verdict?: Verdict
  /** What auto mode's classifier answered about the call (`tool.judge`), where it was asked. */
  judged?: string
  /** When the call began to run, allowed (`tool.run`); undefined where it never ran. */
  ranAtMs?: number
  /** After an ask the call was allowed, and the same check now allows it by a rule written in a settings file: the answer was saved. */
  permanent?: boolean
  startMs: number
  endMs: number
  /** A hook refused the call (`{ deny }`). */
  denied: boolean
  isError: boolean
  text?: unknown
}

/**
 * Whether a call was refused, who settled its permission (Claude Code's `source`), and when (the decision row's time, which ends its
 * `blocked_on_user` span):
 *
 * - a verdict the check reached alone (`allow`, `deny`): `hook` or `config`, settled as the call began to run, or as the check refused it;
 * - an ask, then run: `config` where auto mode's classifier or, nobody being there to ask, Claude Code itself settled it; else the
 *   person's or the host's answer, `user_permanent` where they saved it in a settings file (the check now allows the call by a rule
 *   written there), else `user_temporary` (allowed once, or for the session). Settled as it began to run;
 * - an ask that never ran and ended refused: `config` where the classifier refused it or nobody could be asked; `user_reject` for the
 *   person's no or the host's; `user_abort` where the person's turn was interrupted while it asked. Settled as the call ended.
 *
 * What the events cannot tell apart: a settings hook on the permission request (Claude Code's `hook`) reads as whoever else could have
 * answered: the person (no source where it refused), or `config`. A call no check saw (a hook refused it first) is refused only where it
 * was denied, and names no source.
 */
export function decisionOf(s: Settling): { refused: boolean; source?: string; atMs: number } {
  const v = s.verdict
  const runAt = s.ranAtMs ?? v?.atMs ?? s.startMs
  if (v?.decision === 'deny') return { refused: true, ...sourced(decisionSource(v)), atMs: v.atMs ?? s.startMs }
  if (v?.decision !== 'ask') return { refused: s.denied, ...sourced(decisionSource(v)), atMs: s.denied ? s.endMs : runAt }
  const nobody = v.approver !== 'person' && v.approver !== 'host'
  if (s.ranAtMs !== undefined) {
    const source = s.judged === 'allow' || nobody ? 'config' : s.permanent === true ? 'user_permanent' : 'user_temporary'
    return { refused: false, source, atMs: s.ranAtMs }
  }
  if (!s.denied && !s.isError) return { refused: false, atMs: s.startMs }
  const kind = refusalKind(s.text)
  const source = s.judged === 'deny' || nobody || kind === 'not_asked' ? 'config'
    : kind === 'abort' ? 'user_abort'
    : kind === 'reject' || v.approver === 'host' ? 'user_reject'
    : undefined
  return { refused: true, ...sourced(source), atMs: s.endMs }
}

const sourced = (source: string | undefined) => (source === undefined ? {} : { source })

/** A string's size in bytes of UTF-8, as Claude Code counts a tool's input and result. */
const bytes = (text: string) => new TextEncoder().encode(text).length

/**
 * A tool call ended: its `tool_result` row, its outcome and duration as strings, as Claude Code logs them. The duration is the run's,
 * from when the call began to run once allowed (`runStartMs`), as Claude Code times it; from the call's start where that is not known.
 * A call that made a commit names it and its branch (`vcs.ref.head.*`), as Claude Code's result row does.
 */
export function resultRow(
  state: Rowless,
  head: Attrs,
  call: {
    tool: string; id: string; agentId?: string; startMs: number; runStartMs?: number; endMs: number; isError: boolean; input?: Readonly<Record<string, unknown>>; text?: string
    commit?: MadeCommit
  },
): RowIn {
  const from = call.runStartMs !== undefined && call.runStartMs <= call.endMs ? call.runStartMs : call.startMs
  return row(state, head, 'tool_result', call.endMs, [
    ['tool_name', call.tool],
    ['tool_use_id', call.id],
    ['success', call.isError ? 'false' : 'true'],
    ['duration_ms', String(Math.max(0, Math.round(call.endMs - from)))],
    ['tool_input_size_bytes', call.input === undefined ? undefined : String(bytes(JSON.stringify(call.input)))],
    ['tool_result_size_bytes', call.text === undefined || call.isError ? undefined : String(bytes(call.text))],
    ['vcs.ref.head.revision', call.commit?.commitId],
    ['vcs.ref.head.name', call.commit?.branch],
    ['vcs.ref.head.type', call.commit?.branch === undefined ? undefined : 'branch'],
    ['agent_id', call.agentId],
  ])
}
