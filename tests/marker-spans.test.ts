// End to end: the markers a session's work makes, as the plugin sends them keyless. The engine beneath is played by rig.ts and the
// kit's mocks: the classic hook events (PostToolUse, UserPromptSubmit, StopFailure) as Claude Code raises them, git and gh as the
// host runs them, Claude's account record as the file holds it. Every request the plugin makes is read back whole.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import type { Overrides } from '../hooks/gate.ts'
import { ACCOUNT, boot, EMAIL, LOGGED_AT, memoryStore, network, ORG, type Layers, type Post } from './rig.ts'

const keyless = { options: {} }
const START = 1_800_000_000_000
const HOME = '/home/dev'
const SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'
const PARENT = 'f'.repeat(40)
const COMMON = { 'organization.id': ORG, 'user.email': EMAIL, 'user.account_uuid': ACCOUNT, 'user.id': 'device-1', 'session.id': 's-1', 'anthropic.provider': 'firstParty' }
/** What turns the markers' keys on, as an organization's settings would. */
const KEYS_ON: Overrides = { repo: 'on', 'work.item': 'on', 'file.path': 'on', 'change.title': 'on' }
const ACCOUNT_RECORD = {
  oauthAccount: { accountUuid: ACCOUNT, emailAddress: EMAIL, organizationUuid: ORG, organizationType: 'claude_team', billingType: 'stripe_subscription' },
  cachedUsageUtilization: { accountUuid: ACCOUNT, fetchedAtMs: START, utilization: { five_hour: { utilization: 12, resets_at: 'r' } } },
}
/** The CLI's managed hooks block, as Mainwave's org-wide setup writes it. */
const CLI_HOOK = (route: string) => ({ type: 'command', async: true, command: `f="$HOME/.mainwave/hooks/managed/mainwave-hook.sh"; [ -f "$f" ] && exec sh "$f" claude-code ${route}; exit 0` })
const CLI_HOOKS = {
  PostToolUse: [{ matcher: 'Bash', hooks: [CLI_HOOK('PostToolUse git'), CLI_HOOK('PostToolUse gh')] }],
  UserPromptSubmit: [{ hooks: [CLI_HOOK('UserPromptSubmit')] }],
  StopFailure: [{ hooks: [CLI_HOOK('StopFailure')] }],
}
const KEYED = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer example-key' }
/** The account record, and the CLI's hook entry where the CLI is installed. */
const RECORD = { [`${HOME}/.claude.json`]: ACCOUNT_RECORD }
const WITH_CLI = { ...RECORD, [`${HOME}/.mainwave/hooks/managed/mainwave-hook.sh`]: '#!/bin/sh' }

type World = { posts: Post[]; runs: string[][] }

let mockClock: ReturnType<typeof mock.clock>

function world(on: On, opts: { overrides?: Overrides; env?: Record<string, string>; merged?: Record<string, unknown>; files?: Record<string, unknown>; held?: Promise<void> } = {}): World {
  mockClock = mock.clock(on, { now: START })
  memoryStore(on, opts.overrides ? { dataPoints: opts.overrides } : {})
  const posts = network(on)
  const layers: Layers = {}
  if (opts.merged) Object.assign(layers, { undefined: opts.merged })
  boot(on, { entrypoint: 'cli', env: { HOME, ...opts.env }, layers })
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('classic.PostToolUse', () => ({}) as never)
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('classic.StopFailure', () => ({}) as never)
  const files = opts.files ?? { [`${HOME}/.claude.json`]: ACCOUNT_RECORD }
  on('fs.read', (_$, e) => {
    const path = (e as { path: string }).path
    if (!(path in files)) throw new Error('ENOENT')
    return { value: typeof files[path] === 'string' ? files[path] : JSON.stringify(files[path]) } as never
  })
  const runs: string[][] = []
  on('process.run', async (_$, e) => {
    await opts.held
    const argv = [...(e as { argv: string[] }).argv]
    runs.push(argv)
    if (argv[0] === 'git' && argv.includes('show')) return { value: { exitCode: 0, stdout: `${SHA}\n${PARENT}\0\n3\t1\tsrc/login.ts\0`, stderr: '' } } as never
    if (argv[0] === 'gh') return { value: { exitCode: 0, stdout: '{"changedFiles":2,"additions":30,"deletions":4}', stderr: '' } } as never
    return { value: { exitCode: 1, stdout: '', stderr: 'no' } } as never
  })
  return { posts, runs }
}

async function row($: Engine, event = 'api_request') {
  await $.telemetry.log({ to: 'collector', event, loggedAt: LOGGED_AT, attributes: { ...COMMON, 'event.name': event, 'event.sequence': 1 } } as never)
}

async function bash($: Engine, command: string, stdout: string) {
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr: '' }, tool_use_id: 'toolu_1', cwd: '/repo' } as never)
}

/** A session that commits, opens a pull request, saves a Linear ticket, submits a prompt and ends a turn on a rate limit. */
async function session($: Engine, w: World) {
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
  await row($)
  await $.classic.UserPromptSubmit({ prompt: 'ship it', prompt_id: 'prompt-1' } as never)
  await bash($, 'git commit -m "fix login"', `[main ${SHA.slice(0, 7)}] fix login\n 1 file changed`)
  await bash($, 'gh pr create --title "Fix login" --body x', 'https://github.com/acme/api/pull/42\n')
  await $.classic.PostToolUse({
    tool_name: 'mcp__claude_ai_Linear__save_issue', tool_input: { title: 'Fix login' }, tool_use_id: 'toolu_2',
    tool_response: [{ type: 'text', text: JSON.stringify({ id: 'ENG-12', url: 'https://linear.app/acme/issue/ENG-12/fix-login', teamId: 'team-1', description: 'Also ENG-9' }) }],
  } as never)
  await $.classic.StopFailure({ error: 'rate_limit', error_details: 'Rate limited, retry in 30s', prompt_id: 'prompt-1' } as never)
  await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
  return w.posts
}

const kvs = (l: { key: string; value: Record<string, unknown> }[] = []) => Object.fromEntries(l.map(a => [a.key, a.value['arrayValue'] ? (a.value['arrayValue'] as { values: Record<string, unknown>[] }).values.map(v => Object.values(v)[0]) : Object.values(a.value)[0]]))
type Sent = { name: string; traceId: string; attrs: Record<string, unknown>; resource: Record<string, unknown> }
function spansOf(posts: readonly Post[]): Sent[] {
  const out: Sent[] = []
  for (const p of posts.filter(p => p.url.endsWith('/v1/traces'))) {
    for (const rs of JSON.parse(p.body).resourceSpans) for (const ss of rs.scopeSpans) for (const s of ss.spans) out.push({ name: s.name, traceId: s.traceId, attrs: kvs(s.attributes), resource: kvs(rs.resource.attributes) })
  }
  return out
}
const MARKERS = ['vcs.commit.created', 'vcs.change.opened', 'work.item.created', 'work.item.updated', 'mainwave.subscription.snapshot', 'mainwave.claude_code.stop_failure']
const markersOf = (posts: readonly Post[]) => spansOf(posts).filter(s => MARKERS.includes(s.name))
const one = (posts: readonly Post[], name: string) => markersOf(posts).find(s => s.name === name)

describe("with the markers' keys on", () => {
  test('a commit: its SHA, parent, lines and files, looked up where the command ran, under hook.git, in a trace of its own', keyless, async ($, on) => {
    const w = world(on, { overrides: KEYS_ON })
    const commit = one(await session($, w), 'vcs.commit.created')!
    expect(commit.attrs).toEqual(expect.objectContaining({
      'vcs.commit.sha': SHA, 'vcs.commit.parent_sha': PARENT, 'vcs.commit.parent_count': 1, 'vcs.commit.files_changed': 1, 'vcs.commit.lines_added': 3, 'vcs.commit.lines_removed': 1,
      'vcs.commit.file.paths': ['src/login.ts'], 'vcs.commit.file.lines_added': [3], 'vcs.commit.file.lines_removed': [1], 'vcs.commit.file.is_binary': [false],
      'gen_ai.tool.call.id': 'toolu_1', 'organization.id': ORG, 'user.email': EMAIL, 'user.account_uuid': ACCOUNT, 'session.id': 's-1',
      'mainwave.plugin.name': 'mainwave', 'mainwave.telemetry.route': 'plugin',
    }))
    expect(commit.attrs['user.id']).toBeUndefined()
    expect(commit.resource).toEqual(expect.objectContaining({ 'mainwave.source': 'hook.git', 'service.name': 'mainwave.git-hook', 'mainwave.host_source': 'coding_agent.claude_code', 'mainwave.schema.version': '2' }))
    expect(commit.resource['service.version']).toBeUndefined()
    expect(w.runs.find(r => r[0] === 'git')).toEqual(expect.arrayContaining(['show', '--numstat', SHA.slice(0, 7)]))
    const others = spansOf(w.posts).filter(s => !MARKERS.includes(s.name)).map(s => s.traceId)
    expect(others).not.toContain(commit.traceId)
  })

  test("a pull request: its address, number, title and size, under hook.github; a ticket: its key, address and team, never its description or title", keyless, async ($, on) => {
    const w = world(on, { overrides: KEYS_ON })
    const posts = await session($, w)
    const pr = one(posts, 'vcs.change.opened')!
    expect(pr.attrs).toEqual(expect.objectContaining({
      'vcs.repository.url.full': 'https://github.com/acme/api/pull/42', 'vcs.change.id': '42', 'vcs.provider.name': 'github', 'vcs.change.title': 'Fix login',
      'vcs.change.files_changed': 2, 'vcs.change.lines_added': 30, 'vcs.change.lines_removed': 4,
    }))
    expect(pr.resource['mainwave.source']).toBe('hook.github')
    // Its size looked up by its address: in its own repository, whatever folder the command ran in.
    expect(w.runs.find(r => r[0] === 'gh')).toEqual(['gh', 'pr', 'view', 'https://github.com/acme/api/pull/42', '--json', 'changedFiles,additions,deletions'])
    const ticket = one(posts, 'work.item.created')!
    expect(ticket.attrs).toEqual(expect.objectContaining({ 'work.item.id': 'ENG-12', 'work.item.op': 'created', 'work.vendor': 'linear', 'work.instance': 'team-1', 'gen_ai.tool.call.id': 'toolu_2' }))
    expect(ticket.resource['mainwave.source']).toBe('hook.linear')
    expect(ticket.attrs['work.item.url']).toBe('https://linear.app/acme/issue/ENG-12')
    expect(JSON.stringify(markersOf(posts))).not.toContain('ENG-9')
    expect(JSON.stringify(markersOf(posts))).not.toContain('fix-login')
  })

  test("the plan snapshot with the prompt's id, under hook.anthropic; a turn's failure as its kind alone, never its details", keyless, async ($, on) => {
    const posts = await session($, world(on, { overrides: KEYS_ON }))
    const snap = one(posts, 'mainwave.subscription.snapshot')!
    expect(snap.attrs).toEqual(expect.objectContaining({
      'mainwave.subscription.trigger': 'UserPromptSubmit', 'prompt.id': 'prompt-1', 'mainwave.subscription.provider': 'anthropic', 'mainwave.subscription.organization_type': 'claude_team',
      'mainwave.subscription.usage.five_hour.utilization': 12, 'organization.id': ORG,
    }))
    expect(snap.resource).toEqual(expect.objectContaining({ 'mainwave.source': 'hook.anthropic', 'service.name': 'mainwave.plan-hook' }))
    expect(snap.attrs['mainwave.caller.span_id']).toBeUndefined()
    const stop = one(posts, 'mainwave.claude_code.stop_failure')!
    expect(stop.attrs).toEqual(expect.objectContaining({ 'mainwave.claude_code.stop_failure.error': 'rate_limit', 'prompt.id': 'prompt-1' }))
    expect(JSON.stringify(posts.map(p => p.body))).not.toContain('retry in 30s')
  })
})

describe('with no settings', () => {
  test("no commit, pull request or ticket marker (their keys are identifiers, off), and nothing runs to make one; the snapshot and a turn's failure go", keyless, async ($, on) => {
    const w = world(on)
    const posts = await session($, w)
    expect(markersOf(posts).map(s => s.name).sort()).toEqual(['mainwave.claude_code.stop_failure', 'mainwave.subscription.snapshot'])
    expect(w.runs).toEqual([])
  })

  test("a pull request's title goes only where titles are on", keyless, async ($, on) => {
    const posts = await session($, world(on, { overrides: { repo: 'on' } }))
    const pr = one(posts, 'vcs.change.opened')!
    expect(pr.attrs['vcs.change.id']).toBe('42')
    expect(pr.attrs['vcs.change.title']).toBeUndefined()
    // The commit's paths are file paths, off.
    expect(one(posts, 'vcs.commit.created')!.attrs['vcs.commit.file.paths']).toBeUndefined()
  })
})

describe("beside the CLI's hooks", () => {
  test('where the CLI can send (installed, its hooks configured, an ingest key in the env), the plugin sends none of the markers they send', keyless, async ($, on) => {
    const w = world(on, { overrides: KEYS_ON, env: KEYED, merged: { hooks: CLI_HOOKS }, files: WITH_CLI })
    const posts = await session($, w)
    // The CLI's block here runs git, gh, the prompt and the turn failure, not Linear: the ticket goes from the plugin alone.
    expect(markersOf(posts).map(s => s.name)).toEqual(['work.item.created'])
    expect(w.runs).toEqual([])
  })

  test('where the CLI cannot send (its hooks configured, no key: the env block taken out), the plugin sends them all', keyless, async ($, on) => {
    const posts = await session($, world(on, { overrides: KEYS_ON, merged: { hooks: CLI_HOOKS }, files: WITH_CLI }))
    expect(markersOf(posts).map(s => s.name).sort()).toEqual(['mainwave.claude_code.stop_failure', 'mainwave.subscription.snapshot', 'vcs.change.opened', 'vcs.commit.created', 'work.item.created'])
  })

  test('where the CLI was never installed (its hooks configured and a key, but no script on the machine), the plugin sends them all', keyless, async ($, on) => {
    const posts = await session($, world(on, { overrides: KEYS_ON, env: KEYED, merged: { hooks: CLI_HOOKS }, files: RECORD }))
    expect(markersOf(posts).map(s => s.name).sort()).toEqual(['mainwave.claude_code.stop_failure', 'mainwave.subscription.snapshot', 'vcs.change.opened', 'vcs.commit.created', 'work.item.created'])
  })
})

describe('what proves nothing sends nothing', () => {
  test("a failed commit, a create that printed no address, a save that named no ticket, another account's record", keyless, async ($, on) => {
    const other = { ...ACCOUNT_RECORD, oauthAccount: { ...ACCOUNT_RECORD.oauthAccount, accountUuid: 'someone-else' } }
    const w = world(on, { overrides: KEYS_ON, files: { [`${HOME}/.claude.json`]: other } })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
    await row($)
    await $.classic.UserPromptSubmit({ prompt: 'x', prompt_id: 'p' } as never)
    await bash($, 'git commit -m x', 'nothing to commit, working tree clean')
    await bash($, 'gh pr create --web', 'Opening github.com/acme/api/compare in your browser.')
    await $.classic.PostToolUse({ tool_name: 'mcp__linear__save_issue', tool_input: {}, tool_response: 'Error: invalid input', tool_use_id: 'toolu_3' } as never)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(markersOf(w.posts)).toEqual([])
    expect(w.runs).toEqual([])
  })

  test('a marker still being made when a /clear ends its session goes under that session, not the next', keyless, async ($, on) => {
    let release: () => void = () => undefined
    // git answers only once the session has ended.
    const held = new Promise<void>(r => (release = r))
    const w = world(on, { overrides: KEYS_ON, held })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
    await row($)
    await bash($, 'git commit -m x', `[main ${SHA.slice(0, 7)}] x`)
    const ending = $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-2' } } as never)
    await mockClock.advance(1_000)
    await ending
    release()
    for (let i = 0; i < 50; i++) await Promise.resolve()
    await $.telemetry.log({ to: 'collector', event: 'api_request', loggedAt: LOGGED_AT, attributes: { ...COMMON, 'session.id': 's-2', 'event.name': 'api_request', 'event.sequence': 1 } } as never)
    await $.session.end({ reason: 'other', sessionId: 's-2', resume: { id: 's-2' } } as never)
    expect(one(w.posts, 'vcs.commit.created')!.attrs['session.id']).toBe('s-1')
  })

  test('a marker made before any row names the session waits for one, then goes under its identity', keyless, async ($, on) => {
    const w = world(on, { overrides: KEYS_ON })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
    await bash($, 'git commit -m x', `[main ${SHA.slice(0, 7)}] x`)
    await row($)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(one(w.posts, 'vcs.commit.created')!.attrs).toEqual(expect.objectContaining({ 'organization.id': ORG, 'user.email': EMAIL, 'session.id': 's-1' }))
  })
})
