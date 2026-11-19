// The data-point catalog: every kind of information the plugin can send from a Claude Code or Cowork session, by ID, with its
// sensitivity class, the Claude Code switch that governs it, and the attributes it owns on the records the plugin sends. Pure.
//
// Mainwave keeps the catalog; `data-points.json`, beside this file, is a copy of it, and a test holds this file to that copy field by
// field (tests/catalog.test.ts). A change to a data point is made in Mainwave's catalog first, then copied here.
//
// The default each data point takes with no organization settings is in one table, `DEFAULTS`, below. The gate (gate.ts) reads it.

import { COMMAND_COUNTS, COMMAND_REFS } from './derive.ts'
import { CHANGE_OPENED, COMMIT_CREATED, WORK_ITEM_CREATED, WORK_ITEM_UPDATED } from './markers.ts'

/** A commit's size on its marker, and a pull request's: what a command did. */
const COMMIT_COUNTS = ['vcs.commit.parent_count', 'vcs.commit.files_changed', 'vcs.commit.lines_added', 'vcs.commit.lines_removed', 'vcs.commit.file.lines_added', 'vcs.commit.file.lines_removed', 'vcs.commit.file.is_binary']
const CHANGE_COUNTS = ['vcs.change.files_changed', 'vcs.change.lines_added', 'vcs.change.lines_removed']

/** A data point's ID: the contract the gate, Mainwave's settings and its readers share. */
export type DataPointId =
  | 'session.identity' | 'session.links' | 'session.client' | 'usage'
  | 'tool.call' | 'tool.mcp' | 'skill.name' | 'agent.type' | 'command.name' | 'bash.class' | 'bash.outcome' | 'file.kind' | 'web.domain' | 'account.plan'
  | 'repo' | 'file.path' | 'web.url' | 'work.item' | 'mcp.url'
  | 'bash.command' | 'change.title' | 'tool.input' | 'tool.result' | 'skill.text' | 'prompt.text' | 'response.text' | 'response.thinking'

/**
 * Metadata: names, counts, times, sizes and categories that Claude Code, a plugin or Mainwave defines. Identifiers: values that name a
 * person, or a specific file, repository, branch or web address. Content: text a person typed, the model wrote, or a tool read or
 * produced.
 */
export type DataClass = 'metadata' | 'identifiers' | 'content'

/**
 * The Claude Code settings that govern data points, which Mainwave's org-wide setup writes. One set to `0` keeps what it governs as
 * Claude Code sends it (gate.ts). `OTEL_LOG_ASSISTANT_RESPONSES` follows `OTEL_LOG_USER_PROMPTS` when unset, as in Claude Code.
 */
export type Switch = 'OTEL_LOG_TOOL_DETAILS' | 'OTEL_LOG_TOOL_CONTENT' | 'OTEL_LOG_USER_PROMPTS' | 'OTEL_LOG_ASSISTANT_RESPONSES' | 'OTEL_METRICS_INCLUDE_REPOSITORY'
export const SWITCHES: readonly Switch[] = ['OTEL_LOG_TOOL_DETAILS', 'OTEL_LOG_TOOL_CONTENT', 'OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_ASSISTANT_RESPONSES', 'OTEL_METRICS_INCLUDE_REPOSITORY']

export type DataPoint = {
  id: DataPointId
  /** What the settings page calls it. */
  name: string
  class: DataClass
  /** No switch: Mainwave cannot route, join or count spend without it. */
  required?: true
  /** The Claude Code setting that governs it, where one does. */
  switch?: Switch
  /** Data points it holds: it is on only when they all are. */
  holds?: readonly DataPointId[]
  /** The data point it adds detail to: it is on only when that one is. */
  needs?: DataPointId
  description: string
  example: string
}

export const CATALOG: readonly DataPoint[] = [
  { id: 'session.identity', name: 'Who sent it', class: 'identifiers', required: true, description: 'Who sent the record: Claude organization, account, email, and the ID Claude Code keeps per installation', example: 'ana@example.com' },
  { id: 'session.links', name: 'Record links', class: 'metadata', required: true, description: 'IDs that tie records together: session, prompt, request, tool call, trace and span', example: 'prompt.id 4f1c…' },
  { id: 'session.client', name: 'Client and version', class: 'metadata', required: true, description: "What ran the session (Claude Code version, entry point, Cowork surface, terminal, plan, provider, the plugin's version), the plugin's own status and the issues it hit, and Claude Code's own event rows", example: 'remote_cowork, 2.1.322' },
  { id: 'usage', name: 'Usage and cost', class: 'metadata', required: true, description: 'Model, tokens, cost, request time, time to first token, effort, stop reason, query source, the API error that ended a turn; prompt, response, tool input and result sizes', example: 'claude-opus-5-5, 2,914 output tokens, $0.04' },
  { id: 'tool.call', name: 'Tool calls', class: 'metadata', description: 'Each tool call: its name, duration, success and error class, and the permission decision and what made it', example: 'Edit, 412 ms, accepted by rule' },
  { id: 'tool.mcp', name: 'MCP server and tool', class: 'metadata', switch: 'OTEL_LOG_TOOL_DETAILS', description: 'The MCP server and tool of each MCP call, and where the server was set up: user, project, managed, a plugin, or a claude.ai connector', example: 'remote-devices / device_bash' },
  { id: 'skill.name', name: 'Skill', class: 'metadata', switch: 'OTEL_LOG_TOOL_DETAILS', description: "The skill used, third-party plugins' skills included", example: 'pdf' },
  { id: 'agent.type', name: 'Subagent type', class: 'metadata', switch: 'OTEL_LOG_TOOL_DETAILS', description: 'The type of each subagent started, custom ones included', example: 'Explore' },
  { id: 'command.name', name: 'Slash command', class: 'metadata', description: 'The slash command run, not its arguments', example: 'compact' },
  { id: 'bash.class', name: 'Kind of shell command', class: 'metadata', description: 'The kind and program of each shell command, in Bash or an MCP shell tool such as Cowork\'s device_bash', example: 'vcs / git' },
  { id: 'bash.outcome', name: 'What a command did', class: 'metadata', description: 'Commits, reverts, pushes, branches opened, merges, tags, workflow runs and pull requests opened, merged or updated by shell commands that succeeded, as counts; and the size of each commit and pull request the plugin reports: files changed, lines added and removed, per file too, and whether a file is binary', example: '1 commit, 1 push; 3 files, 41 lines added' },
  { id: 'file.kind', name: 'File language', class: 'metadata', description: 'The language of each file edited or written, from its extension', example: 'TypeScript' },
  { id: 'web.domain', name: 'Website', class: 'metadata', switch: 'OTEL_LOG_TOOL_DETAILS', description: 'The site of each page fetched', example: 'docs.python.org' },
  {
    id: 'account.plan', name: 'Plan and usage limits', class: 'metadata',
    description: 'The Claude plan, seat tier and roles, each rate limit with its usage and reset time, extra usage and trial status, as Claude reports them for the signed-in account',
    example: 'Team, premium seat, 62% of the 5-hour limit',
  },
  { id: 'repo', name: 'Repository and branch', class: 'identifiers', switch: 'OTEL_METRICS_INCLUDE_REPOSITORY', description: "The Git remote's address, owner and name, the repository's ID and host, the branch and the commit and its parent, the number of a pull request or merge request, and the branch, ref or tag a shell command opened, pushed, merged or tagged. With it off, the plugin sends no commit or pull request records from sessions", example: 'github.com/acme/api' },
  { id: 'file.path', name: 'File paths', class: 'identifiers', switch: 'OTEL_LOG_TOOL_DETAILS', description: 'The path of each file read, edited or written, and of each file a commit changed', example: '/Users/ana/acme/api/src/login.ts' },
  { id: 'web.url', name: 'Web addresses', class: 'identifiers', switch: 'OTEL_LOG_TOOL_DETAILS', description: 'The full address of each page fetched', example: 'https://docs.python.org/3/library/re.html' },
  {
    id: 'work.item', name: 'Tickets', class: 'identifiers',
    description: 'The ID and address of each Linear or Jira ticket the session created or updated, and the workspace or site it belongs to. With it off, the plugin sends no ticket records from sessions',
    example: 'ENG-42, linear.app/acme/issue/ENG-42',
  },
  {
    id: 'mcp.url', name: 'MCP server addresses', class: 'identifiers', needs: 'tool.mcp',
    description: "The MCP servers set up for the session, called or not: each one's name, where it was set up and its address, read from Claude's MCP settings. A remote server's address keeps scheme, host, port and path; a local server's is its command. Headers and environment variables are never read",
    example: 'https://mcp.example.com/mcp',
  },
  { id: 'bash.command', name: 'Shell commands', class: 'content', switch: 'OTEL_LOG_TOOL_DETAILS', description: 'The full text of each shell command, in Bash or an MCP shell tool', example: 'git commit -m "fix login redirect"' },
  { id: 'change.title', name: 'Pull request titles', class: 'content', needs: 'repo', description: 'The title of each pull request or merge request a session opened', example: 'Fix the login redirect on Safari' },
  { id: 'tool.input', name: 'Tool input', class: 'content', switch: 'OTEL_LOG_TOOL_DETAILS', holds: ['bash.command', 'file.path', 'web.url'], description: "Each tool call's input: what an edit writes, search patterns, MCP arguments, subagent task prompts", example: '{"pattern":"login"}' },
  { id: 'tool.result', name: 'Tool results', class: 'content', switch: 'OTEL_LOG_TOOL_CONTENT', description: 'What each tool returned: command output, file contents read, MCP results, a failed call\'s error', example: '3 files changed, 41 insertions(+)' },
  {
    id: 'skill.text', name: 'Skill instructions', class: 'content', needs: 'skill.name',
    description: 'The instructions of each skill run, as Claude Code expanded them for the model with arguments filled in; sent once per session for each distinct text, later runs refer to it',
    example: 'Review the diff for correctness bugs…',
  },
  { id: 'prompt.text', name: 'Prompts', class: 'content', switch: 'OTEL_LOG_USER_PROMPTS', description: 'What the person typed, pastes expanded, slash command arguments included', example: 'Fix the login redirect on Safari' },
  { id: 'response.text', name: 'Responses', class: 'content', switch: 'OTEL_LOG_ASSISTANT_RESPONSES', description: "The model's visible answers", example: 'Fixed: the redirect now keeps the query string.' },
  { id: 'response.thinking', name: 'Thinking', class: 'content', description: "The model's thinking text, where the API returns it", example: 'The redirect drops the query because…' },
]

export const DATA_POINTS: ReadonlyMap<DataPointId, DataPoint> = new Map(CATALOG.map(d => [d.id, d]))

/**
 * What each data point that has a setting is with no organization settings: `on` or `off`. The plugin's table of defaults: settings
 * fetched for the organization go in front of it, what they give in force (Mainwave's defaults) included. The rule: metadata on, identifiers and content off, in Claude Code and Cowork alike,
 * until the organization's settings turn them on. Claude Code's switches don't turn a data point on: one the session's environment
 * sets to `0` turns the data points it governs that are on here to `claude` (gate.ts). Required data points are not here: they are
 * always sent.
 */
export const DEFAULTS: Readonly<Record<Exclude<DataPointId, 'session.identity' | 'session.links' | 'session.client' | 'usage'>, 'on' | 'off'>> = {
  // Metadata.
  'tool.call': 'on',
  'tool.mcp': 'on',
  'skill.name': 'on',
  'agent.type': 'on',
  'command.name': 'on',
  'bash.class': 'on',
  'bash.outcome': 'on',
  'file.kind': 'on',
  'web.domain': 'on',
  'account.plan': 'on',
  // Identifiers.
  repo: 'off',
  'file.path': 'off',
  'web.url': 'off',
  'mcp.url': 'off',
  'work.item': 'off',
  // Content.
  'bash.command': 'off',
  'change.title': 'off',
  'tool.input': 'off',
  'tool.result': 'off',
  'skill.text': 'off',
  'prompt.text': 'off',
  'response.text': 'off',
  'response.thinking': 'off',
}

// ── Attributes ────────────────────────────────────────────────────────────────

/**
 * The attributes each switchable data point owns, by key. `in` limits a key to the records named (a row's event, a span's or a
 * metric's name) where the same key means something else elsewhere. A key not listed belongs to a required data point. `redact`:
 * the value is `<REDACTED>` when the data point is off, as Claude Code writes withheld text, rather than left out.
 */
export type Owned = { key: string; id: DataPointId; in?: readonly string[]; redact?: true }

/** The plugin's row for one MCP server set up for the session (`mcp.url`). */
export const MCP_SERVER_ROW = 'mcp_server_configured'
/**
 * The plugin's row for what it found wrong with the session's telemetry setup (setup.ts): one per session, and again when that changes.
 * It belongs to `session.client`, required, so it always goes.
 */
export const PLUGIN_STATUS_ROW = 'plugin_status'
/** The plugin's row for one skill run (`skill.text`): the text the first time it is seen in the session, its ID every time. */
export const SKILL_PROMPT_ROW = 'skill_prompt'

const TOOL_RECORDS = ['tool_decision', 'tool_result', 'claude_code.tool', 'claude_code.tool.blocked_on_user', 'claude_code.tool.execution', 'claude_code.code_edit_tool.decision']

/** What a shell command did, stamped by the plugin on the command's tool span: its counts, and the refs it names (stamps.ts). */
const COMMAND_STAMP = 'mainwave.command.'

export const ATTRIBUTE_OWNERS: readonly Owned[] = [
  ...['tool_name', 'tool_name_safe', 'gen_ai.tool.name', 'decision', 'source', 'decision_source', 'decision_type', 'success', 'error_type', 'error_class', 'error.type', 'classifier_verdict', 'tool_source']
    .map(key => ({ key, id: 'tool.call' as const, in: TOOL_RECORDS })),
  ...['mcp_server.name', 'mcp_tool.name', 'anthropic.mcp.server.name', 'mcp_server_scope'].map(key => ({ key, id: 'tool.mcp' as const })),
  ...['skill.name', 'skill_name'].map(key => ({ key, id: 'skill.name' as const })),
  ...['agent.name', 'subagent_type'].map(key => ({ key, id: 'agent.type' as const })),
  { key: 'agent_type', id: 'agent.type', in: ['subagent_completed'] },
  { key: 'command_name', id: 'command.name' },
  ...['bash_command_class', 'bash_argv0', 'bash_subcommand', 'has_pipe'].map(key => ({ key, id: 'bash.class' as const })),
  ...['counted', ...COMMAND_COUNTS].map(c => ({ key: `${COMMAND_STAMP}${c}`, id: 'bash.outcome' as const, in: ['claude_code.tool'] })),
  ...Object.keys(COMMAND_REFS).map(r => ({ key: `${COMMAND_STAMP}${r}`, id: 'repo' as const, in: ['claude_code.tool'] })),
  { key: 'language', id: 'file.kind', in: ['claude_code.code_edit_tool.decision'] },
  { key: 'url.domain', id: 'web.domain' },
  { key: 'url.full', id: 'web.url' },
  { key: 'file_path', id: 'file.path' },
  { key: 'workspace.host_paths', id: 'file.path' },
  { key: 'full_command', id: 'bash.command' },
  { key: 'bash_command', id: 'bash.command' },
  { key: 'tool_input', id: 'tool.input' },
  { key: 'error', id: 'tool.result', in: ['tool_result'] },
  ...['prompt', 'prompt_text'].map(key => ({ key, id: 'prompt.text' as const, in: ['user_prompt'], redact: true as const })),
  { key: 'user_prompt', id: 'prompt.text', in: ['claude_code.interaction'], redact: true },
  { key: 'response', id: 'response.text', in: ['assistant_response'], redact: true },
  { key: 'response.thinking', id: 'response.thinking' },
  // Claude Code's row for each MCP server it connects: the server's name and where it was set up.
  ...['server_name', 'server_scope'].map(key => ({ key, id: 'tool.mcp' as const, in: ['mcp_server_connection'] })),
  // Its error, where it failed, names the server's address or command.
  { key: 'error', id: 'mcp.url', in: ['mcp_server_connection'] },
  // The plugin's own rows: one per MCP server set up, one per skill run.
  ...['server_name', 'server_scope', 'transport_type', 'server_url'].map(key => ({ key, id: 'mcp.url' as const, in: [MCP_SERVER_ROW] })),
  ...['skill.text', 'skill.text_id'].map(key => ({ key, id: 'skill.text' as const, in: [SKILL_PROMPT_ROW] })),
  // The markers (markers.ts): a commit's and a pull request's size are what a command did; a commit's files, their paths; a ticket, its
  // own data point; a pull request's title, its own. Their names, addresses and IDs are the repository's (`vcs.`, below).
  ...COMMIT_COUNTS.map(key => ({ key, id: 'bash.outcome' as const, in: [COMMIT_CREATED] })),
  ...CHANGE_COUNTS.map(key => ({ key, id: 'bash.outcome' as const, in: [CHANGE_OPENED] })),
  { key: 'vcs.commit.file.paths', id: 'file.path', in: [COMMIT_CREATED] },
  { key: 'vcs.change.title', id: 'change.title', in: [CHANGE_OPENED] },
  ...['work.item.id', 'work.item.op', 'work.item.url', 'work.vendor', 'work.instance'].map(key => ({ key, id: 'work.item' as const, in: [WORK_ITEM_CREATED, WORK_ITEM_UPDATED] })),
]

/** The rows the plugin makes itself, each the data point it carries: none is sent while that data point is off. */
export const OWN_ROWS: Readonly<Record<string, DataPointId>> = { [MCP_SERVER_ROW]: 'mcp.url', [SKILL_PROMPT_ROW]: 'skill.text' }

/**
 * Keys owned by their prefix, where no key above names them: every other key under `vcs.` is a repository's, as Claude Code names the
 * Git remote, branch and commit; every key under `mainwave.subscription.` is the plan snapshot's.
 */
export const KEY_PREFIXES: Readonly<Record<string, DataPointId>> = { 'vcs.': 'repo', 'mainwave.subscription.': 'account.plan' }

/** Metrics a data point counts: none of their points is sent while it is off. */
export const METRIC_OWNERS: Readonly<Record<string, DataPointId>> = { 'claude_code.commit.count': 'bash.outcome', 'claude_code.pull_request.count': 'bash.outcome' }

/** The keys inside Claude Code's `tool_parameters`, each one data point's. */
export const PARAMETER_OWNERS: Readonly<Record<string, DataPointId>> = {
  bash_command: 'bash.command',
  full_command: 'bash.command',
  timeout: 'tool.input',
  description: 'tool.input',
  dangerouslyDisableSandbox: 'tool.input',
  mcp_server_name: 'tool.mcp',
  mcp_tool_name: 'tool.mcp',
  skill_name: 'skill.name',
  subagent_type: 'agent.type',
  git_commit_id: 'repo',
  git_branch: 'repo',
}

/** The span event that carries a tool's result (`OTEL_LOG_TOOL_CONTENT`), and the data points of its attributes. */
export const TOOL_OUTPUT_EVENT = 'tool.output'
export const OUTPUT_OWNERS: Readonly<Record<string, DataPointId>> = { file_path: 'file.path', bash_command: 'bash.command', diff: 'tool.input' }

const byKey = new Map<string, Owned[]>()
for (const o of ATTRIBUTE_OWNERS) byKey.set(o.key, [...(byKey.get(o.key) ?? []), o])

/** The data point an attribute belongs to on a record (a row's event, a span's or a metric's name); undefined for a required one. */
export function ownerOf(record: string, key: string): { id: DataPointId; redact?: true } | undefined {
  for (const o of byKey.get(key) ?? []) if (o.in === undefined || o.in.includes(record)) return o.redact ? { id: o.id, redact: true } : { id: o.id }
  for (const [prefix, id] of Object.entries(KEY_PREFIXES)) if (key.startsWith(prefix)) return { id }
  return undefined
}

/** Whether a data point's values are identifiers or content: the always-on protections apply to them. */
export function sensitive(id: DataPointId): boolean {
  return id !== 'session.identity' && DATA_POINTS.get(id)?.class !== 'metadata'
}
