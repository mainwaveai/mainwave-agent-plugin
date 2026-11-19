// End to end: the markers a session's work makes, as the plugin sends them keyless. The engine beneath is played by rig.ts and the
// kit's mocks: the native events the markers come from (a tool call ending, a prompt entering, a turn ending on an API error) as
// Claude Code raises them, the session's id, prompt, folder and transcript as the engine answers them, git and gh as the host runs
// them, Claude's account record as the file holds it. Every request the plugin makes is read back whole.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import type { Overrides } from '../hooks/gate.ts'
import { ACCOUNT, boot, EMAIL, infoCall, LOGGED_AT, memoryStore, network, ORG, type Layers, type Post } from './rig.ts'

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

/** The session's transcript: where `$.session.info()` says it is. */
const TRANSCRIPT = `${HOME}/.claude/projects/-repo/s-1.jsonl`
/** The message Claude Code writes in place of a failed response, as its transcript line holds it. */
const failedLine = (uuid: string, error: string) => JSON.stringify({ type: 'assistant', uuid, isApiErrorMessage: true, error, apiErrorStatus: 429, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Rate limited, retry in 30s' }] } })

type World = { posts: Post[]; runs: string[][]; reads: string[] }

/** What the engine answers of the session: its id, the prompt it is on, and its transcript's last message and lines. */
const engine = { sessionId: 's-1', promptId: 'prompt-1' as string | undefined, last: undefined as { uuid: string; text: string } | undefined, transcript: '', noInfo: false, infoThere: false }
/** What the next tool call answers: its record, or an error. */
let answer: Record<string, unknown> = {}

let mockClock: ReturnType<typeof mock.clock>

function world(on: On, opts: { overrides?: Overrides; env?: Record<string, string>; merged?: Record<string, unknown>; files?: Record<string, unknown>; dirs?: readonly string[]; held?: Promise<void> } = {}): World {
  mockClock = mock.clock(on, { now: START })
  memoryStore(on, opts.overrides ? { dataPoints: opts.overrides } : {})
  const posts = network(on)
  const layers: Layers = {}
  if (opts.merged) Object.assign(layers, { undefined: opts.merged })
  boot(on, { entrypoint: 'cli', env: { HOME, ...opts.env }, layers })
  // As the session starts, whether the engine itself has `$.session.info()`, asked by the test's own hook, not the plugin's: where it
  // has none the call is not a function (a TypeError); where it has, the kit refuses the test's call (its module is not scanned), or
  // answers it.
  on('session.start', async ($, e) => {
    engine.infoThere = await infoCall(() => ($ as unknown as { session: { info: () => Promise<unknown> } }).session.info())
    return { cwd: (e as { cwd: string }).cwd } as never
  })
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  Object.assign(engine, { sessionId: 's-1', promptId: 'prompt-1', last: undefined, transcript: '', noInfo: false, infoThere: false })
  answer = {}
  on('session.id', () => ({ value: engine.sessionId }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  // `$.session.info()`, by a glob: Claude Code 2.1.325 and earlier have no such call, and refuse a hook that names it. There the
  // plugin's call fails, as `noInfo` makes it here.
  on('session.*', (_$, e, next) => {
    if ((next.event as string) !== 'session.info') return next(e)
    if (engine.noInfo) throw new TypeError('$.session.info is not a function')
    return { value: { transcriptPath: TRANSCRIPT, ...(engine.promptId ? { promptId: engine.promptId } : {}), platform: 'linux', isHosted: false } } as never
  })
  on('session.messages', () => ({ value: engine.last ? [{ role: 'assistant', text: engine.last.text, toolUses: [], uuid: engine.last.uuid }] : [] }) as never)
  on('tool.call', () => answer as never)
  on('prompt.submit', (_$, e) => ({ text: (e as { text: string }).text }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  const files = opts.files ?? { [`${HOME}/.claude.json`]: ACCOUNT_RECORD }
  const text = (path: string) => (path === TRANSCRIPT ? engine.transcript : typeof files[path] === 'string' ? (files[path] as string) : JSON.stringify(files[path]))
  const there = (path: string) => path in files || (path === TRANSCRIPT && engine.transcript !== '')
  const reads: string[] = []
  on('fs.read', (_$, e) => {
    const { path, offset = 0, length } = e as { path: string; offset?: number; length?: number }
    reads.push(path)
    if (!there(path)) throw new Error('ENOENT')
    const bytes = new TextEncoder().encode(text(path))
    return { value: new TextDecoder().decode(bytes.subarray(offset, length === undefined ? undefined : offset + length)) } as never
  })
  on('fs.stat', (_$, e) => {
    const path = (e as { path: string }).path
    if (opts.dirs?.includes(path)) return { value: { kind: 'dir', size: 0, mtimeMs: START, isLink: false } } as never
    if (!there(path)) throw new Error('ENOENT')
    return { value: { kind: 'file', size: new TextEncoder().encode(text(path)).length, mtimeMs: START, isLink: false } } as never
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
  return { posts, runs, reads }
}

async function row($: Engine, event = 'api_request') {
  await $.telemetry.log({ to: 'collector', event, loggedAt: LOGGED_AT, attributes: { ...COMMON, 'event.name': event, 'event.sequence': 1 } } as never)
}

/**
 * Whether the engine beneath has `$.session.info()`, as the test's own hook found when the session started: 2.1.325 and earlier, the
 * floor among them, have not, and there the plugin sends no failure marker and no prompt ID.
 */
const hasInfo = () => engine.infoThere
/** The failure marker, where the engine lets the plugin read it. */
const stopIf = (info: boolean) => (info ? ['mainwave.claude_code.stop_failure'] : [])

/** One tool call, its record what the tool answers. */
async function call($: Engine, input: Record<string, unknown>, result: Record<string, unknown>) {
  answer = result
  await $.tool.call(input as never)
}

async function bash($: Engine, command: string, stdout: string, more: Record<string, unknown> = {}) {
  await call($, { tool: 'Bash', command, description: 'x', tool_use_id: 'toolu_1' }, { result: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, text: stdout, ...more })
}

/** A prompt entering, as the person typed it. */
async function prompt($: Engine, text: string, promptId: string) {
  engine.promptId = promptId
  await $.prompt.submit({ text, wait: false, origin: { kind: 'user' } } as never)
}

/** A main-loop turn ending on an API error: the transcript holds the message written in its place, the session's last. */
async function failed($: Engine, error: string, uuid = 'msg-failed-1') {
  engine.last = { uuid, text: 'API Error: Rate limited, retry in 30s' }
  engine.transcript += `${failedLine(uuid, error)}\n${JSON.stringify({ type: 'last-prompt', leafUuid: uuid })}\n`
  await $.turn.complete({ turnId: 't-1', answer: '', durationMs: 20, isAborted: false, reason: 'error' } as never)
}

/** A session that commits, opens a pull request, saves a Linear ticket, submits a prompt and ends a turn on a rate limit. */
async function session($: Engine, w: World) {
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
  await row($)
  await prompt($, 'ship it', 'prompt-1')
  await bash($, 'git commit -m "fix login"', `[main ${SHA.slice(0, 7)}] fix login\n 1 file changed`)
  await bash($, 'gh pr create --title "Fix login" --body x', 'https://github.com/acme/api/pull/42\n')
  const saved = JSON.stringify({ id: 'ENG-12', url: 'https://linear.app/acme/issue/ENG-12/fix-login', teamId: 'team-1', description: 'Also ENG-9' })
  await call($, { tool: 'mcp__claude_ai_Linear__save_issue', title: 'Fix login', tool_use_id: 'toolu_2' }, { result: [{ type: 'text', text: saved }], text: saved })
  await failed($, 'rate_limit')
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
    const info = hasInfo()
    const snap = one(posts, 'mainwave.subscription.snapshot')!
    expect(snap.attrs['prompt.id']).toBe(info ? 'prompt-1' : undefined)
    expect(snap.attrs).toEqual(expect.objectContaining({
      'mainwave.subscription.trigger': 'UserPromptSubmit', 'mainwave.subscription.provider': 'anthropic', 'mainwave.subscription.organization_type': 'claude_team',
      'mainwave.subscription.usage.five_hour.utilization': 12, 'organization.id': ORG,
    }))
    expect(snap.resource).toEqual(expect.objectContaining({ 'mainwave.source': 'hook.anthropic', 'service.name': 'mainwave.plan-hook' }))
    expect(snap.attrs['mainwave.caller.span_id']).toBeUndefined()
    if (!info) return expect(one(posts, 'mainwave.claude_code.stop_failure')).toBeUndefined()
    const stop = one(posts, 'mainwave.claude_code.stop_failure')!
    expect(stop.attrs).toEqual(expect.objectContaining({ 'mainwave.claude_code.stop_failure.error': 'rate_limit', 'prompt.id': 'prompt-1' }))
    expect(JSON.stringify(posts.map(p => p.body))).not.toContain('retry in 30s')
  })
})

describe('with no settings', () => {
  test("no commit, pull request or ticket marker (their keys are identifiers, off), and nothing runs to make one; the snapshot and a turn's failure go", keyless, async ($, on) => {
    const w = world(on)
    const posts = await session($, w)
    expect(markersOf(posts).map(s => s.name).sort()).toEqual([...stopIf(hasInfo()), 'mainwave.subscription.snapshot'])
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
    // Nothing of the CLI's is run, nor its script read: only whether the script is there.
    expect(w.runs).toEqual([])
    expect(w.reads.filter(p => p.includes('mainwave-hook'))).toEqual([])
  })

  test('where the CLI cannot send (its hooks configured, no key: the env block taken out), the plugin sends them all', keyless, async ($, on) => {
    const posts = await session($, world(on, { overrides: KEYS_ON, merged: { hooks: CLI_HOOKS }, files: WITH_CLI }))
    expect(markersOf(posts).map(s => s.name).sort()).toEqual([...stopIf(hasInfo()), 'mainwave.subscription.snapshot', 'vcs.change.opened', 'vcs.commit.created', 'work.item.created'])
  })

  test('where the CLI was never installed (its hooks configured and a key, but no script on the machine), the plugin sends them all', keyless, async ($, on) => {
    const posts = await session($, world(on, { overrides: KEYS_ON, env: KEYED, merged: { hooks: CLI_HOOKS }, files: RECORD }))
    expect(markersOf(posts).map(s => s.name).sort()).toEqual([...stopIf(hasInfo()), 'mainwave.subscription.snapshot', 'vcs.change.opened', 'vcs.commit.created', 'work.item.created'])
  })

  test("where a folder, not a file, stands at the script's path (its hook command's `[ -f ]` fails), the plugin sends them all", keyless, async ($, on) => {
    const posts = await session($, world(on, { overrides: KEYS_ON, env: KEYED, merged: { hooks: CLI_HOOKS }, files: RECORD, dirs: [`${HOME}/.mainwave/hooks/managed/mainwave-hook.sh`] }))
    expect(markersOf(posts).map(s => s.name).sort()).toEqual([...stopIf(hasInfo()), 'mainwave.subscription.snapshot', 'vcs.change.opened', 'vcs.commit.created', 'work.item.created'])
  })
})

describe('what proves nothing sends nothing', () => {
  test("a failed commit, a create that printed no address, a save that named no ticket, another account's record", keyless, async ($, on) => {
    const other = { ...ACCOUNT_RECORD, oauthAccount: { ...ACCOUNT_RECORD.oauthAccount, accountUuid: 'someone-else' } }
    const w = world(on, { overrides: KEYS_ON, files: { [`${HOME}/.claude.json`]: other } })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
    await row($)
    await prompt($, 'x', 'p')
    await bash($, 'git commit -m x', 'nothing to commit, working tree clean')
    await bash($, 'gh pr create --web', 'Opening github.com/acme/api/compare in your browser.')
    await call($, { tool: 'mcp__linear__save_issue', tool_use_id: 'toolu_3' }, { result: 'Error: invalid input', text: 'Error: invalid input' })
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

  test('just after a /clear, before a row of the new session: the plan snapshot and a failure go under the session the engine names', keyless, async ($, on) => {
    const w = world(on, { overrides: KEYS_ON })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
    await row($)
    await $.session.end({ reason: 'clear', sessionId: 's-1', resume: { id: 's-2' } } as never)
    engine.sessionId = 's-2'
    await prompt($, 'next', 'prompt-2')
    await failed($, 'overloaded')
    await $.telemetry.log({ to: 'collector', event: 'api_request', loggedAt: LOGGED_AT, attributes: { ...COMMON, 'session.id': 's-2', 'event.name': 'api_request', 'event.sequence': 1 } } as never)
    await $.session.end({ reason: 'other', sessionId: 's-2', resume: { id: 's-2' } } as never)
    expect(one(w.posts, 'mainwave.subscription.snapshot')!.attrs['session.id']).toBe('s-2')
    if (hasInfo()) expect(one(w.posts, 'mainwave.claude_code.stop_failure')!.attrs['session.id']).toBe('s-2')
  })

  test('a marker made before any row names the session waits for one, then goes under its identity', keyless, async ($, on) => {
    const w = world(on, { overrides: KEYS_ON })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
    await bash($, 'git commit -m x', `[main ${SHA.slice(0, 7)}] x`)
    await row($)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(one(w.posts, 'vcs.commit.created')!.attrs).toEqual(expect.objectContaining({ 'organization.id': ORG, 'user.email': EMAIL, 'session.id': 's-1' }))
  })

  test('a call that failed makes no marker, and nothing runs to make one, whatever its output says', keyless, async ($, on) => {
    const w = world(on, { overrides: KEYS_ON })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
    await row($)
    await bash($, 'git commit -m x && git push', `[main ${SHA.slice(0, 7)}] x\nfatal: no upstream`, { isError: true })
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(markersOf(w.posts)).toEqual([])
    expect(w.runs).toEqual([])
  })
})

describe("a turn's failure", () => {
  async function failing($: Engine, w: World, go: () => Promise<void>) {
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
    await row($)
    await go()
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    return markersOf(w.posts).filter(s => s.name === 'mainwave.claude_code.stop_failure')
  }

  test('its line written a little after the turn ended: read again until it is there', keyless, async ($, on) => {
    const w = world(on)
    const stops = await failing($, w, async () => {
      engine.last = { uuid: 'msg-late', text: 'API Error' }
      const ending = $.turn.complete({ turnId: 't-1', answer: '', durationMs: 20, isAborted: false, reason: 'error' } as never)
      await ending
      await mockClock.advance(100)
      engine.transcript = `${failedLine('msg-late', 'overloaded')}\n`
      await mockClock.advance(100)
    })
    expect(stops.map(s => s.attrs['mainwave.claude_code.stop_failure.error'])).toEqual(hasInfo() ? ['overloaded'] : [])
  })

  test('its line pushed out of the transcript end by a large line written after it: read again further back', keyless, async ($, on) => {
    const w = world(on)
    const stops = await failing($, w, async () => {
      engine.last = { uuid: 'msg-far', text: 'API Error' }
      // A queued prompt with a pasted image, written after the failed turn's message: 100 KB past it.
      engine.transcript = `${failedLine('msg-far', 'rate_limit')}\n${JSON.stringify({ type: 'user', image: 'x'.repeat(100_000) })}\n`
      await $.turn.complete({ turnId: 't-1', answer: '', durationMs: 20, isAborted: false, reason: 'error' } as never)
      await mockClock.advance(1_000)
    })
    expect(stops.map(s => s.attrs['mainwave.claude_code.stop_failure.error'])).toEqual(hasInfo() ? ['rate_limit'] : [])
  })

  test("none for a turn whose last message records no API error, a turn that ended otherwise, or a subagent's", keyless, async ($, on) => {
    const w = world(on)
    const stops = await failing($, w, async () => {
      engine.last = { uuid: 'msg-ok', text: 'Prompt is too long' }
      engine.transcript = `${JSON.stringify({ type: 'assistant', uuid: 'msg-ok', message: { content: [] } })}\n${failedLine('msg-old', 'rate_limit')}\n`
      await $.turn.complete({ turnId: 't-1', answer: '', durationMs: 20, isAborted: false, reason: 'error' } as never)
      await mockClock.advance(1_000)
      engine.last = { uuid: 'msg-old', text: 'API Error' }
      await $.turn.complete({ turnId: 't-2', answer: '', durationMs: 20, isAborted: true, reason: 'aborted' } as never)
      await $.turn.complete({ turnId: 't-3', agentId: 'agent-1', answer: '', durationMs: 20, isAborted: false, reason: 'error' } as never)
      await mockClock.advance(1_000)
    })
    expect(stops).toEqual([])
  })

  test('where the engine has no session.info (2.1.325 and earlier): no failure marker, and the snapshot goes without its prompt', keyless, async ($, on) => {
    const w = world(on)
    engine.noInfo = true
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
    await row($)
    await prompt($, 'go', 'prompt-1')
    await failed($, 'rate_limit')
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(markersOf(w.posts).map(s => s.name)).toEqual(['mainwave.subscription.snapshot'])
    expect(one(w.posts, 'mainwave.subscription.snapshot')!.attrs['prompt.id']).toBeUndefined()
  })
})
