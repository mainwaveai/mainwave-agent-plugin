// The markers: the spans Mainwave's CLI hooks send for work an agent did outside Claude Code's own telemetry, which the plugin sends
// in the same shapes, keyless, when the CLI's hook for one is not there to send it. Pure: the hooks module wires them (register.ts),
// and the lookups they need (git, gh) are run through what it hands in.
//
//   vcs.commit.created     a commit `git commit` made: its full name, its first parent, and its lines and files, in all and per file
//   vcs.change.opened      a pull request `gh pr create` opened (GitHub), or a merge request glab opened (GitLab, glab.ts)
//   work.item.created      a Linear or Jira ticket an MCP tool created, or updated (`work.item.updated`)
//   mainwave.subscription.snapshot   the Claude plan and its usage limits, on each prompt (snapshot.ts)
//   mainwave.claude_code.stop_failure  the kind of API error a turn ended on
//
// Each span sits in a trace of its own, as the CLI's do (Mainwave keys a marker's run on its trace), and names the span it was made
// in (`mainwave.caller.*`), the tool call (`gen_ai.tool.call.id`) and the subagent (`mainwave.subagent.id`). Its resource names its
// source (`mainwave.source`, `hook.<vendor>`) and the tool it ran in, as the CLI's do.
//
// Only what the result proves is sent: a failed commit prints no commit line, a failed create prints no URL, a failed save names no
// ticket. Never a file's contents, a diff, a commit message, a ticket's title or body, or the error's text.

import type { TelemetryAttribute } from 'claude-code'

import { commandWords, shellSegments } from './glab.ts'

// ── Names ─────────────────────────────────────────────────────────────────────

export const COMMIT_CREATED = 'vcs.commit.created'
export const CHANGE_OPENED = 'vcs.change.opened'
export const WORK_ITEM_CREATED = 'work.item.created'
export const WORK_ITEM_UPDATED = 'work.item.updated'
export const SUBSCRIPTION_SNAPSHOT = 'mainwave.subscription.snapshot'
export const STOP_FAILURE = 'mainwave.claude_code.stop_failure'
export const STOP_FAILURE_ERROR = 'mainwave.claude_code.stop_failure.error'

/** Every span name a marker may carry. */
export const MARKER_SPANS: readonly string[] = [COMMIT_CREATED, CHANGE_OPENED, WORK_ITEM_CREATED, WORK_ITEM_UPDATED, SUBSCRIPTION_SNAPSHOT, STOP_FAILURE]

/** The calling-span keys: where in the session the marker was made. Ids only. */
export const CALLER_TRACE_ID = 'mainwave.caller.trace_id'
export const CALLER_SPAN_ID = 'mainwave.caller.span_id'
export const TOOL_CALL_ID = 'gen_ai.tool.call.id'
export const SUBAGENT_ID = 'mainwave.subagent.id'

/**
 * The CLI's hook routes, each the marker kind it delivers: `<Event>[ <route>]` as the CLI's managed hooks block runs its entry,
 * `mainwave-hook.sh claude-code <Event> [<route>]`.
 */
export type MarkerKind = 'git' | 'gh' | 'glab' | 'linear' | 'jira' | 'snapshot' | 'stop'
export const CLI_ROUTES: Readonly<Record<MarkerKind, string>> = {
  git: 'PostToolUse git',
  gh: 'PostToolUse gh',
  glab: 'PostToolUse glab',
  linear: 'PostToolUse linear',
  jira: 'PostToolUse jira',
  snapshot: 'UserPromptSubmit',
  stop: 'StopFailure',
}

/** Each kind's `mainwave.source` and `service.name`, as the CLI's markers carry them. */
export const MARKER_ORIGINS: Readonly<Record<MarkerKind, { source: string; service: string }>> = {
  git: { source: 'hook.git', service: 'mainwave.git-hook' },
  gh: { source: 'hook.github', service: 'mainwave.pr-hook' },
  glab: { source: 'hook.gitlab', service: 'mainwave.mr-hook' },
  linear: { source: 'hook.linear', service: 'mainwave.ticket-hook' },
  jira: { source: 'hook.jira', service: 'mainwave.ticket-hook' },
  snapshot: { source: 'hook.anthropic', service: 'mainwave.plan-hook' },
  stop: { source: 'hook.anthropic', service: 'mainwave.plan-hook' },
}

/** The tool a marker ran in, as Mainwave names Claude Code's source. */
export const HOST_SOURCE = 'coding_agent.claude_code'
/** The vocabulary version every marker's resource names. */
export const SCHEMA_VERSION = '2'

/**
 * A marker's resource: the session's (`OTEL_RESOURCE_ATTRIBUTES` as the exporter reads it), with its source, service, host and
 * vocabulary version set over it, as the CLI's markers have theirs. Claude Code's own version is not the marker's.
 */
export function markerResource(base: Readonly<Record<string, string>>, kind: MarkerKind): Record<string, string> {
  const { 'service.version': _version, 'mainwave.host_source': _host, 'mainwave.cli.version': _cli, ...rest } = base
  return { ...rest, 'mainwave.source': MARKER_ORIGINS[kind].source, 'service.name': MARKER_ORIGINS[kind].service, 'mainwave.host_source': HOST_SOURCE, 'mainwave.schema.version': SCHEMA_VERSION }
}

/** One marker as the hooks module queues it: its kind, name and attributes. Plain data. */
export type Marker = { kind: MarkerKind; name: string; attributes: Record<string, TelemetryAttribute> }

/**
 * Each marker's key: the attribute that names what it is about (a commit's SHA, a pull request's address, a ticket's key), and the
 * data point that attribute belongs to. With that data point off, or the key gone through the gate, the marker is not sent at all
 * (gate.ts, `gateMarker`), as Mainwave could neither count nor join it. The snapshot is its own data point; a turn's failure is usage,
 * always sent.
 */
export const MARKER_KEYS: Readonly<Record<string, { attribute: string; point?: 'repo' | 'work.item' | 'account.plan' }>> = {
  [COMMIT_CREATED]: { attribute: 'vcs.commit.sha', point: 'repo' },
  [CHANGE_OPENED]: { attribute: 'vcs.repository.url.full', point: 'repo' },
  [WORK_ITEM_CREATED]: { attribute: 'work.item.id', point: 'work.item' },
  [WORK_ITEM_UPDATED]: { attribute: 'work.item.id', point: 'work.item' },
  [SUBSCRIPTION_SNAPSHOT]: { attribute: 'mainwave.subscription.provider', point: 'account.plan' },
  [STOP_FAILURE]: { attribute: STOP_FAILURE_ERROR },
}

// ── Where the CLI sends them already ──────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Where the CLI installs its hooks' entry, under the home folder. */
export const CLI_ENTRY = '.mainwave/hooks/managed/mainwave-hook.sh'

/**
 * The script a CLI hook command runs: the path it names for `mainwave-hook.sh` (`f="$HOME/.../mainwave-hook.sh"`, or written out),
 * `$HOME`, `${HOME}` and `~` read as the home folder; else the CLI's own place for it. The command does nothing where the script is
 * not there (`[ -f "$f" ] && ...`), as on a machine the CLI was never installed on.
 */
export function cliScriptOf(command: string, home: string | undefined): string | undefined {
  const named = command.match(/(?:^|[\s="'])((?:\$\{?HOME\}?|~)?[^\s"';&|]*mainwave-hook\.sh)/)?.[1]
  // A name that is not a path from the home folder or the root is read as the CLI's own place.
  const raw = named !== undefined && /^(?:\$\{?HOME\}?\/|~\/|\/|[A-Za-z]:[\\/])/.test(named) ? named : `$HOME/${CLI_ENTRY}`
  const expanded = raw.replace(/^(?:\$\{HOME\}|\$HOME|~)(?=\/)/, home ?? '\0')
  return expanded.includes('\0') || expanded.includes('$') || !expanded.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(expanded) ? undefined : expanded
}

/**
 * The marker kinds whose CLI hook the merged settings run, each with the scripts its commands run: a hook command that runs the CLI's
 * entry, `mainwave-hook.sh`, for that exact route (`... claude-code PostToolUse git;`), as the CLI itself tells its managed hooks. A
 * command whose script can't be named is left out.
 */
export function cliHookKinds(settings: unknown, home?: string): Map<MarkerKind, string[]> {
  const out = new Map<MarkerKind, string[]>()
  const hooks = isObject(settings) && isObject(settings['hooks']) ? settings['hooks'] : undefined
  if (hooks === undefined) return out
  for (const [kind, route] of Object.entries(CLI_ROUTES) as [MarkerKind, string][]) {
    const event = route.split(' ')[0]!
    const groups = hooks[event]
    if (!Array.isArray(groups)) continue
    const want = ` claude-code ${route}`
    for (const group of groups) {
      const entries = isObject(group) && Array.isArray(group['hooks']) ? group['hooks'] : []
      for (const h of entries) {
        const command = isObject(h) && typeof h['command'] === 'string' ? h['command'] : ''
        const at = command.indexOf(want)
        if (!command.includes('mainwave-hook.sh') || at === -1) continue
        // The route ends there: `git` is not `github`.
        const next = command.charAt(at + want.length)
        const script = cliScriptOf(command, home)
        if ((next === '' || next === ';' || /\s/.test(next)) && script !== undefined) out.set(kind, [...new Set([...(out.get(kind) ?? []), script])])
      }
    }
  }
  return out
}

/**
 * Whether the CLI's hooks can send in this session: they send only with a key, from Claude Code's exporter settings, so an endpoint
 * and an `Authorization` header (or a headers helper, which supplies one). With the hooks configured but no key (an organization that
 * took its env block out), the CLI sends nothing and the plugin's markers stand in.
 */
export function cliCanSend(endpoint: string | undefined, headers: string | undefined, headersHelper: unknown): boolean {
  if ((endpoint ?? '').trim() === '') return false
  if (typeof headersHelper === 'string' && headersHelper.trim() !== '') return true
  return (headers ?? '').split(',').some(pair => {
    const eq = pair.indexOf('=')
    return eq > 0 && pair.slice(0, eq).trim().toLowerCase() === 'authorization' && pair.slice(eq + 1).trim() !== ''
  })
}

// ── Commits ───────────────────────────────────────────────────────────────────

/** The most commits one tool call reports; the most files a span lists one by one; and past this many bytes of paths, the lists stop. */
export const MAX_COMMITS = 20
export const MAX_FILES = 2000
export const MAX_PATH_BYTES = 128 * 1024

// A shell word: double-quoted, single-quoted, or bare.
const WORD = `(?:"[^"]*"|'[^']*'|[^\\s;&|()]+)`
// git's global options before the subcommand: `-C <dir>`, `-c <k=v>`, and `--flag` / `--flag=value`.
const GLOBAL_OPTS = `((?:\\s+-[Cc]\\s+${WORD}|\\s+--[A-Za-z-]+(?:=${WORD})?)*)`
// `git commit` at a command position, `VAR=value` prefixes allowed. `commit-tree` and `commit-graph` are other commands.
const GIT_COMMIT = new RegExp(`(?:^|&&|\\|\\||[;|\\n({]|\\$\\(|\\b(?:then|do|else)\\s)\\s*(?:[A-Za-z_][A-Za-z0-9_]*=${WORD}?\\s+)*git${GLOBAL_OPTS}\\s+commit(?![\\w-])`, 'g')

const unquote = (w: string) => (/^(["']).*\1$/.test(w) ? w.slice(1, -1) : w)
const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
/** `dir` against `base`: itself when absolute, else joined. */
export const against = (base: string | undefined, dir: string): string => (base === undefined || isAbsolute(dir) ? dir : `${base.replace(/[\\/]+$/, '')}/${dir}`)

/** Every `git commit` in a shell command, each with the folder its `-C` options name (relative to the command's own), if any. */
export function gitCommits(command: unknown): { dir?: string }[] {
  if (typeof command !== 'string' || !command.includes('commit')) return []
  const out: { dir?: string }[] = []
  for (const m of command.matchAll(GIT_COMMIT)) {
    const dirs = [...(m[1] ?? '').matchAll(new RegExp(`-C\\s+(${WORD})`, 'g'))].map(d => unquote(d[1]!))
    const dir = dirs.reduce<string | undefined>((a, d) => against(a, d), undefined)
    out.push(dir === undefined ? {} : { dir })
  }
  return out
}

// git's line for a new commit: `[main 1a2b3c4] subject`, also `[main (root-commit) 1a2b3c4]` and `[detached HEAD 1a2b3c4]`.
const COMMIT_LINE = /^\[[^\n]*? ([0-9a-f]{7,64})\] /gm

/** The texts of a shell tool's result: Bash's `{ stdout, stderr }`, or a plain string. */
export function outputTexts(result: unknown): string[] {
  if (typeof result === 'string') return [result]
  if (isObject(result)) return [result['stdout'], result['stderr']].filter((t): t is string => typeof t === 'string')
  return []
}

/** The short names of the commits a result reports, in order, each once; none for a result with no commit line. */
export function commitsInOutput(texts: readonly string[]): string[] {
  const shas: string[] = []
  for (const text of texts) for (const m of text.matchAll(COMMIT_LINE)) if (!shas.includes(m[1]!)) shas.push(m[1]!)
  return shas.slice(0, MAX_COMMITS)
}

/** The arguments of the lookup for one commit: its name and parents, then one record per file, NUL-separated. */
export const commitLookup = (shortSha: string): string[] => [
  'git', '--no-pager', '-c', 'core.fsmonitor=false', 'show', '--no-color', '--no-ext-diff', '--no-textconv', '-z', '--numstat', '--format=%H%n%P', shortSha, '--',
]

export type Commit = { sha: string; parents: string[]; files: { path: string; linesAdded: number; linesRemoved: number; isBinary: boolean }[] }

/**
 * `git show -z --numstat --format=%H%n%P` output: the commit's name and parents, then one record per file. A record is
 * `<added>\t<removed>\t<path>\0`, or for a rename `<added>\t<removed>\t\0<old path>\0<new path>\0` (the new path is kept). A binary
 * file's counts are `-`: it counts with 0 and 0, flagged. Undefined for anything that does not parse.
 */
export function parseNumstat(stdout: unknown): Commit | undefined {
  if (typeof stdout !== 'string') return undefined
  const headEnd = stdout.indexOf('\0')
  if (headEnd === -1) return undefined
  const [sha = '', parentLine = ''] = stdout.slice(0, headEnd).split('\n')
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return undefined
  const parents = parentLine.split(' ').filter(Boolean)
  if (!parents.every(p => /^[0-9a-f]{40,64}$/.test(p))) return undefined
  const tokens = stdout.slice(headEnd + 1).replace(/^\n/, '').split('\0')
  const count = (raw: string) => (raw === '-' ? undefined : /^\d+$/.test(raw) ? Number(raw) : Number.NaN)
  const files: Commit['files'] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '') continue
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token)
    if (!m) return undefined
    let path: string | undefined = m[3]!
    if (path === '') {
      path = tokens[i + 2]
      i += 2
    }
    if (typeof path !== 'string' || path === '') return undefined
    const added = count(m[1]!)
    const removed = count(m[2]!)
    if (Number.isNaN(added) || Number.isNaN(removed)) return undefined
    const isBinary = added === undefined || removed === undefined
    files.push({ path, linesAdded: isBinary ? 0 : added!, linesRemoved: isBinary ? 0 : removed!, isBinary })
  }
  return { sha, parents, files }
}

/** A commit's span attributes: the totals over every file, and the per-file lists up to `MAX_FILES` files and `MAX_PATH_BYTES` of paths. */
export function commitAttributes(c: Commit): Record<string, TelemetryAttribute> {
  const listed: Commit['files'] = []
  let pathBytes = 0
  const encoder = new TextEncoder()
  for (const f of c.files) {
    pathBytes += encoder.encode(f.path).length
    if (listed.length >= MAX_FILES || pathBytes > MAX_PATH_BYTES) break
    listed.push(f)
  }
  const sum = (k: 'linesAdded' | 'linesRemoved') => c.files.reduce((n, f) => n + f[k], 0)
  // Lists of numbers and of flags: OTLP arrays of ints and bools, which the attribute type does not spell (otlp.ts writes any list).
  const list = (values: readonly (number | boolean | string)[]) => values as unknown as TelemetryAttribute
  return {
    'vcs.commit.sha': c.sha,
    ...(c.parents[0] !== undefined ? { 'vcs.commit.parent_sha': c.parents[0] } : {}),
    'vcs.commit.parent_count': c.parents.length,
    'vcs.commit.files_changed': c.files.length,
    'vcs.commit.lines_added': sum('linesAdded'),
    'vcs.commit.lines_removed': sum('linesRemoved'),
    'vcs.commit.file.paths': listed.map(f => f.path),
    'vcs.commit.file.lines_added': list(listed.map(f => f.linesAdded)),
    'vcs.commit.file.lines_removed': list(listed.map(f => f.linesRemoved)),
    'vcs.commit.file.is_binary': list(listed.map(f => f.isBinary)),
  }
}

// ── GitHub pull requests ──────────────────────────────────────────────────────

/**
 * `gh pr create` in a shell command, as a command of its own (not inside a message or an `echo`; after assignments and wrapper words such as `env` or `then`), with the title it gives (`--title`,
 * `-t`), where that is written out: a title the shell would expand (`"$TITLE"`, `"$(git log ...)"`) is not the title, and goes as none.
 */
export function prCreateOf(command: unknown): { title?: string } | undefined {
  for (const segment of shellSegments(command)) {
    const words = commandWords(segment)
    if (!/(^|\/)gh(\.exe)?$/.test(words[0] ?? '') || words[1] !== 'pr' || words[2] !== 'create') continue
    let title: string | undefined
    for (let j = 3; j < words.length; j++) {
      const w = words[j]!
      if (w === '--title' || w === '-t') title = words[j + 1]
      else if (w.startsWith('--title=')) title = w.slice('--title='.length)
      else if (/^-t.+/.test(w)) title = w.slice(2)
    }
    return title !== undefined && title !== '' && !title.includes('$') && !title.includes('`') ? { title } : {}
  }
  return undefined
}

/** Whether a shell command opens a pull request. */
export const isPrCreate = (command: unknown): boolean => prCreateOf(command) !== undefined

/**
 * The opened pull request's address, from what `gh pr create` printed; undefined when it printed none (`--web`, a failure), or when it
 * says the request already exists: then it opened nothing, whatever the command's exit.
 */
export function prUrlOf(texts: readonly string[]): string | undefined {
  // gh's own words for it; another command of the chain may say something else already exists.
  if (texts.some(t => /a pull request for branch .* already exists/i.test(t))) return undefined
  for (const text of texts) {
    const m = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)
    if (m) return m[0]
  }
  return undefined
}

/** The number at the end of a pull request's address. */
export const prNumberOf = (url: string): string | undefined => url.match(/\/pull\/(\d+)/)?.[1]

/** The arguments of the lookup for a pull request's size, by its address (so its own repository's, wherever it ran): three counts, never the diff. */
export const prLookup = (url: string): string[] => ['gh', 'pr', 'view', url, '--json', 'changedFiles,additions,deletions']

/** The three counts from `gh pr view --json changedFiles,additions,deletions`, each where it is an integer. */
export function parsePrStats(stdout: unknown): { changedFiles?: number; additions?: number; deletions?: number } {
  let json: unknown
  try {
    json = typeof stdout === 'string' ? JSON.parse(stdout) : undefined
  } catch {
    return {}
  }
  if (!isObject(json)) return {}
  const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : undefined)
  const out: { changedFiles?: number; additions?: number; deletions?: number } = {}
  const [files, added, removed] = [int(json['changedFiles']), int(json['additions']), int(json['deletions'])]
  if (files !== undefined) out.changedFiles = files
  if (added !== undefined) out.additions = added
  if (removed !== undefined) out.deletions = removed
  return out
}

/** A pull request's span attributes: its address and number, the provider, its title where the command gave one, and its size. */
export function prAttributes(url: string, number: string, title: string | undefined, stats: ReturnType<typeof parsePrStats>): Record<string, TelemetryAttribute> {
  return {
    'vcs.repository.url.full': url,
    'vcs.change.id': number,
    'vcs.provider.name': 'github',
    ...(title !== undefined && title !== '' ? { 'vcs.change.title': title } : {}),
    ...(stats.changedFiles !== undefined ? { 'vcs.change.files_changed': stats.changedFiles } : {}),
    ...(stats.additions !== undefined ? { 'vcs.change.lines_added': stats.additions } : {}),
    ...(stats.deletions !== undefined ? { 'vcs.change.lines_removed': stats.deletions } : {}),
  }
}

// ── Tickets ───────────────────────────────────────────────────────────────────

/** The MCP tools that save a Linear issue, and those that create or edit a Jira issue, as the CLI's managed hooks match them. */
export const LINEAR_TOOL = /^mcp__.*[Ll]inear.*_(save|create|update)_issue$/
export const JIRA_TOOL = /^mcp__.*[Aa]tlassian.*__(createJiraIssue|editJiraIssue)$/

const KEY = '[A-Z][A-Z0-9]+-\\d+'
const isIssueKey = (v: unknown): v is string => typeof v === 'string' && new RegExp(`^${KEY}$`, 'i').test(v)

/**
 * An MCP tool's result as an object: its JSON, the JSON in the text of its content blocks (`[{ type: 'text', text }]`, bare or under
 * `content`), or the object itself. Undefined for text that is not JSON.
 */
export function resultObject(result: unknown): Record<string, unknown> | undefined {
  let v = result
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return undefined
    }
  }
  if (isObject(v) && Array.isArray(v['content'])) v = v['content']
  if (Array.isArray(v)) {
    const text = v.map(b => (isObject(b) && typeof b['text'] === 'string' ? b['text'] : '')).join('')
    try {
      v = JSON.parse(text)
    } catch {
      return undefined
    }
  }
  return isObject(v) ? v : undefined
}

/**
 * A Linear save's ticket: its key from the result's own fields (`identifier`, `issueIdentifier`, `id`, else the issue segment of its
 * `url`), never from its text, which can name other tickets; a plain-text result only where `issue` names the key. Its address and
 * its team's ID where the result gives them, and whether the save created or updated it: by the tool's name where it says, else by
 * whether the call named an issue.
 */
export function linearTicket(tool: string, input: Readonly<Record<string, unknown>>, result: unknown): Record<string, TelemetryAttribute> | undefined {
  const obj = resultObject(result)
  let key: string | undefined
  let url: string | undefined
  let instance: string | undefined
  if (obj) {
    key = [obj['identifier'], obj['issueIdentifier'], obj['id']].find(isIssueKey)?.toUpperCase()
    const rawUrl = typeof obj['url'] === 'string' ? obj['url'] : undefined
    key ??= rawUrl?.match(new RegExp(`/issue/(${KEY})(?:[/?#]|$)`, 'i'))?.[1]?.toUpperCase()
    // Up to the key: the slug after it is the ticket's title.
    const issue = rawUrl?.match(new RegExp(`^(https?://[^?#]*?/issue/${KEY})(?=[/?#]|$)`, 'i'))?.[1]
    if (issue !== undefined) url = issue
    const team = obj['teamId'] ?? (isObject(obj['team']) ? obj['team']['id'] : undefined)
    if (typeof team === 'string' && team !== '') instance = team
  } else if (typeof result === 'string') {
    key = result.match(new RegExp(`issue[\\/\\s]+(${KEY})`, 'i'))?.[1]?.toUpperCase()
  }
  if (key === undefined) return undefined
  const op = tool.endsWith('create_issue') ? 'created' : tool.endsWith('update_issue') ? 'updated' : input['id'] ? 'updated' : 'created'
  return ticketAttributes('linear', key, op, url, instance)
}

/**
 * A Jira create or edit's ticket: its key from the issue the result names (`issues.nodes[0]`, or the result itself), `key` or `id`;
 * its `webUrl` where it is an issue's; the site's `context.cloudId`; created for `createJiraIssue`, else updated.
 */
export function jiraTicket(tool: string, result: unknown): Record<string, TelemetryAttribute> | undefined {
  const obj = resultObject(result)
  const nodes = isObject(obj?.['issues']) ? (obj['issues'] as Record<string, unknown>)['nodes'] : undefined
  const node = Array.isArray(nodes) && nodes.length > 0 && isObject(nodes[0]) ? nodes[0] : obj
  const key = node ? [node['key'], node['id']].find(isIssueKey)?.toUpperCase() : undefined
  if (key === undefined) return undefined
  const rawUrl = typeof node?.['webUrl'] === 'string' ? node['webUrl'] : undefined
  const url = rawUrl !== undefined && new RegExp(`/(?:browse|issue)/${KEY}`, 'i').test(rawUrl) ? rawUrl : undefined
  const cloudId = isObject(obj?.['context']) ? (obj['context'] as Record<string, unknown>)['cloudId'] : undefined
  return ticketAttributes('jira', key, tool.endsWith('createJiraIssue') ? 'created' : 'updated', url, typeof cloudId === 'string' && cloudId !== '' ? cloudId : undefined)
}

function ticketAttributes(vendor: string, key: string, op: 'created' | 'updated', url: string | undefined, instance: string | undefined): Record<string, TelemetryAttribute> {
  return {
    'work.item.id': key,
    'work.item.op': op,
    ...(url !== undefined ? { 'work.item.url': url } : {}),
    'work.vendor': vendor,
    ...(instance !== undefined ? { 'work.instance': instance } : {}),
  }
}

/** A ticket's span name, by what the save did. */
export const ticketSpan = (attributes: Readonly<Record<string, TelemetryAttribute>>): string => (attributes['work.item.op'] === 'created' ? WORK_ITEM_CREATED : WORK_ITEM_UPDATED)

// ── Turn failures ─────────────────────────────────────────────────────────────

/** The kind of API error a turn ended on, as Claude Code names it (`rate_limit`, `overloaded`, ...): a word, never free text. */
export const errorTypeOf = (v: unknown): string | undefined => (typeof v === 'string' && /^[a-z_]{1,64}$/.test(v) ? v : undefined)

/**
 * The kind of API error recorded on one message of a transcript's text (JSON lines, its end at least): the `error` Claude Code puts
 * on the message it writes in place of the failed response (`isApiErrorMessage`), the word StopFailure carries. `null` while no line
 * of that message is there yet; undefined for a message that records no API error.
 */
export function apiErrorIn(text: string, messageId: string): string | undefined | null {
  for (const line of text.split('\n')) {
    if (!line.includes(messageId)) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(row) || row['uuid'] !== messageId) continue
    return row['isApiErrorMessage'] === true ? errorTypeOf(row['error']) : undefined
  }
  return null
}

// ── Ids ───────────────────────────────────────────────────────────────────────

/** An opaque id as a marker carries one: letters, digits and `_ . : -`, at most 256 characters; anything else is left out. */
export const opaqueId = (v: unknown): string | undefined => (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v.trim()) ? v.trim() : undefined)

/** The keys that place a marker in its session, each where it is known. */
export function placeAttributes(place: { caller?: { traceId: string; spanId: string }; toolCallId?: unknown; agentId?: unknown; promptId?: unknown }): Record<string, TelemetryAttribute> {
  const out: Record<string, TelemetryAttribute> = {}
  if (place.caller && /^[0-9a-f]{32}$/.test(place.caller.traceId) && /^[0-9a-f]{16}$/.test(place.caller.spanId)) {
    out[CALLER_TRACE_ID] = place.caller.traceId
    out[CALLER_SPAN_ID] = place.caller.spanId
  }
  const call = opaqueId(place.toolCallId)
  if (call !== undefined) out[TOOL_CALL_ID] = call
  const agent = opaqueId(place.agentId)
  if (agent !== undefined) out[SUBAGENT_ID] = agent
  const prompt = opaqueId(place.promptId)
  if (prompt !== undefined) out['prompt.id'] = prompt
  return out
}

/** The span a kind of marker makes first, for its key's data point (`MARKER_KEYS`). */
export const KIND_SPAN: Readonly<Record<MarkerKind, string>> = {
  git: COMMIT_CREATED, gh: CHANGE_OPENED, glab: CHANGE_OPENED, linear: WORK_ITEM_CREATED, jira: WORK_ITEM_CREATED, snapshot: SUBSCRIPTION_SNAPSHOT, stop: STOP_FAILURE,
}

/** The identity and session a marker carries, from the session's rows: as the CLI's markers carry them, and keyless ingest routes by. */
export const MARKER_IDENTITY: readonly string[] = ['organization.id', 'user.email', 'user.account_uuid', 'session.id']
