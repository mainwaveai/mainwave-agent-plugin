// End to end: the plugin's status row (`plugin_status`), which says what it found wrong with the session's telemetry setup. The engine
// beneath is played by rig.ts and the kit's mocks, and the network by keyless ingest's own rules.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { ACCOUNT, boot, contractViolations, DEVICE, EMAIL, keylessAnswer, LOGGED_AT, memoryStore, network, ORG, ownedKeys, packsOption, records, type Answer, type Layers, type Post, type Reply } from './rig.ts'

const keyless = { options: {} }
const START = 1_800_000_000_000
const TICK = 5_000
const HOME = '/home/dev'
const COMMON = { 'organization.id': ORG, 'user.email': EMAIL, 'user.id': 'device-1', 'session.id': 's-1' }
/** Claude's account file as a login leaves it (example values). */
const ACCOUNT_FILE = { userID: DEVICE, oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL, accountUuid: ACCOUNT, organizationName: 'Example' } }
const ISSUES = 'mainwave.telemetry.issues'

type World = { env?: Record<string, string>; merged?: Answer; layers?: Layers; accountFile?: unknown; files?: Record<string, string>; settings?: (n: number) => Reply }

function world(on: On, opts: World = {}) {
  const clock = mock.clock(on, { now: START })
  const store = memoryStore(on)
  const seen: Post[] = []
  const posts = network(
    on,
    (_n, post) => {
      seen.push(post)
      const answer = keylessAnswer(post)
      return { status: answer.status, text: answer.text }
    },
    undefined,
    (n, _post) => opts.settings?.(n) ?? { status: 404, text: '{"detail":"Not Found"}' },
  )
  // A read of the merged settings names no source.
  boot(on, { entrypoint: 'cli', layers: { ...opts.layers, ...(opts.merged !== undefined ? { undefined: opts.merged } : {}) } as Layers, env: { HOME, ...opts.env } })
  const reads: string[] = []
  on('fs.read', (_$, e) => {
    const path = (e as unknown as { path: string }).path
    reads.push(path)
    // Claude's account file: in CLAUDE_CONFIG_DIR, else the home folder.
    if (path === `${opts.env?.['CLAUDE_CONFIG_DIR'] ?? HOME}/.claude.json` && opts.accountFile !== undefined) return { value: JSON.stringify(opts.accountFile) } as never
    if (opts.files?.[path] !== undefined) return { value: opts.files[path] } as never
    throw new Error(`no file at ${path} in test`)
  })
  let sessionId = 'sess-1'
  on('session.id', () => ({ value: sessionId }) as never)
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: 'ok' }) as never)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' } } as never
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' } } as never
  })
  on('classic.StopFailure', () => ({}) as never)
  /** The status rows sent, in order. */
  const statusRows = () => seen.filter(p => new URL(p.url).pathname === '/v1/logs').flatMap(records).filter(r => r.attributes['event.name'] === 'plugin_status')
  return { clock, store, posts, seen, reads, logs, statusRows, setSession: (id: string) => (sessionId = id) }
}

async function row($: Engine, event: string, common: Record<string, unknown> = COMMON) {
  await $.telemetry.log({ to: 'collector', event, loggedAt: LOGGED_AT, attributes: { ...common, 'event.name': event, 'event.sequence': 1 } } as never)
}

/** One main-loop turn, its rows raised by Claude Code (`rows`) or never reaching the plugin; `model`, it asks the model once. */
async function turn($: Engine, rows: boolean, common: Record<string, unknown> = COMMON, model = true) {
  if (rows) await row($, 'user_prompt', common)
  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  if (model) {
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1 } as never)
    while (!(await stream.next()).done) {
      // Read to its end, as the engine does.
    }
  }
  if (rows) await row($, 'api_request', common)
  return $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 40, isAborted: false, reason: 'answer' } as never)
}

const end = ($: Engine, reason = 'other', id = 's-1') => $.session.end({ reason, sessionId: id, resume: { id } } as never)

describe('the status row', () => {
  test('one per session as its first turn ends, with no codes where nothing is wrong, under the identity its rows name', keyless, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($, true)
    await w.clock.advance(TICK)
    await turn($, true)
    await end($)
    const rows = w.statusRows()
    expect(rows.length).toBe(1)
    const a = rows[0]!.attributes
    expect(a[ISSUES]).toBeUndefined()
    expect(a['organization.id']).toBe(ORG)
    expect(a['user.email']).toBe(EMAIL)
    expect(a['session.id']).toBe('s-1')
    expect(a['mainwave.telemetry.route']).toBe('plugin')
    expect(contractViolations(a)).toEqual([])
    expect(rows[0]!.traceId).toBeUndefined()
  })

  test('no row of Claude Code\'s reaches the plugin: rows_skipped, under the account file\'s identity, and the settings are asked for with it', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($, false)
    // Rows may trail their turn: nothing is decided before the grace has passed.
    expect(w.reads).not.toContain(`${HOME}/.claude.json`)
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    await end($)
    const rows = w.statusRows()
    expect(rows.length).toBe(1)
    const a = rows[0]!.attributes
    expect(a[ISSUES]).toEqual(['rows_skipped'])
    expect(contractViolations(a)).toEqual([])
    expect(a['organization.id']).toBe(ORG)
    expect(a['user.email']).toBe(EMAIL)
    expect(a['user.account_uuid']).toBe(ACCOUNT)
    expect(a['user.id']).toBe(DEVICE)
    expect(a['session.id']).toBe('sess-1')
    expect(a['organizationName']).toBeUndefined()
    expect(w.posts.settings.map(p => JSON.parse(p.body))).toContainEqual({ claude_org_id: ORG, email: EMAIL })
    expect(w.logs.join('')).toContain('setup: rows_skipped (identity from the account file)')
  })

  test('a session that ends at once after its turn counts its rows as not coming', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await turn($, false)
    await end($)
    await w.clock.advance(TICK)
    expect(w.statusRows().map(r => r.attributes[ISSUES])).toEqual([['rows_skipped']])
  })

  test('rows that come within the grace: no rows_skipped, and the rows name the session, not the account file', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await turn($, false)
    await w.clock.advance(1_000)
    await row($, 'api_request')
    await w.clock.advance(TICK)
    await end($)
    const rows = w.statusRows()
    expect(rows.length).toBe(1)
    expect(rows[0]!.attributes[ISSUES]).toBeUndefined()
    expect(rows[0]!.attributes['session.id']).toBe('s-1')
    expect(w.reads).not.toContain(`${HOME}/.claude.json`)
  })

  test('no row and no account file to say who the session is: nothing goes, and nothing holds the turn', keyless, async ($, on) => {
    const w = world(on)
    expect(await turn($, false)).toEqual({ text: 'ok' })
    await w.clock.advance(2 * TICK)
    await end($)
    expect(w.seen).toEqual([])
  })

  test('an account file with no login, or one of the wrong shape, says nothing', keyless, async ($, on) => {
    const w = world(on, { accountFile: { userID: DEVICE, oauthAccount: { organizationUuid: 'not-a-uuid', emailAddress: EMAIL } } })
    await turn($, false)
    await end($)
    await w.clock.advance(TICK)
    expect(w.seen).toEqual([])
  })

  test('a new row when what it says changes, none when it does not', keyless, async ($, on) => {
    const w = world(on, { settings: () => ({ status: 503, text: 'busy' }) })
    await row($, 'api_request')
    // The settings are asked for once the row named the organization and email; the first turn ends before the answer.
    await turn($, true)
    await w.clock.advance(TICK)
    await turn($, true)
    await turn($, true)
    await end($)
    expect(w.statusRows().map(r => r.attributes[ISSUES])).toEqual([undefined, ['settings_unavailable']])
  })

  test('a new session after /clear has its own row', keyless, async ($, on) => {
    const w = world(on)
    await turn($, true)
    await end($, 'clear')
    const next = { ...COMMON, 'session.id': 's-2' }
    await turn($, true, next)
    await end($, 'other', 's-2')
    await w.clock.advance(TICK)
    expect(w.statusRows().map(r => r.attributes['session.id'])).toEqual(['s-1', 's-2'])
  })
})

describe('what it finds in the setup', () => {
  const codes = async ($: Engine, on: On, opts: World) => {
    const w = world(on, opts)
    await turn($, true)
    await end($)
    await w.clock.advance(TICK)
    const rows = w.statusRows()
    expect(rows.length).toBe(1)
    expect(contractViolations(rows[0]!.attributes)).toEqual([])
    return rows[0]!.attributes[ISSUES]
  }
  const CLI_HOOK = { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'f="$HOME/.mainwave/hooks/managed/mainwave-hook.sh"; [ -f "$f" ] && exec sh "$f" claude-code PostToolUse gh' }] }] } }
  /** The CLI's hook script, where the CLI is installed. */
  const CLI_SCRIPT = { [`${HOME}/.mainwave/hooks/managed/mainwave-hook.sh`]: '#!/bin/sh\n' }

  test('telemetry on with no endpoint', keyless, async ($, on) => {
    expect(await codes($, on, { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } })).toEqual(['exporter_no_endpoint'])
  })

  test("Mainwave's endpoint with no key", keyless, async ($, on) => {
    expect(await codes($, on, { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.mainwave.com', OTEL_EXPORTER_OTLP_HEADERS: 'x-other=1' } })).toEqual(['exporter_no_key'])
  })

  test("Mainwave's endpoint with a key, or a headers helper: nothing", keyless, async ($, on) => {
    expect(await codes($, on, { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.mainwave.com', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer%20k' } })).toBeUndefined()
  })

  test('an endpoint elsewhere', keyless, async ($, on) => {
    expect(await codes($, on, { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com', OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer k' } })).toEqual(['exporter_elsewhere'])
  })

  test("the CLI's hooks with no keyed exporter", keyless, async ($, on) => {
    expect(await codes($, on, { merged: CLI_HOOK, files: CLI_SCRIPT })).toEqual(['cli_hooks_no_exporter'])
  })

  test("the CLI's hooks where the CLI was never installed: they do nothing, so nothing", keyless, async ($, on) => {
    expect(await codes($, on, { merged: CLI_HOOK })).toBeUndefined()
  })

  test("the CLI's hooks with a key for one signal alone: the CLI reads only the general headers", keyless, async ($, on) => {
    expect(await codes($, on, { merged: CLI_HOOK, files: CLI_SCRIPT, env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.mainwave.com', OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'Authorization=Bearer k' } })).toEqual(['cli_hooks_no_exporter'])
  })

  test("the CLI's hooks with a keyed exporter on Mainwave: nothing", keyless, async ($, on) => {
    expect(await codes($, on, {
      merged: { ...CLI_HOOK, otelHeadersHelper: '/usr/local/bin/mainwave-headers' }, files: CLI_SCRIPT,
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.mainwave.com' },
    })).toBeUndefined()
  })

  test('nothing of the setup goes on the row but the codes: no endpoint, header or command', keyless, async ($, on) => {
    const w = world(on, { merged: CLI_HOOK, files: CLI_SCRIPT, env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com', OTEL_EXPORTER_OTLP_HEADERS: 'x-secret=hunter2' } })
    await turn($, true)
    await end($)
    await w.clock.advance(TICK)
    const [r] = w.statusRows()
    expect(r!.attributes[ISSUES]).toEqual(['cli_hooks_no_exporter', 'exporter_elsewhere'])
    expect(ownedKeys(r!.attributes)).toEqual(['mainwave.plugin.entrypoint', 'mainwave.plugin.name', 'mainwave.plugin.version', ISSUES, 'mainwave.telemetry.route'])
    const raw = JSON.stringify(w.seen)
    for (const text of ['otel.example.com', 'hunter2', 'x-secret', 'mainwave-hook.sh']) expect(raw).not.toContain(text)
  })

  test('redaction packs that name a pack the plugin does not have', keyless, async ($, on) => {
    expect(await codes($, on, { layers: { policy: packsOption(['no-such-pack']) } })).toEqual(['redaction_unknown_pack'])
  })
})

describe('the status row, more', () => {
  test('the grace timer sends the row on its own, before the session ends', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await turn($, false)
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    expect(w.statusRows().map(r => r.attributes[ISSUES])).toEqual([['rows_skipped']])
  })

  test("a status row that could not go before /clear is let go: the next session's row says what is true of it", keyless, async ($, on) => {
    // No row and no account file: the first session's row has no identity to go under.
    const w = world(on)
    await turn($, false)
    await w.clock.advance(2 * TICK)
    await end($, 'clear')
    const next = { ...COMMON, 'session.id': 's-2' }
    await turn($, true, next)
    await end($, 'other', 's-2')
    await w.clock.advance(TICK)
    expect(w.statusRows().map(r => [r.attributes['session.id'], r.attributes[ISSUES]])).toEqual([['s-2', undefined]])
  })

  test("a subagent's turn starts nothing", keyless, async ($, on) => {
    const w = world(on)
    await row($, 'api_request')
    await $.turn.complete({ turnId: 't1', agentId: 'agent-1', answer: 'ok', durationMs: 40, isAborted: false, reason: 'answer' } as never)
    await w.clock.advance(2 * TICK)
    expect(w.statusRows()).toEqual([])
    await turn($, true)
    await end($)
    expect(w.statusRows().length).toBe(1)
  })

  for (const env of [{ ANTHROPIC_API_KEY: 'sk-example' }, { CLAUDE_CODE_OAUTH_TOKEN: 'token-example' }, { CLAUDE_CODE_USE_BEDROCK: '1' }] as Record<string, string>[]) {
    test(`a session signed in another way (${Object.keys(env)[0]}) does not take the account file's login as its own`, keyless, async ($, on) => {
      const w = world(on, { accountFile: ACCOUNT_FILE, env })
      await turn($, false)
      await end($)
      await w.clock.advance(TICK)
      expect(w.seen).toEqual([])
      expect(w.posts.settings).toEqual([])
    })
  }

  test('the account file under CLAUDE_CONFIG_DIR', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, env: { CLAUDE_CONFIG_DIR: '/home/dev/.claude-work' } })
    await turn($, false)
    await end($)
    await w.clock.advance(TICK)
    expect(w.statusRows().map(r => r.attributes['organization.id'])).toEqual([ORG])
    expect(w.reads).toContain('/home/dev/.claude-work/.claude.json')
    expect(w.reads).not.toContain(`${HOME}/.claude.json`)
  })

  test("a row that names the session after the account file did: the next status row goes under the row's identity", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await turn($, false)
    await w.clock.advance(TICK)
    await w.clock.advance(TICK)
    const other = { 'organization.id': '0f8fad5b-d9cb-469f-a165-70867728950e', 'user.email': 'other@example.org', 'session.id': 's-9' }
    await turn($, true, other)
    await end($)
    await w.clock.advance(TICK)
    expect(w.statusRows().map(r => [r.attributes['organization.id'], r.attributes['user.email'], r.attributes[ISSUES]])).toEqual([
      [ORG, EMAIL, ['rows_skipped']],
      [other['organization.id'], other['user.email'], undefined],
    ])
    expect(w.posts.settings.map(p => JSON.parse(p.body))).toContainEqual({ claude_org_id: other['organization.id'], email: other['user.email'] })
  })

  test('a turn that asks no model says nothing of rows: no rows_skipped, and the account file is not read', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await turn($, false, COMMON, false)
    await w.clock.advance(2 * TICK)
    expect(w.reads).not.toContain(`${HOME}/.claude.json`)
    // The next turn asks the model, and its rows never come.
    await turn($, false)
    await w.clock.advance(2 * TICK)
    await end($)
    expect(w.statusRows().map(r => r.attributes[ISSUES])).toEqual([['rows_skipped']])
  })

  test("a marker goes under the account file's identity where no row reaches the plugin, in the session its event names", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await turn($, false)
    await $.classic.StopFailure({ error: 'rate_limit', prompt_id: 'prompt-1', session_id: 'sess-1' } as never)
    await w.clock.advance(2 * TICK)
    await end($)
    await w.clock.advance(TICK)
    const spans = w.seen.filter(p => new URL(p.url).pathname === '/v1/traces').flatMap(p => (JSON.parse(p.body) as { resourceSpans: { scopeSpans: { spans: { name: string; attributes: { key: string; value: { stringValue?: string } }[] }[] }[] }[] }).resourceSpans)
      .flatMap(rs => rs.scopeSpans.flatMap(ss => ss.spans))
    const stop = spans.find(x => x.name === 'mainwave.claude_code.stop_failure')
    expect(stop).toBeDefined()
    const attr = (k: string) => stop!.attributes.find(a => a.key === k)?.value.stringValue
    expect([attr('organization.id'), attr('user.email'), attr('user.account_uuid'), attr('session.id')]).toEqual([ORG, EMAIL, ACCOUNT, 'sess-1'])
  })
})
