// Where no row of Claude Code's reaches the plugin (a built-in plugin runs first and sends them on past it): the rows the plugin builds
// from Claude Code's own events, and the spans and metrics that follow from them. The engine beneath is played by rig.ts and the kit's
// mocks, and the network by keyless ingest's own rules.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { accountDeviceOf, costOf, decisionSource, hostIdentityOf, isRefusal, seedCost, newRowless, promptRow, providerOf, requestRow, resultRow, rowHead, sessionIdentityOf, uuidOf } from '../hooks/rowless.ts'
import { ACCOUNT, boot, contractViolations, DEVICE, EMAIL, keylessAnswer, LOGGED_AT, memoryStore, network, ORG, PROD, records, type Post } from './rig.ts'

const keyless = { options: {} }
const START = 1_800_000_000_000
const HOME = '/home/dev'
/** Claude's account file as a login leaves it (example values). */
const ACCOUNT_FILE = { userID: DEVICE, oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL, accountUuid: ACCOUNT } }
/** Another organization and person, as a host names them. */
const HOST_ORG = '0f8fad5b-d9cb-469f-a165-70867728950e'
const HOST_EMAIL = 'host@example.com'
const BUILT = 'mainwave.telemetry.built_from'
const USAGE = { input_tokens: 1201, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 }

type World = { env?: Record<string, string>; accountFile?: unknown; version?: string; costs?: number[]; rowsSeen?: boolean; startedAt?: number; costBefore?: number }

function world(on: On, opts: World = {}) {
  const clock = mock.clock(on, { now: START })
  memoryStore(on)
  // A reload: the process has seen a row of Claude Code's before.
  if (opts.rowsSeen) on('state.get', (_$, e, next) => ((e as unknown as { key?: string }).key === 'rowsSeen' ? ({ value: true } as never) : next(e)))
  const posts = network(on, (_n, post) => {
    const answer = keylessAnswer(post)
    return { status: answer.status, text: answer.text }
  })
  // Claude Code 2.1.326 on hands each plugin a row as it loads, so a turn that begins with none seen means none comes.
  const rig = boot(on, { entrypoint: 'cli', env: { HOME, ...opts.env }, version: opts.version ?? '2.1.328' })
  on('fs.read', (_$, e) => {
    const path = (e as unknown as { path: string }).path
    if (path === `${HOME}/.claude.json` && opts.accountFile !== undefined) return { value: JSON.stringify(opts.accountFile) } as never
    throw new Error(`no file at ${path} in test`)
  })
  on('session.id', () => ({ value: 's-1' }) as never)
  // The session's cost after each request, in turn; `spend` adds a cost outside any request of a turn.
  const costs = [...(opts.costs ?? [0.01, 0.03, 0.06, 0.1])]
  let cost = opts.costBefore ?? 0
  const spend = (usd: number) => (cost = Math.round((cost + usd) * 1e9) / 1e9)
  on('session.usage', () => ({ value: { startedAt: opts.startedAt ?? START, context: {}, rateLimits: [], cost: { usd: cost } } }) as never)
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: 'ok' }) as never)
  on('turn.step', async function* (_$, e) {
    await clock.advance(30)
    yield { kind: 'text', index: 0, text: 'ok' } as never
    await clock.advance(70)
    cost = Math.round(((costs.shift() ?? 0) + cost) * 1e9) / 1e9
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
  })
  // The permission check: an ask for a command outside the working folder, an allow for the rest.
  on('tool.check', (_$, e) => ((e as { input?: { command?: string } }).input?.command === 'touch /outside' ? { decision: 'ask', reason: 'needs approval' } : { decision: 'allow' }) as never)
  on('tool.call', async (_$, e) => {
    await clock.advance(25)
    const input = e as unknown as { command?: string }
    if (input.command === 'rm -rf x') return { deny: 'refused in test' } as never
    // An ask the session settles no ends the call in an error, as a failed tool does.
    if (input.command === 'touch /outside') return { ref: 1, isError: true, result: 'Error: needs approval', text: 'Error: needs approval' } as never
    if (input.command === 'false') return { ref: 1, isError: true, result: 'Error: exit 1', text: 'Error: exit 1' } as never
    return { result: { stdout: 'hi', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } } as never
  })
  const logs = () => posts.filter(p => new URL(p.url).pathname === '/v1/logs').flatMap(records)
  const built = () => logs().filter(r => r.attributes[BUILT] === 'events')
  return { clock, posts, rig, logs, built, spend }
}

/** One main-loop turn: a prompt, one model request, one Bash call, as Claude Code's events alone show them. */
async function turn($: Engine, text = 'go', id = 'toolu_1') {
  await $.turn.start({ turnId: 't1', text } as never)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, effort: 'medium' } as never)
  while (!(await stream.next()).done) {
    // Read to its end, as the engine does.
  }
  await $.tool.call({ tool: 'Bash', command: 'echo hi', description: 'x', tool_use_id: id } as never)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 200, isAborted: false, reason: 'answer' } as never)
}

const start = ($: Engine) => $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
const end = ($: Engine) => $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)

function spans(posts: readonly Post[]) {
  const out: { name: string; traceId: string; spanId: string; parentSpanId?: string; attrs: Record<string, unknown> }[] = []
  const plain = (v: Record<string, unknown>): unknown => ('stringValue' in v ? v['stringValue'] : 'intValue' in v ? Number(v['intValue']) : 'doubleValue' in v ? v['doubleValue'] : 'boolValue' in v ? v['boolValue'] : (v['arrayValue'] as { values: Record<string, unknown>[] }).values.map(plain))
  for (const p of posts.filter(p => p.url === `${PROD}/v1/traces`)) {
    for (const rs of JSON.parse(p.body).resourceSpans) {
      for (const ss of rs.scopeSpans) for (const s of ss.spans) out.push({ ...s, attrs: Object.fromEntries(s.attributes.map((a: { key: string; value: Record<string, unknown> }) => [a.key, plain(a.value)])) })
    }
  }
  return out
}

function points(posts: readonly Post[]) {
  const out: { name: string; value: number; attrs: Record<string, unknown> }[] = []
  for (const p of posts.filter(p => p.url === `${PROD}/v1/metrics`)) {
    for (const rm of JSON.parse(p.body).resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          for (const d of m.sum.dataPoints) {
            out.push({ name: m.name, value: d.asDouble ?? Number(d.asInt), attrs: Object.fromEntries(d.attributes.map((a: { key: string; value: Record<string, unknown> }) => [a.key, Object.values(a.value)[0]])) })
          }
        }
      }
    }
  }
  return out
}

describe('the rows built from events', () => {
  test('no row comes by the first turn: each turn sends a prompt, request, decision and result row, under the account file\'s identity', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    const rows = w.built()
    expect(rows.length).toBe(4)
    expect(new Set(rows.map(r => r.attributes['event.name']))).toEqual(new Set(['user_prompt', 'api_request', 'tool_decision', 'tool_result']))
    for (const r of rows) {
      expect(r.attributes['organization.id']).toBe(ORG)
      expect(r.attributes['user.email']).toBe(EMAIL)
      expect(r.attributes['user.account_uuid']).toBe(ACCOUNT)
      expect(r.attributes['user.id']).toBe(DEVICE)
      expect(r.attributes['session.id']).toBe('s-1')
      expect(r.attributes['mainwave.telemetry.route']).toBe('plugin')
      expect(r.attributes['mainwave.plugin.name']).toBe('mainwave')
      expect(contractViolations(r.attributes)).toEqual([])
    }
    const by = (event: string) => rows.find(r => r.attributes['event.name'] === event)!.attributes
    expect(by('user_prompt')['prompt_length']).toBe('2')
    const promptId = by('user_prompt')['prompt.id']
    expect(promptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    for (const r of rows) expect(r.attributes['prompt.id']).toBe(promptId)
    const req = by('api_request')
    expect(req['model']).toBe('claude-haiku-5-5')
    expect(req['input_tokens']).toBe(1201)
    expect(req['output_tokens']).toBe(20)
    expect(req['cache_read_tokens']).toBe(300)
    expect(req['cache_creation_tokens']).toBe(40)
    expect(req['cache_creation_1h_tokens']).toBe(40)
    expect(req['cost_usd']).toBe(0.01)
    expect(req['duration_ms']).toBe(100)
    expect(req['ttft_ms']).toBe(30)
    expect(req['effort']).toBe('medium')
    expect(req['query_source']).toBe('repl_main_thread')
    expect(by('tool_decision')).toEqual(expect.objectContaining({ decision: 'accept', tool_name: 'Bash', tool_use_id: 'toolu_1' }))
    expect(by('tool_result')).toEqual(expect.objectContaining({ success: 'true', duration_ms: '25', tool_name: 'Bash', tool_use_id: 'toolu_1' }))
  })

  test('the spans and metrics go too, in one trace per turn, each saying it was built from events', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, env: { CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1' } })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    await end($)
    const sent = spans(w.posts)
    expect(sent.map(s => s.name).sort()).toEqual(['claude_code.interaction', 'claude_code.llm_request', 'claude_code.tool', 'claude_code.tool.blocked_on_user', 'claude_code.tool.execution'])
    const by = (n: string) => sent.find(s => s.name === `claude_code.${n}`)!
    // Claude Code traces (the beta is on), but no row names a span: the plugin builds the trace.
    for (const s of sent) {
      expect(s.traceId).toBe(by('interaction').traceId)
      expect(s.attrs[BUILT]).toBe('events')
      expect(s.attrs['organization.id']).toBe(ORG)
      expect(s.attrs['user.email']).toBe(EMAIL)
    }
    expect(by('interaction').parentSpanId).toBeUndefined()
    expect(by('llm_request').parentSpanId).toBe(by('interaction').spanId)
    expect(by('llm_request').attrs['input_tokens']).toBe(1201)
    expect(by('llm_request').attrs['stop_reason']).toBe('end_turn')
    expect(by('tool').parentSpanId).toBe(by('interaction').spanId)
    expect(by('tool.execution').parentSpanId).toBe(by('tool').spanId)
    const p = points(w.posts)
    expect(p.find(x => x.name === 'claude_code.cost.usage')?.value).toBe(0.01)
    expect(p.filter(x => x.name === 'claude_code.token.usage').map(x => [x.attrs['type'], x.value])).toEqual([['input', 1201], ['output', 20], ['cacheRead', 300], ['cacheCreation', 40]])
    expect(p.find(x => x.name === 'claude_code.session.count')?.value).toBe(1)
    for (const x of p) expect(x.attrs[BUILT]).toBe('events')
  })

  test('each request costs what the session\'s cost grew by since the one before', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, costs: [0.01, 0.02] })
    await start($)
    await turn($, 'go', 'toolu_1')
    await turn($, 'again', 'toolu_2')
    await w.clock.advance(5_000)
    expect(w.built().filter(r => r.attributes['event.name'] === 'api_request').map(r => r.attributes['cost_usd'])).toEqual([0.01, 0.02])
  })

  test("the host's identity stands over the account file's, as Claude Code reads them", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, env: { CLAUDE_CODE_ORGANIZATION_UUID: HOST_ORG, CLAUDE_CODE_USER_EMAIL: HOST_EMAIL } })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    for (const r of w.built()) {
      expect(r.attributes['organization.id']).toBe(HOST_ORG)
      expect(r.attributes['user.email']).toBe(HOST_EMAIL)
      expect(r.attributes['user.account_uuid']).toBeUndefined()
      expect(r.attributes['user.id']).toBe(DEVICE)
    }
    expect(w.built().length).toBe(4)
  })

  test("a session signed in another way goes under the host's identity, with the account file's device ID alone", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, env: { CLAUDE_CODE_OAUTH_TOKEN: 'token', CLAUDE_CODE_ORGANIZATION_UUID: HOST_ORG, CLAUDE_CODE_USER_EMAIL: HOST_EMAIL } })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    expect(w.built().length).toBe(4)
    for (const r of w.built()) {
      expect(r.attributes['organization.id']).toBe(HOST_ORG)
      expect(r.attributes['user.email']).toBe(HOST_EMAIL)
      expect(r.attributes['user.account_uuid']).toBeUndefined()
      expect(r.attributes['user.id']).toBe(DEVICE)
    }
  })

  test('no identity to go under: rows are built but nothing goes, and nothing holds the turn', keyless, async ($, on) => {
    const w = world(on)
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    await end($)
    expect(w.posts.filter(p => new URL(p.url).pathname !== '/v1/logs' || records(p).some(r => r.attributes[BUILT] !== undefined))).toEqual([])
  })

  test("Claude Code's rows come: nothing is built, and the copy is theirs", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await $.telemetry.log({ to: 'collector', event: 'plugin_loaded', loggedAt: LOGGED_AT, attributes: { 'organization.id': ORG, 'user.email': EMAIL, 'session.id': 's-1', 'event.name': 'plugin_loaded' } } as never)
    await turn($)
    await w.clock.advance(5_000)
    expect(w.built()).toEqual([])
    expect(spans(w.posts).some(s => s.attrs[BUILT] !== undefined)).toBe(false)
  })

  test('a row that comes after the rows were built ends them: the next turn is not built', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await turn($, 'go', 'toolu_1')
    await w.clock.advance(5_000)
    const before = w.built().length
    expect(before).toBe(4)
    await $.telemetry.log({ to: 'collector', event: 'user_prompt', loggedAt: LOGGED_AT, attributes: { 'organization.id': ORG, 'user.email': EMAIL, 'session.id': 's-1', 'event.name': 'user_prompt', prompt_length: '5' } } as never)
    await turn($, 'again', 'toolu_2')
    await w.clock.advance(5_000)
    expect(w.built().length).toBe(before)
  })

  test('a Claude Code that hands no row at load: no row by the first turn builds nothing yet, and the grace\'s rows_skipped builds the next', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, version: '2.1.322' })
    await start($)
    await turn($, 'go', 'toolu_1')
    await w.clock.advance(5_000)
    expect(w.built()).toEqual([])
    await turn($, 'again', 'toolu_2')
    await w.clock.advance(5_000)
    expect(new Set(w.built().map(r => r.attributes['event.name']))).toEqual(new Set(['user_prompt', 'api_request', 'tool_decision', 'tool_result']))
  })

  test("the prompt row carries Claude Code's own prompt id, where the session says it", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    on('session.info', () => ({ value: { transcriptPath: '', sysname: 'Darwin', promptId: 'prompt-from-claude-1' } }) as never)
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    expect(new Set(w.built().map(r => r.attributes['prompt.id']))).toEqual(new Set(['prompt-from-claude-1']))
  })

  test('a reload after a row came: the process has seen rows, so the first turn after it builds nothing', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, rowsSeen: true })
    await start($)
    await turn($)
    await w.clock.advance(1_000)
    expect(w.built()).toEqual([])
  })

  test("a cost outside a turn's requests goes in cost.usage as auxiliary, between turns and at the end; the requests' own stay theirs", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, costs: [0.01, 0.02] })
    await start($)
    await turn($, 'go', 'toolu_1')
    // Between turns: a suggestion, a memory, a compaction.
    w.spend(0.005)
    await turn($, 'again', 'toolu_2')
    // After the last turn.
    w.spend(0.002)
    await end($)
    expect(w.built().filter(r => r.attributes['event.name'] === 'api_request').map(r => r.attributes['cost_usd'])).toEqual([0.01, 0.02])
    const cost = points(w.posts).filter(p => p.name === 'claude_code.cost.usage')
    const sum = (list: typeof cost) => Math.round(list.reduce((n, p) => n + p.value, 0) * 1e9) / 1e9
    expect(sum(cost.filter(p => p.attrs['query_source'] === 'auxiliary'))).toBe(0.007)
    expect(sum(cost.filter(p => p.attrs['query_source'] === 'main'))).toBe(0.03)
    expect(sum(cost)).toBe(0.037)
  })

  test('a session resumed or reloaded long after it began: the cost it had already is not the first request\'s', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, startedAt: START - 3_600_000, costBefore: 0.5, costs: [0.01] })
    await start($)
    await turn($)
    await end($)
    expect(w.built().filter(r => r.attributes['event.name'] === 'api_request').map(r => r.attributes['cost_usd'])).toEqual([0.01])
    expect(points(w.posts).filter(p => p.name === 'claude_code.cost.usage').reduce((n, p) => n + p.value, 0)).toBe(0.01)
  })

  test("a session on an API key goes under no one, whatever the host's variables say", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, env: { ANTHROPIC_API_KEY: 'key', CLAUDE_CODE_ORGANIZATION_UUID: HOST_ORG, CLAUDE_CODE_USER_EMAIL: HOST_EMAIL } })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    await end($)
    expect(w.posts).toEqual([])
  })

  test('a turn no prompt began (a continuation) builds no prompt row', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await turn($, 'go', 'toolu_1')
    await turn($, '', 'toolu_2')
    await w.clock.advance(5_000)
    expect(w.built().filter(r => r.attributes['event.name'] === 'user_prompt').length).toBe(1)
    expect(w.built().filter(r => r.attributes['event.name'] === 'api_request').length).toBe(2)
  })

  test('a refused call has its decision alone, a reject, as in Claude Code', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.tool.call({ tool: 'Bash', command: 'rm -rf x', description: 'x', tool_use_id: 'toolu_9' } as never)
    await w.clock.advance(5_000)
    const rows = w.built().filter(r => r.attributes['tool_use_id'] === 'toolu_9')
    expect(rows.map(r => [r.attributes['event.name'], r.attributes['decision']])).toEqual([['tool_decision', 'reject']])
    const blocked = spans(w.posts).filter(s => s.name === 'claude_code.tool.blocked_on_user')
    expect(blocked.map(s => s.attrs['decision'])).toEqual(['reject'])
  })

  test('an ask the session settled no is a reject; a call allowed that failed is accepted, and its result a failure', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    // The check runs inside the call in Claude Code; here, just before it.
    await $.tool.check({ tool: 'Bash', input: { command: 'touch /outside' }, tool_use_id: 'toolu_ask' } as never)
    await $.tool.call({ tool: 'Bash', command: 'touch /outside', description: 'x', tool_use_id: 'toolu_ask' } as never)
    await $.tool.check({ tool: 'Bash', input: { command: 'false' }, tool_use_id: 'toolu_fail' } as never)
    await $.tool.call({ tool: 'Bash', command: 'false', description: 'x', tool_use_id: 'toolu_fail' } as never)
    await w.clock.advance(5_000)
    const of = (id: string) => w.built().filter(r => r.attributes['tool_use_id'] === id).map(r => [r.attributes['event.name'], r.attributes['decision'] ?? r.attributes['success']])
    expect(of('toolu_ask')).toEqual([['tool_decision', 'reject']])
    expect(of('toolu_fail')).toEqual([['tool_decision', 'accept'], ['tool_result', 'false']])
  })

  test('a subagent\'s request goes as a subagent\'s, and its turn builds no prompt row', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.turn.start({ turnId: 't2', text: 'sub', agentId: 'a1' } as never)
    const stream = $.turn.step({ turnId: 't2', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' } as never)
    while (!(await stream.next()).done) {
      // Read to its end.
    }
    await w.clock.advance(5_000)
    const rows = w.built()
    expect(rows.filter(r => r.attributes['event.name'] === 'user_prompt').length).toBe(1)
    const req = rows.find(r => r.attributes['event.name'] === 'api_request')!.attributes
    expect(req['agent_id']).toBe('a1')
    expect(req['query_source']).toBe('agent:custom')
  })
})

describe('rowless.ts', () => {
  test("Claude Code's texts of a refusal: the person's, one no one could be asked about, the ask's own reason; not a tool's own failure", () => {
    expect(isRefusal("The user doesn't want to proceed with this tool use. The tool use was rejected.", undefined)).toBe(true)
    expect(isRefusal('Error: Permission to use Bash has been denied. IMPORTANT: ...', undefined)).toBe(true)
    expect(isRefusal("Error: touch in '/tmp/x' needs approval.", "touch in '/tmp/x' needs approval.")).toBe(true)
    expect(isRefusal('Error: Exit code 1', 'needs approval for this')).toBe(false)
    expect(isRefusal('Error: x', 'x')).toBe(false)
    expect(isRefusal(undefined, undefined)).toBe(false)
  })

  test("the shares start from nothing where the session began as the plugin loaded, else from the session's cost then", () => {
    const fresh = newRowless()
    seedCost(fresh, { startedAt: 1_000, costUsd: 0.002 }, 2_000)
    expect(fresh.costUsd).toBe(0)
    const resumed = newRowless()
    seedCost(resumed, { startedAt: 1_000, costUsd: 0.5 }, 1_000 + 3_600_000)
    expect(resumed.costUsd).toBe(0.5)
    seedCost(resumed, { startedAt: 0, costUsd: 9 }, 1)
    expect(resumed.costUsd).toBe(0.5)
    // After a change of session: a /clear that starts the cost over, one that carries it on, a resume that restores it.
    const cleared = newRowless()
    seedCost(cleared, { startedAt: 10_000, costUsd: 0.01 }, 10_000, 0.5)
    expect(cleared.costUsd).toBe(0)
    const carried = newRowless()
    seedCost(carried, { startedAt: 10_000, costUsd: 0.6 }, 10_000, 0.5)
    expect(carried.costUsd).toBe(0.5)
    const restored = newRowless()
    seedCost(restored, { startedAt: 1_000, costUsd: 2 }, 1_000 + 3_600_000, 0.5)
    expect(restored.costUsd).toBe(2)
  })

  test("the head says where requests go and a terminal no person types into, as Claude Code's rows do", () => {
    const head = rowHead({}, { 'organization.id': ORG, 'user.email': EMAIL }, 's-1', { provider: providerOf({ CLAUDE_CODE_USE_BEDROCK: '1' }), customBaseUrl: true, nonInteractive: true })
    expect(head).toEqual({ 'session.id': 's-1', 'organization.id': ORG, 'user.email': EMAIL, 'anthropic.provider': 'bedrock', 'anthropic.custom_base_url': true, 'terminal.type': 'non-interactive' })
    expect(rowHead({}, {}, 's-1', { provider: providerOf({}), customBaseUrl: false, nonInteractive: false })).toEqual({ 'session.id': 's-1', 'anthropic.provider': 'firstParty' })
  })

  test("a decision's source where the check names it; a subagent's requests by its type; a result's sizes in bytes", () => {
    expect(decisionSource({ decision: 'allow', rule: 'Bash(echo:*)' })).toBe('config')
    expect(decisionSource({ decision: 'deny', hook: 'guard' })).toBe('hook')
    expect(decisionSource({ decision: 'ask', rule: 'x' })).toBeUndefined()
    expect(decisionSource({ decision: 'allow' })).toBeUndefined()
    const s = newRowless()
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const req = (agent?: { type: string; builtIn: boolean }) => requestRow(s, {}, { model: 'm', usage, agentId: 'a1', ...(agent ? { agent } : {}), startMs: 0, endMs: 1, sdk: false }).attributes
    expect(req({ type: 'general-purpose', builtIn: true })).toEqual(expect.objectContaining({ query_source: 'agent:builtin:general-purpose', 'agent.name': 'general-purpose', cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0 }))
    expect(req({ type: 'reviewer', builtIn: false })['query_source']).toBe('agent:custom:reviewer')
    expect(req()['query_source']).toBe('agent:custom')
    const ok = resultRow(s, {}, { tool: 'Bash', id: 't', startMs: 0, endMs: 1, isError: false, input: { command: 'echo é' }, text: 'é' }).attributes
    expect([ok['tool_input_size_bytes'], ok['tool_result_size_bytes']]).toEqual(['21', '2'])
    expect(resultRow(s, {}, { tool: 'Bash', id: 't', startMs: 0, endMs: 1, isError: true, text: 'boom' }).attributes['tool_result_size_bytes']).toBeUndefined()
    expect(accountDeviceOf({ userID: DEVICE, oauthAccount: { organizationUuid: ORG } })).toEqual({ 'user.id': DEVICE })
  })

  test("the host's identity needs both the organization and the email, each of its shape", () => {
    expect(hostIdentityOf({ CLAUDE_CODE_ORGANIZATION_UUID: HOST_ORG, CLAUDE_CODE_USER_EMAIL: HOST_EMAIL, CLAUDE_CODE_ACCOUNT_UUID: ACCOUNT })).toEqual({ 'organization.id': HOST_ORG, 'user.email': HOST_EMAIL, 'user.account_uuid': ACCOUNT })
    expect(hostIdentityOf({ CLAUDE_CODE_ORGANIZATION_UUID: HOST_ORG })).toEqual({})
    expect(hostIdentityOf({ CLAUDE_CODE_ORGANIZATION_UUID: 'not-an-org', CLAUDE_CODE_USER_EMAIL: HOST_EMAIL })).toEqual({})
    expect(hostIdentityOf({ CLAUDE_CODE_ORGANIZATION_UUID: HOST_ORG, CLAUDE_CODE_USER_EMAIL: 'nobody' })).toEqual({})
    expect(hostIdentityOf({ CLAUDE_CODE_ORGANIZATION_UUID: HOST_ORG, CLAUDE_CODE_USER_EMAIL: HOST_EMAIL, CLAUDE_CODE_ACCOUNT_UUID: 'x' })).toEqual({ 'organization.id': HOST_ORG, 'user.email': HOST_EMAIL })
  })

  test("the host's identity stands over the file's, the file's device with it", () => {
    const file = { 'organization.id': ORG, 'user.email': EMAIL, 'user.account_uuid': ACCOUNT, 'user.id': DEVICE }
    expect(sessionIdentityOf({}, file)).toEqual(file)
    expect(sessionIdentityOf({ 'organization.id': HOST_ORG, 'user.email': HOST_EMAIL }, file)).toEqual({ 'user.id': DEVICE, 'organization.id': HOST_ORG, 'user.email': HOST_EMAIL })
  })

  test("the head: the resource's attributes first, then the device, the session and who it is", () => {
    const head = rowHead({ 'mainwave.source': 'coding_agent.claude_code', 'organization.id': 'from-resource' }, { 'organization.id': ORG, 'user.email': EMAIL, 'user.id': DEVICE }, 's-1')
    expect(Object.keys(head)).toEqual(['mainwave.source', 'user.id', 'session.id', 'organization.id', 'user.email'])
    expect(head['organization.id']).toBe(ORG)
  })

  test('a prompt id has the shape of a version 4 UUID', () => {
    expect(uuidOf('0123456789abcdef0123456789abcdef')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test("a request's cost is the session's growth since the last reading; none where it can't be read; all of it after it started over", () => {
    const s = newRowless()
    expect(costOf(s, 0.5)).toBe(0.5)
    expect(costOf(s, 0.75)).toBe(0.25)
    expect(costOf(s, undefined)).toBeUndefined()
    // Lower than the last: the session's cost started over, and all of it is new.
    expect(costOf(s, 0.1)).toBe(0.1)
    expect(costOf(s, 0.3)).toBe(0.2)
  })

  test("the rows carry Claude Code's names and value types, in sequence, under the turn's prompt id", () => {
    const s = newRowless()
    const head = { 'session.id': 's-1' }
    const p = promptRow(s, head, 'hello', 1000, 'p-1')
    const r = requestRow(s, head, { model: 'claude-haiku-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, startMs: 1000, endMs: 1500, sdk: true, costUsd: 0.2 })
    const t = resultRow(s, head, { tool: 'Read', id: 'toolu_9', startMs: 1500, endMs: 1600, isError: true })
    expect(p.attributes).toEqual({ 'session.id': 's-1', 'event.name': 'user_prompt', 'event.timestamp': new Date(1000).toISOString(), 'event.sequence': 0, 'prompt.id': 'p-1', prompt_length: '5', prompt: '<REDACTED>', prompt_text: '<REDACTED>' })
    expect(r.attributes).toEqual({
      'session.id': 's-1', 'event.name': 'api_request', 'event.timestamp': new Date(1500).toISOString(), 'event.sequence': 1, 'prompt.id': 'p-1', model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 2,
      cache_read_tokens: 3, cache_creation_tokens: 4, cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0, cost_usd: 0.2, cost_usd_micros: 200000, duration_ms: 500, query_source: 'sdk',
    })
    expect(t.attributes).toEqual(expect.objectContaining({ 'event.sequence': 2, success: 'false', duration_ms: '100', tool_name: 'Read', tool_use_id: 'toolu_9' }))
  })
})
