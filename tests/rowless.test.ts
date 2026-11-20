// Where no row of Claude Code's reaches the plugin (a built-in plugin runs first and sends them on past it): the rows the plugin builds
// from Claude Code's own events, and the spans and metrics that follow from them. The engine beneath is played by rig.ts and the kit's
// mocks, and the network by keyless ingest's own rules.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { accountDeviceOf, agentLedgerOf, agentTranscriptPath, costOf, helperRequestId, helperRow, ledgerGrowth, decisionOf, handoffPrompt, hostContinue, insertedText, permissionRules, personPrompt, handoverIn, typedText, decisionSource, headOf, hostIdentityOf, joinPath, madeCommit, refusalKind, repoAttributes, promptIdFrom, responseTextOf, seedCost, newRowless, promptRow, providerOf, remoteSessionIdOf, requestIdIn, requestRow, resultRow, rowHead, sessionIdentityOf, stepRequestId, uuidOf } from '../hooks/rowless.ts'
import { REQUEST_ID_TRIES, TRANSCRIPT_RETRY_MS } from '../hooks/register.ts'
import { ACCOUNT, boot, contractViolations, DEVICE, EMAIL, infoCall, keylessAnswer, LOGGED_AT, memoryStore, network, ORG, PROD, records, type Post, type Reply } from './rig.ts'

const keyless = { options: {} }
const START = 1_800_000_000_000
/** How long the settings hook takes to answer an ask. */
const ANSWER_MS = 2_000
const HOME = '/home/dev'
const TRANSCRIPT = '/home/dev/.claude/projects/-work-app/s-1.jsonl'
/** Claude's account file as a login leaves it (example values). */
const ACCOUNT_FILE = { userID: DEVICE, oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL, accountUuid: ACCOUNT } }
/** Another organization and person, as a host names them. */
const HOST_ORG = '0f8fad5b-d9cb-469f-a165-70867728950e'
const HOST_EMAIL = 'host@example.com'
const BUILT = 'mainwave.telemetry.built_from'
const USAGE = { input_tokens: 1201, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 }

type World = { messages?: unknown[] | (() => unknown[]); settings?: () => Reply | Promise<Reply>; repo?: { remote: string | null } | null; files?: Record<string, string>; saved?: boolean; env?: Record<string, string>; entrypoint?: string; machine?: string; dropPrompt?: string; turns?: Record<string, () => Promise<void>>; accountFile?: unknown; version?: string; costs?: number[]; rowsSeen?: boolean; startedAt?: number; costBefore?: number; store?: Record<string, unknown>; transcript?: string | (() => string); promptId?: string | (() => string); duringCall?: (id: string) => Promise<void>; duringStep?: (step: { turnId: string; index: number; agentId?: string }) => Promise<void>; beforeRun?: (id: string) => void; live?: Record<string, () => string>; stepTools?: (step: { agentId?: string }) => string[]; agents?: () => unknown[] | Promise<unknown[]> }

function world(on: On, opts: World = {}) {
  const clock = mock.clock(on, { now: START })
  memoryStore(on, opts.store)
  // A reload: the process has seen a row of Claude Code's before.
  if (opts.rowsSeen) on('state.get', (_$, e, next) => ((e as unknown as { key?: string }).key === 'rowsSeen' ? ({ value: true } as never) : next(e)))
  const posts = network(on, (_n, post) => {
    const answer = keylessAnswer(post)
    return { status: answer.status, text: answer.text }
  }, undefined, opts.settings)
  // Claude Code 2.1.326 on hands each plugin a row as it loads, so a turn that begins with none seen means none comes.
  const rig = boot(on, { entrypoint: opts.entrypoint ?? 'cli', env: { HOME, ...opts.env }, version: opts.version ?? '2.1.328' })
  // `$.session.machine()`, by a glob: Claude Code before 2.1.328 has no such call, and refuses a hook that names it.
  const machine = opts.machine
  if (machine !== undefined) {
    on('session.*', (_$, e, next) => ((next.event as string) === 'session.machine' ? ({ value: { sysname: 'Linux', release: '6.8.0', machine, packageManagers: [], runtimes: [] } } as never) : next(e)))
  }
  // The engine enters each prompt, but the one a hook drops. A prompt `turns` names starts its turn, with the text the host gives it,
  // before the submission resolves, as Claude Code's does.
  on('prompt.submit', async (_$, e) => {
    const text = (e as { text: string }).text
    if (text === opts.dropPrompt) return { drop: 'dropped in test' } as never
    await opts.turns?.[text]?.()
    return { text } as never
  })
  // With `transcript`, the session's transcript file, its lines as given (a function reads it as it is at the call), and `promptId` the
  // prompt the session is on: `$.session.info()` says where it is, by a glob, as Claude Code before 2.1.326 refuses a hook that names
  // that call. A read may take a stretch of it.
  const transcript = opts.transcript === undefined ? undefined : typeof opts.transcript === 'function' ? opts.transcript : () => opts.transcript as string
  const promptNow = () => (typeof opts.promptId === 'function' ? opts.promptId() : opts.promptId ?? 'prompt-host')
  // `live`: more files read as they are at each call (a subagent's transcript), each there from the start.
  const liveFile = (path: string) => (path === TRANSCRIPT ? transcript : opts.live?.[path])
  if (transcript !== undefined) {
    on('session.*', (_$, e, next) => ((next.event as string) === 'session.info' ? ({ value: { transcriptPath: TRANSCRIPT, promptId: promptNow(), platform: 'linux', isHosted: true } } as never) : next(e)))
    on('fs.stat', (_$, e, next) => {
      const file = liveFile((e as unknown as { path: string }).path)
      return file !== undefined ? ({ value: { kind: 'file', size: new TextEncoder().encode(file()).length, mtimeMs: START, isLink: false } } as never) : next(e)
    })
  }
  on('fs.read', (_$, e) => {
    const path = (e as unknown as { path: string }).path
    const file = liveFile(path)
    if (file !== undefined) {
      const { offset = 0, length } = e as unknown as { offset?: number; length?: number }
      return { value: new TextDecoder().decode(new TextEncoder().encode(file()).subarray(offset, length === undefined ? undefined : offset + length)) } as never
    }
    if (path === `${HOME}/.claude.json` && opts.accountFile !== undefined) return { value: JSON.stringify(opts.accountFile) } as never
    if (opts.files?.[path] !== undefined) return { value: opts.files[path] } as never
    throw new Error(`no file at ${path} in test`)
  })
  on('session.id', () => ({ value: 's-1' }) as never)
  on('session.cwd', () => ({ value: '/work/app' }) as never)
  // The transcript's newest messages: `last` of them, as the engine cuts it; a function reads the transcript as it is at the call.
  on('session.messages', (_$, e) => {
    const all = (typeof opts.messages === 'function' ? opts.messages() : opts.messages) ?? []
    const last = (e as unknown as { last?: number }).last
    return { value: last === undefined ? all : all.slice(-last) } as never
  })
  on('session.repo', () => ({ value: opts.repo === undefined || opts.repo === null ? null : { root: '/work/app', remote: opts.repo.remote, internal: false, name: null } }) as never)
  // The session's cost after each request, in turn; `spend` adds a cost outside any request of a turn.
  const costs = [...(opts.costs ?? [0.01, 0.03, 0.06, 0.1])]
  let cost = opts.costBefore ?? 0
  const spend = (usd: number) => (cost = Math.round((cost + usd) * 1e9) / 1e9)
  on('session.usage', () => ({ value: { startedAt: opts.startedAt ?? START, context: {}, rateLimits: [], cost: { usd: cost } } }) as never)
  // Whether the engine itself has `$.session.machine()` (2.1.328 on), asked by the test's own hook as the session starts (infoCall).
  let machineThere = false
  on('session.start', async ($, e) => {
    if (machine !== undefined) machineThere = await infoCall(() => ($ as unknown as { session: { machine: () => Promise<unknown> } }).session.machine())
    return { cwd: (e as { cwd: string }).cwd } as never
  })
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: 'ok' }) as never)
  on('turn.step', async function* (_$, e) {
    await clock.advance(30)
    yield { kind: 'text', index: 0, text: 'ok' } as never
    await clock.advance(70)
    // The rows of the response the conversation keeps, as the engine keeps them while the request streams (`session.append`).
    await opts.duringStep?.({ turnId: e.turnId, index: e.index, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) })
    cost = Math.round(((costs.shift() ?? 0) + cost) * 1e9) / 1e9
    const toolUses = (opts.stepTools?.({ ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) }) ?? []).map(name => ({ name, input: {} }))
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses, stopReason: toolUses.length > 0 ? 'tool_use' : 'end_turn', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
  })
  // The session's subagents, each with its ledger as `agents` says it is at the call.
  if (opts.agents !== undefined) on('agent.list', async () => ({ value: await opts.agents!() }) as never)
  // The permission check: an ask for a command outside the working folder, and for one a settings hook on the permission request
  // answers (`touch /asked`); an allow for the rest. With `saved`, the answer was saved: the check allows the command outright.
  on('tool.check', (_$, e) => {
    // What the session spends before a call runs (a classifier asked about it).
    opts.beforeRun?.((e as { tool_use_id?: string }).tool_use_id ?? '')
    const command = (e as { input?: { command?: string } }).input?.command
    if (command === 'touch /outside') return { decision: 'ask', reason: 'needs approval' } as never
    if (command?.startsWith('touch /asked')) return (opts.saved ? { decision: 'allow', rule: 'Bash(touch:*)' } : { decision: 'ask', reason: 'needs approval' }) as never
    return { decision: 'allow' } as never
  })
  // Nobody is asked in a test: the settings hook answers `touch /asked`, after two seconds, and says no to `touch /asked, refused`.
  on('classic.PermissionRequest', async (_$, e) => {
    const command = (e as { tool_input?: { command?: string } }).tool_input?.command
    if (!command?.startsWith('touch /asked')) return {} as never
    await clock.advance(ANSWER_MS)
    return { decision: command === 'touch /asked, refused' ? { behavior: 'deny', message: 'not now' } : { behavior: 'allow' } } as never
  })
  // The tool itself, once the call is allowed and has begun to run.
  on('tool.call', async (_$, e) => {
    await opts.duringCall?.((e as unknown as { tool_use_id: string }).tool_use_id)
    await clock.advance(25)
    const input = e as unknown as { command?: string }
    if (input.command === 'rm -rf x') return { deny: 'refused in test' } as never
    if (input.command === 'false') return { ref: 1, isError: true, result: 'Error: exit 1', text: 'Error: exit 1' } as never
    if ((e as unknown as { url?: string }).url === 'https://example.com/missing') return { ref: 1, isError: true, result: 'Error: 404', text: 'Error: 404' } as never
    if (input.command === 'git commit -m x') return { result: { stdout: '[feature/login 1a2b3c4] x\n 1 file changed', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } } as never
    return { result: { stdout: 'hi', stderr: '', interrupted: false, isImage: false, noOutputExpected: false } } as never
  })
  const logs = () => posts.filter(p => new URL(p.url).pathname === '/v1/logs').flatMap(records)
  const built = () => logs().filter(r => r.attributes[BUILT] === 'events')
  return { clock, posts, rig, logs, built, spend, machineThere: () => machineThere }
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
  test('no row comes by the first turn: each turn sends a prompt, request, response, decision and result row, under the account file\'s identity', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    const rows = w.built()
    expect(rows.length).toBe(5)
    expect(new Set(rows.map(r => r.attributes['event.name']))).toEqual(new Set(['user_prompt', 'api_request', 'assistant_response', 'tool_decision', 'tool_result']))
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
    expect(w.built().length).toBe(5)
  })

  test("a session signed in another way goes under the host's identity, with the account file's device ID alone", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, env: { CLAUDE_CODE_OAUTH_TOKEN: 'token', CLAUDE_CODE_ORGANIZATION_UUID: HOST_ORG, CLAUDE_CODE_USER_EMAIL: HOST_EMAIL } })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    expect(w.built().length).toBe(5)
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
    expect(before).toBe(5)
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
    expect(new Set(w.built().map(r => r.attributes['event.name']))).toEqual(new Set(['user_prompt', 'api_request', 'assistant_response', 'tool_decision', 'tool_result']))
  })

  test('the content the gate turns on goes on the built rows: the prompt, the response and the tool input; none of it while off', keyless, async ($, on) => {
    const off = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await turn($, 'tell me a secret')
    await off.clock.advance(5_000)
    const by = (event: string) => off.built().find(r => r.attributes['event.name'] === event)!.attributes
    expect(by('user_prompt')['prompt']).toBe('<REDACTED>')
    expect(by('assistant_response')['response']).toBe('<REDACTED>')
    expect(by('assistant_response')['response_length']).toBe(2)
    expect(by('tool_result')['tool_input']).toBeUndefined()
    expect(JSON.stringify(off.posts.map(p => p.body))).not.toContain('tell me a secret')
  })

  test('with prompt.text, response.text and tool.input on (and what tool input holds), the built rows carry them, through the redaction packs, and each once', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, store: { dataPoints: { 'prompt.text': 'on', 'response.text': 'on', 'tool.input': 'on', 'bash.command': 'on', 'file.path': 'on', 'web.url': 'on' }, redactionPacks: ['pii.contact'] } })
    await start($)
    await turn($, 'mail jane@example.org please', 'toolu_1')
    await w.clock.advance(5_000)
    const of = (event: string) => w.built().filter(r => r.attributes['event.name'] === event).map(r => r.attributes)
    expect(of('user_prompt').length).toBe(1)
    const prompt = String(of('user_prompt')[0]!['prompt'])
    expect(prompt).toContain('mail ')
    expect(prompt).not.toContain('jane@example.org')
    expect(of('assistant_response').map(a => a['response'])).toEqual(['ok'])
    expect(of('tool_result').map(a => a['tool_input'])).toEqual([expect.stringContaining('echo hi')])
    // A row of Claude Code's for the same response, coming late, fills nothing from the stream the built row carried.
    await $.telemetry.log({ to: 'collector', event: 'assistant_response', loggedAt: LOGGED_AT, attributes: { 'organization.id': ORG, 'user.email': EMAIL, 'session.id': 's-1', 'event.name': 'assistant_response', response_length: 2, response: '<REDACTED>', query_source: 'repl_main_thread' } } as never)
    await w.clock.advance(5_000)
    const responses = w.logs().filter(r => r.attributes['event.name'] === 'assistant_response').map(r => r.attributes['response'])
    expect(responses.filter(t => t === 'ok').length).toBe(1)
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

  test("a turn the host starts with no text takes the prompt submitted while idle: one prompt row, of that prompt's length", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, env: { CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1' }, turns: { 'summarize the notes': () => turn($, '', 'toolu_1') } })
    await start($)
    await $.prompt.submit({ text: 'summarize the notes', wait: false, origin: { kind: 'sdk' } } as never)
    // The next turn with no text is a continuation: the prompt went with the turn before.
    await turn($, '', 'toolu_2')
    await w.clock.advance(5_000)
    await end($)
    const prompts = w.built().filter(r => r.attributes['event.name'] === 'user_prompt')
    expect(prompts.length).toBe(1)
    expect(prompts[0]!.attributes['prompt_length']).toBe('19')
    expect(prompts[0]!.attributes['prompt']).toBe('<REDACTED>')
    expect(JSON.stringify(w.posts.map(p => p.body))).not.toContain('summarize the notes')
    // The interaction takes the prompt row, and its length.
    const interactions = spans(w.posts).filter(x => x.name === 'claude_code.interaction')
    expect(interactions.map(x => x.attrs['user_prompt_length'])).toEqual([19, 0])
  })

  test('with prompt.text on, that prompt row carries the submitted text', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, store: { dataPoints: { 'prompt.text': 'on' } }, turns: { 'summarize the notes': () => turn($, '', 'toolu_1') } })
    await start($)
    await $.prompt.submit({ text: 'summarize the notes', wait: false, origin: { kind: 'sdk' } } as never)
    await w.clock.advance(5_000)
    const prompts = w.built().filter(r => r.attributes['event.name'] === 'user_prompt')
    expect(prompts.map(r => [r.attributes['prompt_length'], r.attributes['prompt']])).toEqual([['19', 'summarize the notes']])
  })

  test("a prompt typed into a running turn, one dropped, or one that started no turn, is no later turn's: a turn with no text then builds no prompt row", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, dropPrompt: 'blocked' })
    await start($)
    await turn($, 'go', 'toolu_1')
    await $.prompt.submit({ text: 'and also this', turnId: 't1', wait: false, origin: { kind: 'composer' } } as never)
    await turn($, '', 'toolu_2')
    await $.prompt.submit({ text: 'blocked', wait: false, origin: { kind: 'composer' } } as never)
    await turn($, '', 'toolu_3')
    // One that entered and started no turn by the time it resolved: none of the turns after it is its.
    await $.prompt.submit({ text: 'started nothing', wait: false, origin: { kind: 'composer' } } as never)
    await turn($, '', 'toolu_4')
    await w.clock.advance(5_000)
    const prompts = w.built().filter(r => r.attributes['event.name'] === 'user_prompt')
    expect(prompts.map(r => r.attributes['prompt_length'])).toEqual(['2'])
  })

  test("a prompt the person never sees as typed (isMeta), or one a plugin submits over a running turn, is no empty turn's", keyless, async ($, on) => {
    const w = world(on, {
      accountFile: ACCOUNT_FILE,
      turns: {
        'hidden reminder': () => turn($, '', 'toolu_1'),
        // Still entering when the running turn ends and a continuation starts.
        'from a plugin': async () => {
          await $.turn.complete({ turnId: 't9', answer: 'ok', durationMs: 20, isAborted: false, reason: 'answer' } as never)
          await turn($, '', 'toolu_3')
        },
      },
    })
    await start($)
    await $.prompt.submit({ text: 'hidden reminder', isMeta: true, wait: false, origin: { kind: 'sdk' } } as never)
    // A plugin's prompt carries no turnId even while a turn runs; the continuation that follows the turn is not its.
    await $.turn.start({ turnId: 't9', text: 'go' } as never)
    await $.prompt.submit({ text: 'from a plugin', wait: false, origin: { kind: 'plugin' } } as never)
    await w.clock.advance(5_000)
    expect(w.built().filter(r => r.attributes['event.name'] === 'user_prompt').map(r => r.attributes['prompt_length'])).toEqual(['2'])
  })

  test("a subagent's turn with no text neither takes the prompt held for the main loop nor lets it go", keyless, async ($, on) => {
    const w = world(on, {
      accountFile: ACCOUNT_FILE,
      turns: {
        'summarize the notes': async () => {
          await $.turn.start({ turnId: 'sub-1', text: '', agentId: 'agent-1' } as never)
          await $.turn.complete({ turnId: 'sub-1', answer: 'ok', durationMs: 10, isAborted: false, reason: 'answer', agentId: 'agent-1' } as never)
          await turn($, '', 'toolu_1')
        },
      },
    })
    await start($)
    await $.prompt.submit({ text: 'summarize the notes', wait: false, origin: { kind: 'sdk' } } as never)
    await w.clock.advance(5_000)
    expect(w.built().filter(r => r.attributes['event.name'] === 'user_prompt').map(r => r.attributes['prompt_length'])).toEqual(['19'])
  })

  test("a turn that starts with its own text keeps it, whatever was submitted", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, turns: { typed: () => turn($, 'typed, expanded', 'toolu_1') } })
    await start($)
    await $.prompt.submit({ text: 'typed', wait: false, origin: { kind: 'composer' } } as never)
    await w.clock.advance(5_000)
    expect(w.built().filter(r => r.attributes['event.name'] === 'user_prompt').map(r => r.attributes['prompt_length'])).toEqual(['15'])
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

describe("a tool's own model request (WebFetch's, WebSearch's), in the rows built from events", () => {
  const event = (r: { attributes: Record<string, unknown> }) => r.attributes['event.name']
  const requests = (w: ReturnType<typeof world>) => w.built().filter(r => event(r) === 'api_request').map(r => r.attributes)
  const read = async (stream: AsyncGenerator<unknown, unknown, unknown>) => {
    while (!(await stream.next()).done) {
      // Read to its end, as the engine does.
    }
  }

  /** A main-loop turn: a request that asks for `call`, the call, and the request after it. */
  async function callTurn($: Engine, call: Record<string, unknown>) {
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await read($.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1 } as never))
    await $.tool.call(call as never)
    await read($.turn.step({ turnId: 't1', index: 1, model: 'claude-haiku-5-5', messageCount: 3 } as never))
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 200, isAborted: false, reason: 'answer' } as never)
  }

  test("a WebFetch call's request in the main loop: a row and span of its own, its cost its own and not the next request's", keyless, async ($, on) => {
    let spend = (_usd: number) => 0
    // What the session spends before the call's run (a classifier's request about it) goes with the next request, as before.
    const w = world(on, {
      accountFile: ACCOUNT_FILE, env: { CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1' }, costs: [0.01, 0.03],
      beforeRun: id => void (id === 'toolu_w' && spend(0.001)), duringCall: async id => void (id === 'toolu_w' && spend(0.004)),
    })
    spend = w.spend
    await start($)
    await callTurn($, { tool: 'WebFetch', url: 'https://example.com/a', prompt: 'Summarize', tool_use_id: 'toolu_w' })
    await w.clock.advance(5_000)
    await end($)
    // Between the call's decision and its result, as Claude Code logs it.
    expect(w.built().map(event)).toEqual(['user_prompt', 'api_request', 'assistant_response', 'tool_decision', 'api_request', 'tool_result', 'api_request', 'assistant_response'])
    expect(requests(w).map(r => r['cost_usd'])).toEqual([0.01, 0.004, 0.031])
    const helper = requests(w)[1]!
    expect(helper).toEqual(expect.objectContaining({ query_source: 'web_fetch_apply', request_id: 'helper_toolu_w', cost_usd: 0.004, cost_usd_micros: 4000, duration_ms: 25 }))
    // No event of the main loop's says the request's model or tokens.
    for (const k of ['model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'agent_id']) expect(helper[k]).toBeUndefined()
    // Its span sits in the call's run, in the turn's trace, as Claude Code's does; its row is logged in that run.
    const sent = spans(w.posts)
    const run = sent.find(s => s.name === 'claude_code.tool.execution' && s.attrs['tool_use_id'] === 'toolu_w')!
    const llm = sent.filter(s => s.name === 'claude_code.llm_request')
    expect(llm.length).toBe(3)
    const own = llm.find(s => s.attrs['request_id'] === 'helper_toolu_w')!
    expect(own.parentSpanId).toBe(run.spanId)
    expect(own.traceId).toBe(sent.find(s => s.name === 'claude_code.interaction')!.traceId)
    expect(own.attrs).toEqual(expect.objectContaining({ 'llm_request.context': 'tool', query_source_safe: 'web_fetch_apply', [BUILT]: 'events' }))
    const record = w.built().find(r => r.attributes['request_id'] === 'helper_toolu_w')!
    expect([record.traceId, record.spanId]).toEqual([run.traceId, run.spanId])
    // Its cost counts as Claude Code's exporter counts a request outside the main loop and its subagents'.
    const cost = points(w.posts).filter(x => x.name === 'claude_code.cost.usage')
    expect(cost.find(x => x.attrs['query_source'] === 'auxiliary')?.value).toBe(0.004)
    expect(Math.abs(cost.reduce((n, x) => n + x.value, 0) - 0.045)).toBeLessThan(1e-9)
  })

  test("a WebSearch call's request in a subagent: its model and tokens, what the subagent's ledger grew by over the call", keyless, async ($, on) => {
    let spend = (_usd: number) => 0
    const ledger: Record<string, unknown>[] = [{ model: 'claude-sonnet-5-5', input_tokens: 1201, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 }]
    const w = world(on, {
      accountFile: ACCOUNT_FILE, costs: [0.01, 0.03],
      stepTools: step => (step.agentId === 'a1' ? ['WebSearch'] : []),
      agents: () => [{ id: 'a0', usage: [] }, { id: 'a1', usage: ledger.map(u => ({ ...u })) }],
      duringCall: async id => {
        if (id !== 'toolu_s') return
        ledger.push({ model: 'claude-haiku-5-5', input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
        spend(0.002)
      },
    })
    spend = w.spend
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.turn.start({ turnId: 't2', text: 'sub', agentId: 'a1' } as never)
    await read($.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'a1' } as never))
    await $.tool.call({ tool: 'WebSearch', query: 'news', agentId: 'a1', tool_use_id: 'toolu_s' } as never)
    await read($.turn.step({ turnId: 't2', index: 1, model: 'claude-sonnet-5-5', messageCount: 3, agentId: 'a1' } as never))
    await w.clock.advance(5_000)
    await end($)
    expect(requests(w).map(r => r['cost_usd'])).toEqual([0.01, 0.002, 0.03])
    expect(requests(w)[1]).toEqual(expect.objectContaining({
      query_source: 'web_search_tool', request_id: 'helper_toolu_s', agent_id: 'a1', model: 'claude-haiku-5-5',
      input_tokens: 900, output_tokens: 40, cache_read_tokens: 0, cache_creation_tokens: 0, cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0,
    }))
    const tokens = points(w.posts).filter(x => x.name === 'claude_code.token.usage' && x.attrs['model'] === 'claude-haiku-5-5' && x.attrs['query_source'] === 'auxiliary')
    expect(tokens.map(x => [x.attrs['type'], x.value])).toEqual([['input', 900], ['output', 40], ['cacheRead', 0], ['cacheCreation', 0]])
  })

  test('a call that made no request, or failed, builds none: what the session spent meanwhile stays with the next reading', keyless, async ($, on) => {
    let spend = (_usd: number) => 0
    const w = world(on, {
      accountFile: ACCOUNT_FILE, costs: [0.01, 0.03, 0.05, 0.07],
      duringCall: async id => void (id === 'toolu_bad' && spend(0.004)),
    })
    spend = w.spend
    await start($)
    // Nothing grew while it ran (a page it answered without asking the model).
    await callTurn($, { tool: 'WebFetch', url: 'https://example.com/a', prompt: 'x', tool_use_id: 'toolu_free' })
    // It failed: no request of its own, whatever the session spent meanwhile.
    await callTurn($, { tool: 'WebFetch', url: 'https://example.com/missing', prompt: 'x', tool_use_id: 'toolu_bad' })
    await w.clock.advance(5_000)
    expect(requests(w).map(r => r['query_source'])).toEqual(['repl_main_thread', 'repl_main_thread', 'repl_main_thread', 'repl_main_thread'])
    expect(requests(w).map(r => r['cost_usd'])).toEqual([0.01, 0.03, 0.05, 0.074])
  })

  test('two calls whose requests both end before either call does: the first to end takes both shares, the other has no row, the total stands', keyless, async ($, on) => {
    let spend = (_usd: number) => 0
    const w = world(on, { accountFile: ACCOUNT_FILE, costs: [0.01, 0.03], duringCall: async id => void (id.startsWith('toolu_p') && spend(0.004)) })
    spend = w.spend
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await read($.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1 } as never))
    await Promise.all(['toolu_p1', 'toolu_p2'].map(id => $.tool.call({ tool: 'WebFetch', url: `https://example.com/${id}`, prompt: 'x', tool_use_id: id } as never)))
    await read($.turn.step({ turnId: 't1', index: 1, model: 'claude-haiku-5-5', messageCount: 4 } as never))
    await w.clock.advance(5_000)
    const costs = requests(w).map(r => [r['query_source'], r['cost_usd']])
    expect(costs).toEqual([['repl_main_thread', 0.01], ['web_fetch_apply', 0.008], ['repl_main_thread', 0.03]])
  })

  test("two of a subagent's calls on one model that end together: one row takes both requests' tokens, none counted twice", keyless, async ($, on) => {
    let spend = (_usd: number) => 0
    const haiku = { model: 'claude-haiku-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const w = world(on, {
      accountFile: ACCOUNT_FILE, costs: [0.01, 0.03],
      // A reading the engine takes a moment to answer, so the two calls' end readings overlap.
      agents: async () => {
        const usage = [{ ...haiku }]
        await new Promise<void>(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout(r, 20))
        return [{ id: 'a1', usage }]
      },
      duringCall: async id => {
        if (!id.startsWith('toolu_q')) return
        haiku.input_tokens += 900
        haiku.output_tokens += 40
        spend(0.002)
      },
    })
    spend = w.spend
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.turn.start({ turnId: 't2', text: 'sub', agentId: 'a1' } as never)
    await read($.turn.step({ turnId: 't2', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' } as never))
    await Promise.all(['toolu_q1', 'toolu_q2'].map(id => $.tool.call({ tool: 'WebSearch', query: id, agentId: 'a1', tool_use_id: id } as never)))
    await read($.turn.step({ turnId: 't2', index: 1, model: 'claude-haiku-5-5', messageCount: 4, agentId: 'a1' } as never))
    await w.clock.advance(5_000)
    await end($)
    const helpers = requests(w).filter(r => r['query_source'] === 'web_search_tool')
    expect(helpers.map(r => [r['cost_usd'], r['input_tokens'], r['output_tokens']])).toEqual([[0.004, 1800, 80]])
    const input = points(w.posts).filter(x => x.name === 'claude_code.token.usage' && x.attrs['query_source'] === 'auxiliary' && x.attrs['type'] === 'input')
    expect(input.reduce((n, x) => n + x.value, 0)).toBe(1800)
  })

  test("a subagent's ledger: what grew between two readings, on one model alone", () => {
    const u = (model: string, input: number, extra: Record<string, number> = {}) => ({ model, input_tokens: input, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, ...extra })
    expect(agentLedgerOf([{ id: 'a1', usage: [u('m1', 100), { model: 1 }, null] }, { id: 'a2' }], 'a1')).toEqual([u('m1', 100)])
    expect(agentLedgerOf([{ id: 'a2', usage: [] }], 'a1')).toBeUndefined()
    expect(agentLedgerOf({ deny: 'no' }, 'a1')).toBeUndefined()
    // A model new to the ledger, or one grown.
    expect(ledgerGrowth([u('m1', 100)], [u('m1', 100), u('m2', 50)])).toEqual(u('m2', 50))
    expect(ledgerGrowth([u('m1', 100)], [{ ...u('m1', 130), output_tokens: 14 }])).toEqual({ model: 'm1', input_tokens: 30, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
    expect(ledgerGrowth([u('m1', 100, { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 0 })], [u('m1', 120, { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 0 })]))
      .toEqual({ model: 'm1', input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 })
    // Nothing grew; two models grew (which counts are whose no reading says); the ledger started over.
    expect(ledgerGrowth([u('m1', 100)], [u('m1', 100)])).toBeUndefined()
    expect(ledgerGrowth([u('m1', 100)], [u('m1', 120), u('m2', 50)])).toBeUndefined()
    expect(ledgerGrowth([u('m1', 100)], [u('m1', 40)])).toBeUndefined()
    expect(ledgerGrowth([u('m1', 100), u('m2', 10)], [u('m1', 120)])).toBeUndefined()
  })

  test("a tool's own request's row: its source by the tool, an ID of the call's that is never an API request's, and only what is known", () => {
    expect(helperRequestId('toolu_1')).toBe('helper_toolu_1')
    expect(helperRequestId('toolu_1').startsWith('req_')).toBe(false)
    const state = newRowless()
    expect(helperRow(state, {}, { tool: 'Bash', toolUseId: 'toolu_1', runStartMs: 0, endMs: 10, costUsd: 0.1 })).toBeUndefined()
    const fetched = helperRow(state, { 'session.id': 's-1' }, { tool: 'WebFetch', toolUseId: 'toolu_1', runStartMs: 1_000, endMs: 1_250, costUsd: 0.0012345 })!
    expect(fetched.event).toBe('api_request')
    expect(fetched.atMs).toBe(1_250)
    expect(fetched.attributes).toEqual({
      'session.id': 's-1', 'event.name': 'api_request', 'event.timestamp': new Date(1_250).toISOString(), 'event.sequence': 0,
      cost_usd: 0.0012345, cost_usd_micros: 1235, duration_ms: 250, request_id: 'helper_toolu_1', query_source: 'web_fetch_apply',
    })
    const searched = helperRow(state, {}, {
      tool: 'WebSearch', toolUseId: 'toolu_2', agentId: 'a1', runStartMs: 0, endMs: 10,
      usage: { model: 'claude-haiku-5-5', input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 3, ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 3 },
    })!
    expect(searched.attributes).toEqual(expect.objectContaining({
      'event.sequence': 1, model: 'claude-haiku-5-5', input_tokens: 9, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 3, cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 3,
      query_source: 'web_search_tool', agent_id: 'a1',
    }))
    expect(searched.attributes['cost_usd']).toBeUndefined()
  })
})

describe('the permission wait, the repository and the first prompt, in the rows built from events', () => {
  const ofCall = (w: ReturnType<typeof world>, id: string) => w.built().filter(r => r.attributes['tool_use_id'] === id).map(r => r.attributes)
  const blockedOf = (w: ReturnType<typeof world>) => spans(w.posts).filter(s => s.name === 'claude_code.tool.blocked_on_user').map(s => s.attrs)

  test('an ask answered after two seconds: the decision is settled as the call begins to run, so its wait lasts the two seconds, and the result times the run alone', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.tool.call({ tool: 'Bash', command: 'touch /asked', description: 'x', tool_use_id: 'toolu_ask' } as never)
    await w.clock.advance(5_000)
    await end($)
    const [decision, result] = ofCall(w, 'toolu_ask')
    // Nobody can be asked in a test: a settings hook on the permission request answered, which reads as Claude Code's own (`config`).
    expect(decision).toEqual(expect.objectContaining({ 'event.name': 'tool_decision', decision: 'accept', source: 'config', 'event.timestamp': new Date(START + ANSWER_MS).toISOString() }))
    expect(result).toEqual(expect.objectContaining({ 'event.name': 'tool_result', success: 'true', duration_ms: '25' }))
    expect(blockedOf(w)).toEqual([expect.objectContaining({ decision: 'accept', source: 'config', duration_ms: ANSWER_MS })])
    const run = spans(w.posts).find(s => s.name === 'claude_code.tool.execution')!
    expect(run.attrs['duration_ms']).toBe(25)
  })

  test('an ask refused, nobody there to ask: a reject at the call\'s end, the configuration\'s', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE })
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.tool.call({ tool: 'Bash', command: 'touch /asked, refused', description: 'x', tool_use_id: 'toolu_no' } as never)
    await $.tool.call({ tool: 'Bash', command: 'touch /outside', description: 'x', tool_use_id: 'toolu_none' } as never)
    await w.clock.advance(5_000)
    await end($)
    expect(ofCall(w, 'toolu_no').map(a => [a['event.name'], a['decision'], a['source']])).toEqual([['tool_decision', 'reject', 'config']])
    expect(ofCall(w, 'toolu_none').map(a => [a['event.name'], a['decision'], a['source']])).toEqual([['tool_decision', 'reject', 'config']])
    expect(blockedOf(w).map(a => [a['decision'], a['source'], a['duration_ms']])).toEqual([['reject', 'config', ANSWER_MS], ['reject', 'config', 0]])
  })

  test('a call the check allows outright: the configuration\'s, and no wait', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, saved: true })
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.tool.call({ tool: 'Bash', command: 'touch /asked', description: 'x', tool_use_id: 'toolu_rule' } as never)
    await w.clock.advance(5_000)
    await end($)
    expect(ofCall(w, 'toolu_rule')[0]).toEqual(expect.objectContaining({ decision: 'accept', source: 'config', 'event.timestamp': new Date(START).toISOString() }))
    expect(blockedOf(w).map(a => a['duration_ms'])).toEqual([0])
  })

  test("with repo on, every built row, span and point names the origin remote's repository, after the session and before who it is, read again each turn", keyless, async ($, on) => {
    const repo = { remote: 'git@github.com:Acme/API.git' as string | null }
    const w = world(on, { accountFile: ACCOUNT_FILE, repo, store: { dataPoints: { repo: 'on' } } })
    await start($)
    await turn($, 'go', 'toolu_1')
    repo.remote = 'https://gitlab.com/group/sub/tool.git'
    await turn($, 'again', 'toolu_2')
    await w.clock.advance(5_000)
    await end($)
    const rows = w.built()
    expect(rows.length).toBe(10)
    const first = rows.filter(r => r.attributes['prompt.id'] === rows[0]!.attributes['prompt.id'])
    for (const r of first) {
      expect(r.attributes).toEqual(expect.objectContaining({ 'vcs.repository.url.full': 'https://github.com/acme/api', 'vcs.owner.name': 'acme', 'vcs.repository.name': 'api', 'vcs.provider.name': 'github' }))
      const keys = Object.keys(r.attributes)
      expect(keys.slice(keys.indexOf('session.id'), keys.indexOf('session.id') + 6)).toEqual(['session.id', 'vcs.repository.url.full', 'vcs.owner.name', 'vcs.repository.name', 'vcs.provider.name', 'organization.id'])
      expect(contractViolations(r.attributes)).toEqual([])
    }
    expect(rows.at(-1)!.attributes).toEqual(expect.objectContaining({ 'vcs.repository.url.full': 'https://gitlab.com/group/sub/tool', 'vcs.owner.name': 'group/sub', 'vcs.repository.name': 'tool', 'vcs.provider.name': 'gitlab' }))
    for (const x of spans(w.posts)) expect(typeof x.attrs['vcs.repository.name']).toBe('string')
    for (const x of points(w.posts)) expect(typeof x.attrs['vcs.repository.name']).toBe('string')
  })

  test('with repo off (the default), no row names the repository; nor in a session in none', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, repo: { remote: 'git@github.com:acme/api.git' } })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    expect(w.built().length).toBe(5)
    for (const r of w.built()) expect(Object.keys(r.attributes).filter(k => k.startsWith('vcs.'))).toEqual([])
  })

  // Claude Code adds the repository only with its switch on, and none of its rows come: what the plugin builds carries it only where
  // repo is on in its own right, whatever the switch.
  for (const repository of ['1', '0']) {
    test(`with repo as Claude Code sends it and its switch at ${repository}, the repository goes on nothing the plugin built: no row, span or point`, keyless, async ($, on) => {
      const w = world(on, { accountFile: ACCOUNT_FILE, repo: { remote: 'git@github.com:acme/api.git' }, env: { OTEL_METRICS_INCLUDE_REPOSITORY: repository }, store: { dataPoints: { repo: 'claude' } } })
      await start($)
      await turn($)
      await w.clock.advance(5_000)
      await end($)
      expect(w.built().length).toBe(5)
      expect(spans(w.posts).length).toBeGreaterThan(0)
      expect(points(w.posts).length).toBeGreaterThan(0)
      expect(JSON.stringify(w.posts.map(p => p.body))).not.toContain('vcs.')
    })
  }

  test("a commit a shell call made goes on its result as Claude Code names it: HEAD's commit and branch, and in its parameters", keyless, async ($, on) => {
    const sha = `1a2b3c4${'d'.repeat(33)}`
    const files = { '/work/app/.git/HEAD': 'ref: refs/heads/feature/login\n', '/work/app/.git/refs/heads/feature/login': `${sha}\n` }
    const w = world(on, { accountFile: ACCOUNT_FILE, repo: { remote: 'git@github.com:acme/api.git' }, files, store: { dataPoints: { repo: 'on', 'bash.command': 'on' } } })
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m x', description: 'x', tool_use_id: 'toolu_commit' } as never)
    await $.tool.call({ tool: 'Bash', command: 'echo hi', description: 'x', tool_use_id: 'toolu_echo' } as never)
    await w.clock.advance(5_000)
    const result = ofCall(w, 'toolu_commit').find(a => a['event.name'] === 'tool_result')!
    expect(result).toEqual(expect.objectContaining({ 'vcs.ref.head.revision': sha, 'vcs.ref.head.name': 'feature/login', 'vcs.ref.head.type': 'branch' }))
    const keys = Object.keys(result)
    expect(keys.slice(keys.indexOf('vcs.ref.head.revision'), keys.indexOf('vcs.ref.head.revision') + 3)).toEqual(['vcs.ref.head.revision', 'vcs.ref.head.name', 'vcs.ref.head.type'])
    expect(JSON.parse(String(result['tool_parameters']))).toEqual(expect.objectContaining({ full_command: 'git commit -m x', git_commit_id: sha, git_branch: 'feature/login' }))
    const echo = ofCall(w, 'toolu_echo').find(a => a['event.name'] === 'tool_result')!
    expect(Object.keys(echo).filter(k => k.startsWith('vcs.ref.'))).toEqual([])
    expect(JSON.parse(String(echo['tool_parameters']))['git_commit_id']).toBeUndefined()
  })

  /** Mainwave's answer, setting the content data points to `value`. */
  const contentAnswer = (value: 'on' | 'off'): Reply => {
    const points = { 'prompt.text': value, 'response.text': value, 'tool.input': value, 'tool.result': value, 'bash.command': value, 'file.path': value, 'web.url': value }
    return { status: 200, text: JSON.stringify({ revision: 1, catalog_version: 1, data_points: points, in_force: points, redaction_packs: ['secrets'], default_data_points: [], redaction_packs_default: false }) }
  }
  /** The answer, held until the test lets it go: it arrives after the first turn has run, as a slow first answer does. */
  function slowAnswer(reply: Reply) {
    let release = () => {}
    const settings = () => new Promise<Reply>(resolve => (release = () => resolve(reply)))
    return { settings, release: () => release() }
  }
  const contentOf = (w: ReturnType<typeof world>) => {
    const rows = w.built()
    const by = (event: string) => rows.filter(r => r.attributes['event.name'] === event).map(r => r.attributes)
    const tool = spans(w.posts).find(x => x.name === 'claude_code.tool') as { attrs: Record<string, unknown>; events?: { name: string }[] } | undefined
    return {
      prompt: by('user_prompt').map(a => a['prompt']),
      response: by('assistant_response').map(a => a['response']),
      input: by('tool_result').map(a => typeof a['tool_input']),
      command: tool?.attrs['full_command'],
      output: (tool?.events ?? []).some(e => e.name === 'tool.output'),
    }
  }

  test('the first answer arrives after the first turn ran: its rows and spans wait for it, and carry what it turns on; the turn waited for nothing', keyless, async ($, on) => {
    const slow = slowAnswer(contentAnswer('on'))
    const w = world(on, { accountFile: ACCOUNT_FILE, settings: slow.settings })
    await start($)
    // The whole turn runs while the answer is still held: nothing of it waits for the answer.
    await turn($, 'my first prompt')
    await w.clock.advance(1_000)
    expect(w.built()).toEqual([])
    slow.release()
    await w.clock.advance(5_000)
    expect(contentOf(w)).toEqual({ prompt: ['my first prompt'], response: ['ok'], input: ['string'], command: 'echo hi', output: true })
  })

  test('the first answer turns the content off: what was built before it goes without it, though everything was built', keyless, async ($, on) => {
    const slow = slowAnswer(contentAnswer('off'))
    const w = world(on, { accountFile: ACCOUNT_FILE, settings: slow.settings, store: { dataPoints: { 'prompt.text': 'on', 'response.text': 'on', 'tool.input': 'on', 'tool.result': 'on', 'bash.command': 'on' } } })
    await start($)
    await turn($, 'my first prompt')
    slow.release()
    await w.clock.advance(5_000)
    expect(contentOf(w)).toEqual({ prompt: ['<REDACTED>'], response: ['<REDACTED>'], input: ['undefined'], command: undefined, output: false })
    expect(JSON.stringify(w.posts.map(p => p.body))).not.toContain('my first prompt')
  })

  test('no first answer comes: after a few seconds the rows and spans go under the defaults, and the request failing says so on the status row', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, settings: () => 'reject' })
    await start($)
    await turn($, 'my first prompt')
    await w.clock.advance(5_000 + 6_000)
    await end($)
    expect(contentOf(w)).toEqual({ prompt: ['<REDACTED>'], response: ['<REDACTED>'], input: ['undefined'], command: undefined, output: false })
    expect(JSON.stringify(w.posts.map(p => p.body))).not.toContain('my first prompt')
    const status = w.logs().filter(r => r.attributes['event.name'] === 'plugin_status').map(r => r.attributes['mainwave.telemetry.issues'])
    expect(status.length).toBeGreaterThan(0)
    for (const issues of status) expect(issues).toEqual(expect.arrayContaining(['rows_skipped', 'settings_unavailable']))
  })

  test("a session that ends while its first answer is still out sends what waited, its metrics too", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, settings: () => 'hang' })
    await start($)
    await turn($, 'my first prompt')
    await end($)
    expect(w.built().length).toBe(5)
    expect(points(w.posts).find(p => p.name === 'claude_code.cost.usage')?.value).toBe(0.01)
    expect(points(w.posts).some(p => p.name === 'claude_code.token.usage')).toBe(true)
  })

  test('a first answer that hangs: the rows and spans go under the defaults once the request times out', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, settings: () => 'hang' })
    await start($)
    await turn($, 'my first prompt')
    await w.clock.advance(1_000)
    expect(w.built()).toEqual([])
    await w.clock.advance(15_000)
    expect(contentOf(w).prompt).toEqual(['<REDACTED>'])
    expect(w.built().length).toBe(5)
  })

  test("a session's first prompt row, built before the organization's settings first answer, carries what they turn on", keyless, async ($, on) => {
    const settings = (): Reply => ({
      status: 200,
      text: JSON.stringify({ revision: 1, catalog_version: 1, data_points: { 'prompt.text': 'on' }, in_force: { 'prompt.text': 'on' }, redaction_packs: ['secrets'], default_data_points: [], redaction_packs_default: false }),
    })
    const w = world(on, { accountFile: ACCOUNT_FILE, settings })
    await start($)
    await turn($, 'the very first prompt')
    await w.clock.advance(10_000)
    expect(w.built().filter(r => r.attributes['event.name'] === 'user_prompt').map(r => r.attributes['prompt'])).toEqual(['the very first prompt'])
  })
})

describe('in Cowork', () => {
  const REMINDER = "<system-reminder>The user's timezone is America/New_York (UTC-05:00). Message sent at Thu 2026-11-19 16:50 local time.</system-reminder>\n"
  const typed = 'please check the deploy'
  const promptsOf = (w: ReturnType<typeof world>) => w.built().filter(r => r.attributes['event.name'] === 'user_prompt').map(r => [r.attributes['prompt_length'], r.attributes['prompt']])

  test("a first turn that starts with no text and no prompt seen submitted takes the person's message the transcript ends on, without Cowork's reminder", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: [{ role: 'user', text: REMINDER + typed, toolUses: [] }] })
    await start($)
    await turn($, '')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([[String(typed.length), typed]])
    const rows = w.built()
    expect(rows.find(r => r.attributes['event.name'] === 'api_request')!.attributes['prompt.id']).toBe(rows[0]!.attributes['prompt.id'])
  })

  test("a first turn whose transcript ends on a message Claude Code inserted builds no prompt row", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', messages: [{ role: 'user', text: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>', toolUses: [] }] })
    await start($)
    await turn($, '')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([])
  })

  test("a first turn whose transcript ends on a notice Claude Code queued after the person's message takes the person's message", keyless, async ($, on) => {
    const notice = { role: 'user', text: '<task-notification>\nmainwave: its telemetry.log hook was skipped.\n</task-notification>', toolUses: [] }
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: [{ role: 'user', text: REMINDER + typed, toolUses: [] }, notice, notice] })
    await start($)
    await turn($, '')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([[String(typed.length), typed]])
  })

  const NOTICE = { role: 'user', text: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>', toolUses: [] }
  const EARLIER = { role: 'user', text: 'an earlier prompt', toolUses: [] }
  const RESULTS = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_0', text: 'done', isError: false }] }
  const FINAL = { role: 'assistant', text: 'done', toolUses: [] }
  const SAID = { role: 'assistant', text: 'I will list the files now.', toolUses: [] }
  const CALLED = (id: string) => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: 'ls' }, text: 'a.txt' }] })
  const ANSWERED = (id: string, text = 'a.txt') => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }] })
  const ENDS: [string, unknown[]][] = [
    ["the model's answer", [FINAL]],
    ['an interrupted request', [CALLED('toolu_0'), ANSWERED('toolu_0', '[Request interrupted by user for tool use]')]],
    ['the mark of an interrupted request', [{ role: 'user', text: '[Request interrupted by user]', toolUses: [] }]],
    ["a compaction's summary", [{ role: 'user', text: 'This session is being continued from a previous conversation that ran out of context.', toolUses: [] }]],
  ]
  for (const [what, stop] of ENDS) {
    test(`a load's first turn never takes an earlier turn's prompt: ${what} ends the walk back`, keyless, async ($, on) => {
      const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', messages: [EARLIER, ...stop, NOTICE] })
      await start($)
      await turn($, '')
      await w.clock.advance(5_000)
      expect(promptsOf(w)).toEqual([])
    })
  }

  test("a load's first turn that is the rest of a turn begun before the plugin's hooks were in place (Cowork) takes that turn's prompt, back past its calls and their results", keyless, async ($, on) => {
    const begun = [{ role: 'user', text: REMINDER + typed, toolUses: [] }, SAID, CALLED('toolu_a'), ANSWERED('toolu_a'), CALLED('toolu_b'), ANSWERED('toolu_b')]
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: [EARLIER, FINAL, ...begun] })
    await start($)
    await turn($, '', 'toolu_c')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([[String(typed.length), typed]])
    const rows = w.built()
    expect(rows.find(r => r.attributes['event.name'] === 'api_request')!.attributes['prompt.id']).toBe(rows.find(r => r.attributes['event.name'] === 'user_prompt')!.attributes['prompt.id'])
  })

  test("the walk back: past the turn's own calls, their results and the text Claude Code adds after them, to where an earlier turn ended", () => {
    const reminderOnly = { role: 'user', text: REMINDER, toolUses: [] }
    const person = { role: 'user', text: REMINDER + typed, toolUses: [] }
    const skillBody = { role: 'user', text: 'Base directory for this skill: /skills/docx\n\n# Making documents', toolUses: [] }
    const imageNote = { role: 'user', text: '[Image: original 1200x800, displayed at 600x400]', toolUses: [] }
    const across = (ms: unknown[]) => personPrompt(ms as never, true)
    expect(across([person, reminderOnly, NOTICE])).toBe(REMINDER + typed)
    // A response's text, held apart from the calls that follow it, is the turn's own; an answer no call follows ends it.
    expect(across([EARLIER, FINAL, person, SAID, CALLED('toolu_a'), ANSWERED('toolu_a'), NOTICE])).toBe(REMINDER + typed)
    expect(across([EARLIER, SAID, CALLED('toolu_a'), ANSWERED('toolu_a')])).toBe('an earlier prompt')
    expect(across([EARLIER, CALLED('toolu_a'), ANSWERED('toolu_a'), FINAL, NOTICE])).toBe('')
    expect(across([EARLIER, FINAL, { role: 'user', text: 'now this', toolUses: [] }, NOTICE])).toBe('now this')
    // A skill's body and an image's note come right after their call's result: the call's, not the person's.
    expect(across([person, CALLED('toolu_a'), ANSWERED('toolu_a', 'Launching skill: docx'), skillBody, CALLED('toolu_b'), ANSWERED('toolu_b')])).toBe(REMINDER + typed)
    expect(across([person, CALLED('toolu_a'), ANSWERED('toolu_a'), imageNote])).toBe(REMINDER + typed)
    expect(across([EARLIER, { role: 'user', text: '[Request interrupted by user]', toolUses: [] }])).toBe('')
    expect(across([ANSWERED('toolu_a')])).toBe('')
    expect(across([reminderOnly])).toBe('')
    expect(across([])).toBe('')
    // Without acrossCalls (as a turn begins), only a prompt at the transcript's end, past inserted messages alone.
    expect(personPrompt([EARLIER, FINAL, person, reminderOnly, NOTICE])).toBe(REMINDER + typed)
    expect(personPrompt([person, CALLED('toolu_a'), ANSWERED('toolu_a')] as never)).toBe('')
    expect(personPrompt([person, SAID] as never)).toBe('')
    expect(personPrompt([person, CALLED('toolu_a'), ANSWERED('toolu_a'), skillBody] as never)).toBe('')
  })

  test("a load's first turn begun before the hooks were in place takes its prompt past a skill's body, and as its first request begins", keyless, async ($, on) => {
    const skillBody = { role: 'user', text: 'Base directory for this skill: /skills/docx\n\n# Making documents', toolUses: [] }
    const begun = [{ role: 'user', text: REMINDER + typed, toolUses: [] }, CALLED('toolu_a'), ANSWERED('toolu_a', 'Launching skill: docx'), skillBody]
    let reads = 0
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: () => (reads++, begun) })
    await start($)
    await turn($, '', 'toolu_c')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([[String(typed.length), typed]])
    // Read as the turn began (its end held no prompt), and again at its first request.
    expect(reads).toBe(2)
  })

  const TRACES: [string, Record<string, string>][] = [['with the beta on', { CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1' }], ['where the plugin builds the trace', {}]]
  for (const [how, env] of TRACES) {
    test(`a first turn whose message reaches the transcript only after the turn began takes it at its first request (${how}): timed at the turn's start, before the request's rows, its interaction with it`, keyless, async ($, on) => {
      let messages: unknown[] = []
      const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', env, store: { dataPoints: { 'prompt.text': 'on' } }, messages: () => messages })
      await start($)
      await $.turn.start({ turnId: 't1', text: '' } as never)
      await w.clock.advance(40)
      messages = [{ role: 'user', text: REMINDER + typed, toolUses: [] }, NOTICE]
      const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 2, effort: 'medium' } as never)
      while (!(await stream.next()).done) {
        // Read to its end, as the engine does.
      }
      // A later request of the turn looks no more.
      const again = $.turn.step({ turnId: 't1', index: 1, model: 'claude-haiku-5-5', messageCount: 4, effort: 'medium' } as never)
      while (!(await again.next()).done) {
        // Read to its end.
      }
      await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 200, isAborted: false, reason: 'answer' } as never)
      await w.clock.advance(5_000)
      await end($)
      expect(promptsOf(w)).toEqual([[String(typed.length), typed]])
      const rows = w.built().filter(r => r.attributes['event.name'] !== 'plugin_status')
      const prompt = rows.find(r => r.attributes['event.name'] === 'user_prompt')!
      expect(prompt.attributes['event.timestamp']).toBe(new Date(START).toISOString())
      expect(prompt.attributes['event.sequence']).toBe(0)
      const requests = rows.filter(r => r.attributes['event.name'] === 'api_request')
      expect(requests.length).toBe(2)
      for (const r of requests) expect(r.attributes['prompt.id']).toBe(prompt.attributes['prompt.id'])
      const interactions = spans(w.posts).filter(x => x.name === 'claude_code.interaction')
      expect(interactions.map(x => [x.attrs['user_prompt_length'], x.attrs['user_prompt']])).toEqual([[typed.length, typed]])
    })
  }

  test("a first turn whose transcript holds no message of the person's even at its first request builds no prompt row", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', messages: [] })
    await start($)
    await turn($, '')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([])
    expect(w.built().filter(r => r.attributes['event.name'] === 'api_request').length).toBe(1)
  })

  // The session's transcript as Cowork's host writes it at a handover from chat: the person's message carried over, the model's calls
  // and their results, the system row that marks the handover, and the fields the host puts on the rows it writes.
  const line = (row: Record<string, unknown>) => `${JSON.stringify({ sessionId: 's-1', timestamp: '2026-11-19T21:50:00.000Z', ...row })}\n`
  const PERSON_ROW = (fields: Record<string, unknown> = {}) => line({ type: 'user', entrypoint: 'sdk-cli', message: { role: 'user', content: [{ type: 'text', text: REMINDER }, { type: 'text', text: typed }] }, ...fields })
  const CALL_ROW = (id: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } })
  const RESULT_ROW = (id: string, text: string) => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })
  const ANSWER_ROW = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
  const MARKER = line({ type: 'system', subtype: 'upgrade_relay_marker', entrypoint: 'remote_cowork', content: JSON.stringify({ conversation_uuid: '00000000-0000-4000-8000-000000000001', anchor_line_uuid: '00000000-0000-4000-8000-000000000002' }) })
  const QUEUED = `${line({ type: 'queue-operation', operation: 'enqueue' })}${line({ type: 'queue-operation', operation: 'dequeue' })}`
  const HANDED_OFF = { handedOff: true, origin: { kind: 'human' } }
  const HOST_FIELDS = { origin: { kind: 'human' }, promptSource: 'sdk', turnOrigin: 'human', textNotTyped: true, clientPlatform: 'desktop_app' }
  const HOST_ROW = (text: string, fields: Record<string, unknown> = HOST_FIELDS) => line({ type: 'user', userType: 'external', message: { role: 'user', content: [{ type: 'text', text }] }, ...fields })

  // Cowork hands a conversation begun in chat over to Claude Code with the chat's last call cut off: Claude Code runs that call before
  // the turn it is part of starts, with no text of its own.
  const handedOver = (done: boolean) => [
    { role: 'user', text: REMINDER + typed, toolUses: [] }, CALLED('toolu_glob'), ANSWERED('toolu_glob'), CALLED('toolu_early'), ...(done ? [ANSWERED('toolu_early', 'hi')] : []),
  ]
  const AFTER_MARKER = `${CALL_ROW('toolu_glob')}${RESULT_ROW('toolu_glob', 'a.txt')}${CALL_ROW('toolu_early')}${RESULT_ROW('toolu_early', 'hi')}`
  const CUT_OFF = `${PERSON_ROW(HANDED_OFF)}${MARKER}${AFTER_MARKER}`
  // The handover's row, but none of the host's fields on the person's message.
  const CUT_OFF_BARE = `${PERSON_ROW({ origin: { kind: 'human' } })}${MARKER}${AFTER_MARKER}`
  async function earlyCallThenTurn($: Engine, w: ReturnType<typeof world>, ran: () => void) {
    await start($)
    await w.clock.advance(1_000)
    await $.tool.call({ tool: 'Bash', command: 'echo hi', description: 'x', tool_use_id: 'toolu_early' } as never)
    ran()
    await w.clock.advance(200)
    await $.turn.start({ turnId: 't1', text: '' } as never)
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 6, effort: 'medium' } as never)
    while (!(await stream.next()).done) {
      // Read to its end, as the engine does.
    }
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 400, isAborted: false, reason: 'answer' } as never)
    await w.clock.advance(5_000)
    await end($)
  }

  // With the host's fields, the person's message carried over is the prompt as the turn begins, and the messages are never walked;
  // without them, it is read back through the messages, as the turn begins and again at its first request.
  const FIELDS: [string, string, number][] = [["by the host's fields", CUT_OFF, 0], ['without them', CUT_OFF_BARE, 2]]
  for (const [how, env] of TRACES) {
    for (const [found, transcript, walks] of FIELDS) {
      test(`a call Claude Code runs before the load's first turn starts has its rows under that turn's prompt, timed as it ran, its spans under the turn's interaction (${how}; the prompt ${found})`, keyless, async ($, on) => {
        let done = false
        let reads = 0
        const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', env, store: { dataPoints: { 'prompt.text': 'on' } }, messages: () => (reads++, handedOver(done)), transcript })
        await earlyCallThenTurn($, w, () => (done = true))
        expect(promptsOf(w)).toEqual([[String(typed.length), typed]])
        expect(reads).toBe(walks)
        const rows = w.built().filter(r => r.attributes['event.name'] !== 'plugin_status')
        expect(rows.map(r => r.attributes['event.name'])).toEqual(['user_prompt', 'tool_decision', 'tool_result', 'api_request', 'assistant_response'])
        const prompt = rows[0]!
        for (const r of rows) expect(r.attributes['prompt.id']).toBe(prompt.attributes['prompt.id'])
        // The call began a second after the session started and ran 25 ms; the turn began 200 ms after it ended. The prompt row is timed
        // as the call began, so nothing of the turn's comes before it.
        const call = START + 1_000
        expect(prompt.attributes['event.timestamp']).toBe(new Date(call).toISOString())
        const decision = rows[1]!
        const result = rows[2]!
        expect([decision.attributes['tool_use_id'], decision.attributes['decision'], decision.attributes['source']]).toEqual(['toolu_early', 'accept', 'config'])
        expect(decision.attributes['event.timestamp']).toBe(new Date(call).toISOString())
        expect([result.attributes['tool_use_id'], result.attributes['success'], result.attributes['duration_ms']]).toEqual(['toolu_early', 'true', '25'])
        expect(result.attributes['event.timestamp']).toBe(new Date(call + 25).toISOString())
        const all = spans(w.posts)
        const interaction = all.find(x => x.name === 'claude_code.interaction')!
        expect(interaction.attrs['user_prompt']).toBe(typed)
        const tool = all.find(x => x.name === 'claude_code.tool' && x.attrs['tool_use_id'] === 'toolu_early')!
        expect([tool.traceId, tool.parentSpanId]).toEqual([interaction.traceId, interaction.spanId])
      })
    }
  }

  test("a call before the load's first turn whose turn makes no request has its rows as the turn ends", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', messages: handedOver(true), transcript: CUT_OFF_BARE })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'echo hi', description: 'x', tool_use_id: 'toolu_early' } as never)
    await w.clock.advance(200)
    await $.turn.start({ turnId: 't1', text: '' } as never)
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 10, isAborted: true, reason: 'aborted' } as never)
    await w.clock.advance(5_000)
    expect(w.built().filter(r => r.attributes['event.name'] !== 'plugin_status').map(r => [r.attributes['event.name'], r.attributes['tool_use_id']])).toEqual([['tool_decision', 'toolu_early'], ['tool_result', 'toolu_early']])
  })

  for (const [how, opts] of [['the transcript shows no handover', { transcript: `${PERSON_ROW()}${AFTER_MARKER}` }], ['there is no transcript to read', {}]] as const) {
    test(`a call before the load's first turn in Cowork is not held where ${how}: rows never start inside a turn the load did not see begin`, keyless, async ($, on) => {
      let done = false
      const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', messages: () => handedOver(done), ...opts })
      await earlyCallThenTurn($, w, () => (done = true))
      expect(w.built().filter(r => r.attributes['tool_use_id'] === 'toolu_early')).toEqual([])
    })
  }

  for (const [found, transcript] of FIELDS) {
    test(`a call before the first turn that ends after the turn began has its rows after the turn's prompt, under its interaction (the prompt ${found})`, keyless, async ($, on) => {
      let done = false
      const w = world(on, {
        accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: () => handedOver(done), transcript,
        // The turn begins while the call still runs, 200 ms after it began.
        duringCall: async id => {
          if (id !== 'toolu_early') return
          await w.clock.advance(200)
          await $.turn.start({ turnId: 't1', text: '' } as never)
        },
      })
      await start($)
      await $.tool.call({ tool: 'Bash', command: 'echo hi', description: 'x', tool_use_id: 'toolu_early' } as never)
      done = true
      const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 6, effort: 'medium' } as never)
      while (!(await stream.next()).done) {
        // Read to its end.
      }
      await $.tool.call({ tool: 'Bash', command: 'echo later', description: 'x', tool_use_id: 'toolu_later' } as never)
      // The turn's own duration starts it after the call began.
      await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 10, isAborted: false, reason: 'answer' } as never)
      await w.clock.advance(5_000)
      await end($)
      expect(promptsOf(w)).toEqual([[String(typed.length), typed]])
      const rows = w.built().filter(r => r.attributes['event.name'] !== 'plugin_status')
      expect(rows.map(r => [r.attributes['event.name'], r.attributes['tool_use_id']])).toEqual([
        ['user_prompt', undefined], ['tool_decision', 'toolu_early'], ['tool_result', 'toolu_early'], ['api_request', undefined], ['assistant_response', undefined],
        ['tool_decision', 'toolu_later'], ['tool_result', 'toolu_later'],
      ])
      for (const r of rows) expect(r.attributes['prompt.id']).toBe(rows[0]!.attributes['prompt.id'])
      // The prompt row is timed as the call began, though the call was still running as the turn began: nothing of the turn's before it.
      expect(rows[0]!.attributes['event.timestamp']).toBe(new Date(START).toISOString())
      expect(rows[1]!.attributes['event.timestamp']).toBe(new Date(START).toISOString())
      const all = spans(w.posts)
      const interaction = all.find(x => x.name === 'claude_code.interaction')!
      const tool = all.find(x => x.name === 'claude_code.tool' && x.attrs['tool_use_id'] === 'toolu_early')!
      expect([tool.traceId, tool.parentSpanId]).toEqual([interaction.traceId, interaction.spanId])
      // The interaction's span starts no later than the call it holds; its duration stays the turn's.
      const startOf = (x: unknown) => BigInt((x as { startTimeUnixNano: string }).startTimeUnixNano)
      expect(startOf(interaction)).toBe(startOf(tool))
      expect(interaction.attrs['interaction.duration_ms']).toBe(10)
    })
  }

  test("calls held for a first turn that never comes have their rows as the session ends, with no prompt", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', messages: handedOver(true), transcript: CUT_OFF })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'echo hi', description: 'x', tool_use_id: 'toolu_early' } as never)
    await w.clock.advance(5_000)
    expect(w.built().filter(r => r.attributes['tool_use_id'] === 'toolu_early')).toEqual([])
    await end($)
    const rows = w.built().filter(r => r.attributes['tool_use_id'] === 'toolu_early')
    expect(rows.map(r => [r.attributes['event.name'], r.attributes['prompt.id']])).toEqual([['tool_decision', undefined], ['tool_result', undefined]])
    expect(spans(w.posts).filter(x => x.name === 'claude_code.tool' && x.attrs['tool_use_id'] === 'toolu_early').length).toBe(1)
  })

  test("a call before the first turn keeps what its permission check said: an ask answered, with its wait; an ask refused, nobody there to ask", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', messages: [...handedOver(true), CALLED('toolu_ask'), ANSWERED('toolu_ask'), CALLED('toolu_no'), ANSWERED('toolu_no', 'refused')], transcript: CUT_OFF })
    await start($)
    await w.clock.advance(1_000)
    // The check and the run happen inside the call, before the plugin knows whether it builds the rows.
    await $.tool.call({ tool: 'Bash', command: 'touch /asked', description: 'x', tool_use_id: 'toolu_ask' } as never)
    await $.tool.call({ tool: 'Bash', command: 'touch /outside', description: 'x', tool_use_id: 'toolu_no' } as never)
    await w.clock.advance(200)
    await turn($, '', 'toolu_c')
    await w.clock.advance(5_000)
    await end($)
    const of = (id: string) => w.built().filter(r => r.attributes['tool_use_id'] === id).map(r => r.attributes)
    const [decision, result] = of('toolu_ask')
    expect(decision).toEqual(expect.objectContaining({ 'event.name': 'tool_decision', decision: 'accept', source: 'config', 'event.timestamp': new Date(START + 1_000 + ANSWER_MS).toISOString() }))
    expect(result).toEqual(expect.objectContaining({ 'event.name': 'tool_result', success: 'true', duration_ms: '25' }))
    expect(of('toolu_no').map(r => [r['event.name'], r['decision'], r['source']])).toEqual([['tool_decision', 'reject', 'config']])
    const blocked = spans(w.posts).filter(s => s.name === 'claude_code.tool.blocked_on_user')
    expect(blocked.map(s => [s.attrs['decision'], s.attrs['duration_ms']])).toEqual(expect.arrayContaining([['accept', ANSWER_MS]]))
    const prompt = w.built().find(r => r.attributes['event.name'] === 'user_prompt')!
    for (const id of ['toolu_ask', 'toolu_no']) for (const r of of(id)) expect(r['prompt.id']).toBe(prompt.attributes['prompt.id'])
  })

  test("a later load's first turn begun with no text never takes the person's message a past handover carried over: no call ran before it", keyless, async ($, on) => {
    let messages: unknown[] = [...handedOver(true), FINAL]
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: () => messages, transcript: `${CUT_OFF}${ANSWER_ROW('done')}` })
    await start($)
    await $.turn.start({ turnId: 't1', text: '' } as never)
    // The new message reaches the transcript only after the turn began.
    messages = [...messages, { role: 'user', text: REMINDER + 'now the logs', toolUses: [] }]
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 8, effort: 'medium' } as never)
    while (!(await stream.next()).done) {
      // Read to its end.
    }
    await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 200, isAborted: false, reason: 'answer' } as never)
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([['12', 'now the logs']])
  })

  test("outside Cowork, a call before the load's first turn is not held for it", keyless, async ($, on) => {
    let done = false
    const w = world(on, { accountFile: ACCOUNT_FILE, messages: () => handedOver(done) })
    await earlyCallThenTurn($, w, () => (done = true))
    expect(w.built().filter(r => r.attributes['tool_use_id'] === 'toolu_early')).toEqual([])
  })

  // Cowork hands a conversation begun in chat over to Claude Code with the chat's last call not run: that call gets a result saying
  // so, the model's "No response requested.", the handover's system row, and the host's own message asking to run the call again,
  // which the host marks as not typed (`textNotTyped`).
  const CONTINUE = "Continue with the task described in the conversation above. Your most recent Bash call has not run yet; nothing is wrong with the tool or its input. Run it now from the beginning with the tools you have, without assuming any result, file or state from it, and use the working directory and file locations you have now rather than ones earlier steps assumed.\n\nThe user's timezone is America/New_York (UTC-05:00)."
  const NOT_RUN_TEXT = 'NOT RUN: this tool call has not run yet: no command ran, and nothing changed.'
  const NOT_RUN = (id: string) => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: NOT_RUN_TEXT, isError: true }] })
  const NO_RESPONSE = { role: 'assistant', text: 'No response requested.', toolUses: [] }
  const HOST = { role: 'user', text: CONTINUE, toolUses: [] }
  const handover = [EARLIER, FINAL, { role: 'user', text: REMINDER + typed, toolUses: [] }, SAID, CALLED('toolu_a'), ANSWERED('toolu_a'), CALLED('toolu_b'), NOT_RUN('toolu_b'), NO_RESPONSE, HOST]
  const CHAT = `${PERSON_ROW()}${CALL_ROW('toolu_a')}${RESULT_ROW('toolu_a', 'a.txt')}${CALL_ROW('toolu_b')}${RESULT_ROW('toolu_b', NOT_RUN_TEXT)}${ANSWER_ROW('No response requested.')}`
  const MARKED = `${CHAT}${MARKER}${QUEUED}${HOST_ROW(CONTINUE)}`
  // The handover's row, but none of the host's fields on its message (a host that writes none).
  const BARE = `${CHAT}${MARKER}${QUEUED}${HOST_ROW(CONTINUE, { origin: { kind: 'human' } })}`
  const UNMARKED = `${CHAT}${HOST_ROW(CONTINUE, {})}`

  const HOW_IT_STARTS: [string, (w: ReturnType<typeof world>, $: Engine) => Promise<void>][] = [
    ['the turn begins with it', async (_w, $) => turn($, CONTINUE, 'toolu_c')],
    ['the turn begins with no text, it submitted while idle', async (_w, $) => {
      await $.prompt.submit({ text: CONTINUE, wait: false, origin: { kind: 'composer' } } as never)
    }],
  ]
  for (const [how, begin] of HOW_IT_STARTS) {
    for (const [marked, transcript] of [["by the host's fields", MARKED], ['by its words, without them', BARE]] as const) {
      test(`a turn Cowork hands over from chat takes the person's prompt, not the host's message asking to run the last call (${how}; known ${marked})`, keyless, async ($, on) => {
        const w = world(on, {
          accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: handover, transcript, turns: { [CONTINUE]: () => turn($, '', 'toolu_c') },
        })
        await start($)
        await begin(w, $)
        await w.clock.advance(5_000)
        await end($)
        expect(promptsOf(w)).toEqual([[String(typed.length), typed]])
        const rows = w.built()
        const prompt = rows.find(r => r.attributes['event.name'] === 'user_prompt')!
        // The turn's own prompt id: the host's message's, which Claude Code is on.
        expect(prompt.attributes['prompt.id']).toBe('prompt-host')
        expect(rows.find(r => r.attributes['event.name'] === 'api_request')!.attributes['prompt.id']).toBe('prompt-host')
        const interactions = spans(w.posts).filter(x => x.name === 'claude_code.interaction')
        expect(interactions.map(x => [x.attrs['user_prompt_length'], x.attrs['user_prompt']])).toEqual([[typed.length, typed]])
      })
    }
  }

  test("by the host's fields, its message is known whatever its words, and the person's is the transcript's though the messages show no not-run result", keyless, async ($, on) => {
    const words = 'Pick up where the conversation above left off.'
    const w = world(on, {
      accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: [{ role: 'user', text: REMINDER + typed, toolUses: [] }, NO_RESPONSE, { role: 'user', text: words, toolUses: [] }],
      transcript: `${PERSON_ROW()}${ANSWER_ROW('No response requested.')}${MARKER}${HOST_ROW(words)}`,
    })
    await start($)
    await turn($, words, 'toolu_c')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([[String(typed.length), typed]])
  })

  test("by the host's fields, where the transcript's end no longer holds the person's message, it is read back through the messages", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: handover, transcript: `${MARKER}${QUEUED}${HOST_ROW(CONTINUE)}` })
    await start($)
    await turn($, CONTINUE, 'toolu_c')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([[String(typed.length), typed]])
  })

  test("a handover whose turn holds no message of the person's builds no prompt row: the host's message is never taken for one", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: [CALLED('toolu_b'), NOT_RUN('toolu_b'), NO_RESPONSE, HOST], transcript: `${MARKER}${QUEUED}${HOST_ROW(CONTINUE)}` })
    await start($)
    await turn($, CONTINUE, 'toolu_c')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([])
    expect(w.built().filter(r => r.attributes['event.name'] === 'api_request').length).toBe(1)
  })

  const NOT_A_HANDOVER: [string, World, string?][] = [
    ['no handover row at the transcript\'s end', { entrypoint: 'remote_cowork', messages: handover, transcript: UNMARKED }],
    ['no transcript to read', { entrypoint: 'remote_cowork', messages: handover }],
    ['no host fields, and no not-run result before it', { entrypoint: 'remote_cowork', messages: [...handover.slice(0, 7), ANSWERED('toolu_b'), NO_RESPONSE, HOST], transcript: BARE }],
    ['outside Cowork', { messages: handover, transcript: MARKED }],
    // The person typed a new prompt, not in the transcript yet: the host's row is not this turn's.
    ["the host's newest row is not the turn's text", { entrypoint: 'remote_cowork', messages: handover, transcript: MARKED }, 'run the deploy again'],
  ]
  for (const [what, opts, text] of NOT_A_HANDOVER) {
    test(`the turn's text stays its prompt where nothing shows a handover: ${what}`, keyless, async ($, on) => {
      const w = world(on, { accountFile: ACCOUNT_FILE, store: { dataPoints: { 'prompt.text': 'on' } }, ...opts })
      await start($)
      await turn($, text ?? CONTINUE, 'toolu_c')
      await w.clock.advance(5_000)
      expect(promptsOf(w)).toEqual([[String((text ?? CONTINUE).length), text ?? CONTINUE]])
    })
  }

  test("a later turn's message of the host's shape is the turn's: only the load's first turn is a handover", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } }, messages: handover, transcript: MARKED })
    await start($)
    await turn($, 'go', 'toolu_1')
    await turn($, CONTINUE, 'toolu_2')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([['2', 'go'], [String(CONTINUE.length), CONTINUE]])
  })

  test("the handover: the host's message, the walk back past it to the person's prompt", () => {
    expect(hostContinue(CONTINUE)).toBe(true)
    expect(hostContinue(REMINDER + CONTINUE)).toBe(true)
    expect(hostContinue(CONTINUE.replace('Bash', 'mcp__files__read_file'))).toBe(true)
    expect(hostContinue(`please ${CONTINUE}`)).toBe(false)
    expect(hostContinue('Continue with the task described in the conversation above.')).toBe(false)
    expect(hostContinue(typed)).toBe(false)
    const walk = (ms: unknown[], host?: string) => handoffPrompt(ms as never, host)
    expect(walk(handover)).toBe(REMINDER + typed)
    // Past a notice Claude Code queued after the host's message; without the model's message between.
    expect(walk([...handover, NOTICE])).toBe(REMINDER + typed)
    expect(walk([...handover.slice(0, 8), HOST])).toBe(REMINDER + typed)
    // A handed-over turn with no prompt of the person's: '', not the host's message, and not an earlier turn's.
    expect(walk([CALLED('toolu_b'), NOT_RUN('toolu_b'), NO_RESPONSE, HOST])).toBe('')
    expect(walk([EARLIER, CALLED('toolu_a'), ANSWERED('toolu_a'), FINAL, { role: 'user', text: '[Request interrupted by user]', toolUses: [] }, CALLED('toolu_b'), NOT_RUN('toolu_b'), NO_RESPONSE, HOST])).toBe('')
    // Not a handover by its words: the host's message is not last, no not-run result, or the model's message made a call.
    expect(walk(handover.slice(0, -1))).toBeUndefined()
    expect(walk([...handover.slice(0, 7), ANSWERED('toolu_b'), NO_RESPONSE, HOST])).toBeUndefined()
    expect(walk([...handover.slice(0, 8), CALLED('toolu_x'), HOST])).toBeUndefined()
    expect(walk([...handover.slice(0, -1), { role: 'user', text: typed, toolUses: [] }])).toBeUndefined()
    expect(walk([])).toBeUndefined()
    // Marked by the host's fields: its message is the turn's text, whatever its words, and no not-run result is needed.
    expect(walk([...handover.slice(0, 7), ANSWERED('toolu_b'), NO_RESPONSE, HOST], CONTINUE)).toBe(REMINDER + typed)
    expect(walk([{ role: 'user', text: REMINDER + typed, toolUses: [] }, NO_RESPONSE, { role: 'user', text: 'carry on', toolUses: [] }], 'carry on')).toBe(REMINDER + typed)
    expect(walk(handover, 'some other text')).toBeUndefined()
  })

  test("the handover in the transcript's rows: the handover's row, the host's message, the person's message carried over", () => {
    expect(handoverIn(MARKED)).toEqual({ relay: true, hostWritten: true, carried: false, handedOff: false, newest: CONTINUE, person: REMINDER + typed })
    expect(handoverIn(BARE)).toEqual({ relay: true, hostWritten: false, carried: false, handedOff: false, newest: CONTINUE, person: REMINDER + typed })
    expect(handoverIn(UNMARKED)).toEqual({ relay: false, hostWritten: false, carried: false, handedOff: false, newest: CONTINUE })
    expect(handoverIn(CUT_OFF)).toEqual({ relay: true, hostWritten: false, carried: true, handedOff: true, newest: REMINDER + typed, person: REMINDER + typed })
    // The person's message carried over, then a newer one typed after the handover: no longer the turn's.
    expect(handoverIn(CUT_OFF_BARE)).toMatchObject({ carried: true, handedOff: false, person: REMINDER + typed })
    expect(handoverIn(`${CUT_OFF}${HOST_ROW('deploy it', {})}`)).toMatchObject({ carried: false, handedOff: false, newest: 'deploy it' })
    // A host-written row from before the handover's row is not this handover's.
    expect(handoverIn(`${CHAT}${HOST_ROW(CONTINUE)}${MARKER}`)).toMatchObject({ relay: true, hostWritten: false })
    // Not prompts: a tool's results, a message Claude Code inserted, a meta row, an empty message.
    const inserted = `${line({ type: 'user', message: { role: 'user', content: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>' } })}${line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /skills/docx' } })}${line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: REMINDER }] } })}`
    expect(handoverIn(`${MARKED}${RESULT_ROW('toolu_c', 'done')}${inserted}`)).toEqual(handoverIn(MARKED))
    // Cut where the read began, the first line is no row; the words alone, in another row's text, are not the handover's row.
    expect(handoverIn(MARKED.slice(MARKED.indexOf(MARKER) + 10)).relay).toBe(false)
    expect(handoverIn(line({ type: 'user', message: { role: 'user', content: 'what is "upgrade_relay_marker"?' } })).relay).toBe(false)
    expect(handoverIn('')).toEqual({ relay: false, hostWritten: false, carried: false, handedOff: false })
  })

  test("a Cowork prompt's own text goes without the reminder, its length the text's, and its row filled", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', store: { dataPoints: { 'prompt.text': 'on' } } })
    await start($)
    await turn($, REMINDER + typed)
    await turn($, 'again')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([[String(typed.length), typed], ['5', 'again']])
  })

  test("outside Cowork the prompt is the turn's as it came, and only the load's first turn reads the transcript", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, store: { dataPoints: { 'prompt.text': 'on' } }, messages: [{ role: 'user', text: typed, toolUses: [] }] })
    await start($)
    await turn($, REMINDER + typed, 'toolu_1')
    // A later turn with no text (a continuation) reads nothing: no prompt row.
    await turn($, '', 'toolu_2')
    await w.clock.advance(5_000)
    expect(promptsOf(w)).toEqual([[String((REMINDER + typed).length), REMINDER + typed]])
  })

  const COWORK_ENVS: [string, World][] = [
    ['the entry point remote_cowork', { entrypoint: 'remote_cowork' }],
    ['CLAUDE_CODE_IS_COWORK', { entrypoint: 'sdk-ts', env: { CLAUDE_CODE_IS_COWORK: 'true' } }],
  ]
  for (const [how, env] of COWORK_ENVS) {
    test(`a Cowork session (${how}) goes as Cowork's: service cowork and surface remote on the resource, the surface and the remote session on each row`, keyless, async ($, on) => {
      const w = world(on, { accountFile: ACCOUNT_FILE, ...env, env: { ...env.env, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_0123abcd', CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1' } })
      await start($)
      await turn($)
      await w.clock.advance(5_000)
      await end($)
      const rows = w.built()
      expect(rows.length).toBe(5)
      for (const r of rows) {
        expect(r.resource['service.name']).toBe('cowork')
        expect(r.resource['cowork.surface']).toBe('remote')
        expect(r.resource['service.version']).toBe('2.1.328')
        expect(r.attributes['cowork.surface']).toBe('remote')
        expect(r.attributes['ccr.session.id']).toBe('cse_0123abcd')
        expect(contractViolations(r.attributes)).toEqual([])
      }
      // Claude Code's rows start with the host's resource attributes, then the session.
      expect(Object.keys(rows[0]!.attributes).slice(0, 4)).toEqual(['cowork.surface', 'user.id', 'session.id', 'ccr.session.id'])
      // The spans and metrics take the rows' head, and the same resource.
      const traces = w.posts.filter(p => p.url === `${PROD}/v1/traces`).flatMap(p => JSON.parse(p.body).resourceSpans as { resource: { attributes: { key: string; value: { stringValue: string } }[] } }[])
      expect(traces.length).toBeGreaterThan(0)
      for (const rs of traces) expect(Object.fromEntries(rs.resource.attributes.map(a => [a.key, a.value.stringValue]))).toEqual(expect.objectContaining({ 'service.name': 'cowork', 'cowork.surface': 'remote' }))
      const built = spans(w.posts)
      expect(built.length).toBeGreaterThan(0)
      for (const x of built) expect(x.attrs['cowork.surface']).toBe('remote')
      const usage = points(w.posts).filter(p => p.name === 'claude_code.cost.usage')
      expect(usage.length).toBeGreaterThan(0)
      for (const p of usage) expect(p.attrs['cowork.surface']).toBe('remote')
    })
  }

  test('a Claude Code session: service claude-code, and no surface or remote session', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, env: { CLAUDE_CODE_IS_COWORK: '0' } })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    const rows = w.built()
    expect(rows.length).toBe(5)
    for (const r of rows) {
      expect(r.resource['service.name']).toBe('claude-code')
      expect(r.resource['cowork.surface']).toBeUndefined()
      expect(r.attributes['cowork.surface']).toBeUndefined()
      expect(r.attributes['ccr.session.id']).toBeUndefined()
    }
  })

  test("the variables Cowork's host sets still win: its service name and surface", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', env: { OTEL_SERVICE_NAME: 'cowork-desktop', OTEL_RESOURCE_ATTRIBUTES: 'cowork.surface=local' } })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    const rows = w.built()
    expect(rows.length).toBe(5)
    for (const r of rows) {
      expect(r.resource['service.name']).toBe('cowork-desktop')
      expect(r.resource['cowork.surface']).toBe('local')
      expect(r.attributes['cowork.surface']).toBe('local')
    }
  })

  test("the resource's host.arch is the machine's, as the SDK's host detector names it, where Claude Code says what the machine is", keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', machine: 'x86_64' })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    // Claude Code before 2.1.328 (the floor among them) has no `$.session.machine()`: the resource goes without it.
    expect(w.built().map(r => r.resource['host.arch'])).toEqual(Array(5).fill(w.machineThere() ? 'amd64' : undefined))
  })
})

describe('rowless.ts', () => {
  test("the messages Claude Code inserts are not the person's; a settings layer's allow rules", () => {
    expect(insertedText('<task-notification>\n<task-id>b1</task-id>')).toBe(true)
    expect(insertedText("<system-reminder>The user's timezone is UTC.</system-reminder>\n<local-command-stdout>ok</local-command-stdout>")).toBe(true)
    expect(insertedText('This session is being continued from a previous conversation that ran out of context.')).toBe(true)
    expect(insertedText("<system-reminder>The user's timezone is UTC.</system-reminder>\nplease check")).toBe(false)
    expect(insertedText('a < b, check it')).toBe(false)
    expect(permissionRules({ permissions: { allow: ['Bash(touch:*)', 3], deny: ['Read'] } })).toEqual(['Bash(touch:*)'])
    expect(permissionRules({ permissions: {} })).toEqual([])
    expect(permissionRules(undefined)).toEqual([])
  })

  test("Cowork's reminders ahead of what the person typed are dropped; anything else is kept", () => {
    const reminder = "<system-reminder>The user's timezone is UTC.</system-reminder>"
    expect(typedText(`${reminder}\nhello`)).toBe('hello')
    // A message of text blocks, as the transcript joins them: with nothing between.
    expect(typedText(`${reminder}hello`)).toBe('hello')
    expect(typedText(`${reminder}\n${reminder}\n\nhello`)).toBe('hello')
    expect(typedText(`hello ${reminder}`)).toBe(`hello ${reminder}`)
    expect(typedText('hello')).toBe('hello')
    expect(typedText(reminder)).toBe('')
  })

  test('a decision: who settled it and when, from the check, the classifier, the run and the answer saved', () => {
    const base = { startMs: 100, endMs: 900, denied: false, isError: false }
    const ask = (approver?: string) => ({ decision: 'ask', atMs: 110, ...(approver !== undefined ? { approver } : {}) })
    // The check alone: allowed as it began to run, refused as it refused.
    expect(decisionOf({ ...base, verdict: { decision: 'allow', rule: 'Bash(ls:*)', atMs: 110 }, ranAtMs: 120 })).toEqual({ refused: false, source: 'config', atMs: 120 })
    expect(decisionOf({ ...base, verdict: { decision: 'allow', hook: 'PreToolUse', atMs: 110 }, ranAtMs: 120 })).toEqual({ refused: false, source: 'hook', atMs: 120 })
    expect(decisionOf({ ...base, verdict: { decision: 'deny', atMs: 110 }, isError: true })).toEqual({ refused: true, source: 'config', atMs: 110 })
    // An ask, answered: the person's or the host's, saved or not; the classifier's; Claude Code's own where nobody could be asked.
    expect(decisionOf({ ...base, verdict: ask('person'), ranAtMs: 700 })).toEqual({ refused: false, source: 'user_temporary', atMs: 700 })
    expect(decisionOf({ ...base, verdict: ask('person'), ranAtMs: 700, permanent: true })).toEqual({ refused: false, source: 'user_permanent', atMs: 700 })
    expect(decisionOf({ ...base, verdict: ask('host'), ranAtMs: 700 })).toEqual({ refused: false, source: 'user_temporary', atMs: 700 })
    expect(decisionOf({ ...base, verdict: ask('person'), judged: 'allow', ranAtMs: 300 })).toEqual({ refused: false, source: 'config', atMs: 300 })
    expect(decisionOf({ ...base, verdict: ask(), ranAtMs: 700 })).toEqual({ refused: false, source: 'config', atMs: 700 })
    // An ask refused, as the call ended: the person's no, their interruption, the host's no, the classifier's, nobody to ask, a hook.
    const no = (text: string, approver?: string, judged?: string) => decisionOf({ ...base, verdict: ask(approver), isError: true, text, ...(judged !== undefined ? { judged } : {}) })
    expect(no("The user doesn't want to proceed with this tool use.", 'person')).toEqual({ refused: true, source: 'user_reject', atMs: 900 })
    expect(no("The user doesn't want to take this action right now. STOP", 'person')).toEqual({ refused: true, source: 'user_abort', atMs: 900 })
    expect(no('Refused by the host', 'host')).toEqual({ refused: true, source: 'user_reject', atMs: 900 })
    expect(no('Blocked by auto mode', 'person', 'deny')).toEqual({ refused: true, source: 'config', atMs: 900 })
    expect(no('Permission to use Bash has been denied. IMPORTANT: ...')).toEqual({ refused: true, source: 'config', atMs: 900 })
    expect(no('not now')).toEqual({ refused: true, source: 'config', atMs: 900 })
    // A settings hook that refused a person's ask can't be told from another refusal: no source.
    expect(no('not now', 'person')).toEqual({ refused: true, atMs: 900 })
    // An ask that never ran and did not fail; a call no check saw, denied by a hook or not.
    expect(decisionOf({ ...base, verdict: ask('person') })).toEqual({ refused: false, atMs: 100 })
    expect(decisionOf({ ...base, denied: true })).toEqual({ refused: true, atMs: 900 })
    expect(decisionOf({ ...base, ranAtMs: 150 })).toEqual({ refused: false, atMs: 150 })
  })

  test("a repository's attributes from its origin remote, as Claude Code derives them", () => {
    const of = (remote: string | null | undefined) => repoAttributes(remote)
    expect(of('git@github.com:Acme/API.git')).toEqual({ 'vcs.repository.url.full': 'https://github.com/acme/api', 'vcs.owner.name': 'acme', 'vcs.repository.name': 'api', 'vcs.provider.name': 'github' })
    expect(Object.keys(of('git@github.com:acme/api.git'))).toEqual(['vcs.repository.url.full', 'vcs.owner.name', 'vcs.repository.name', 'vcs.provider.name'])
    expect(of('https://user:secret@gitlab.com/group/sub/tool.git')).toEqual({ 'vcs.repository.url.full': 'https://gitlab.com/group/sub/tool', 'vcs.owner.name': 'group/sub', 'vcs.repository.name': 'tool', 'vcs.provider.name': 'gitlab' })
    expect(of('ssh://git@ssh.github.com:443/acme/api.git')['vcs.repository.url.full']).toBe('https://github.com/acme/api')
    expect(of('git@altssh.bitbucket.org:team/app.git')).toEqual({ 'vcs.repository.url.full': 'https://bitbucket.org/team/app', 'vcs.owner.name': 'team', 'vcs.repository.name': 'app', 'vcs.provider.name': 'bitbucket' })
    expect(of('https://gitea.com/o/r')['vcs.provider.name']).toBe('gitea')
    expect(of('https://git.example.com/o/r.git')).toEqual({ 'vcs.repository.url.full': 'https://git.example.com/o/r', 'vcs.owner.name': 'o', 'vcs.repository.name': 'r' })
    // Bitbucket Server: an `scm/` path, or SSH on port 7999.
    const server = { 'vcs.repository.url.full': 'https://git.example.com/projects/proj/repos/repo', 'vcs.owner.name': 'proj', 'vcs.repository.name': 'repo', 'vcs.provider.name': 'bitbucket' }
    expect(of('https://git.example.com/scm/proj/repo.git')).toEqual(server)
    expect(of('ssh://git@git.example.com:7999/proj/repo.git')).toEqual(server)
    // A remote session's git proxy on a loopback address.
    expect(repoAttributes('http://proxy@127.0.0.1:41234/git/acme/api', { remoteSession: true })['vcs.repository.url.full']).toBe('https://github.com/acme/api')
    expect(repoAttributes('http://proxy@127.0.0.1:41234/git/git.example.com/o/r', { remoteSession: true })['vcs.repository.url.full']).toBe('https://git.example.com/o/r')
    // Outside a remote session, a loopback address is the remote's own.
    expect(of('http://proxy@127.0.0.1:41234/git/acme/api')['vcs.provider.name']).toBeUndefined()
    // A known provider's host with `www.`.
    expect(of('https://www.github.com/acme/api')).toEqual(of('https://github.com/acme/api'))
    // Not a repository's address on the web, or credentials after a query: nothing.
    for (const bad of ['/srv/repos/x.git', 'file:///srv/x.git', 'https://git.example.com/o/r?token=a@b', 'https://git.example.com/', '', null, undefined]) expect(of(bad)).toEqual({})
  })

  test("the head names the repository after the session, the resource's own where it names an address", () => {
    const repo = repoAttributes('git@github.com:acme/api.git')
    const head = rowHead({}, { 'organization.id': ORG, 'user.email': EMAIL }, 's-1', undefined, repo)
    expect(Object.keys(head)).toEqual(['session.id', 'vcs.repository.url.full', 'vcs.owner.name', 'vcs.repository.name', 'vcs.provider.name', 'organization.id', 'user.email'])
    const resource = { 'vcs.repository.url.full': 'https://git.example.com/a/b', 'deployment.environment': 'ci' }
    const fromResource = rowHead(resource, {}, 's-1', undefined, repo)
    expect(fromResource).toEqual({ ...resource, 'session.id': 's-1' })
    expect(Object.keys(fromResource)).toEqual(['vcs.repository.url.full', 'deployment.environment', 'session.id'])
  })

  test('HEAD from a git folder: a branch by its loose ref or packed-refs, in a worktree its common folder; a detached commit; none unreadable', async () => {
    const sha = 'a'.repeat(40)
    const reader = (files: Record<string, string>) => async (path: string) => {
      if (files[path] === undefined) throw new Error(`no ${path}`)
      return files[path]!
    }
    expect(await headOf('/r/.git', reader({ '/r/.git/HEAD': 'ref: refs/heads/main\n', '/r/.git/refs/heads/main': `${sha}\n` }))).toEqual({ commitId: sha, branch: 'main' })
    expect(await headOf('/r/.git', reader({ '/r/.git/HEAD': 'ref: refs/heads/fix/x\n', '/r/.git/packed-refs': `# pack-refs\n${'b'.repeat(40)} refs/heads/main\n${sha} refs/heads/fix/x\n` }))).toEqual({ commitId: sha, branch: 'fix/x' })
    const worktree = { '/r/.git/worktrees/w/HEAD': 'ref: refs/heads/w\n', '/r/.git/worktrees/w/commondir': '../..\n', '/r/.git/refs/heads/w': sha }
    expect(await headOf('/r/.git/worktrees/w', reader(worktree))).toEqual({ commitId: sha, branch: 'w' })
    expect(await headOf('/r/.git', reader({ '/r/.git/HEAD': `${sha}\n` }))).toEqual({ commitId: sha })
    expect(await headOf('/r/.git', reader({ '/r/.git/HEAD': 'ref: refs/heads/gone\n' }))).toBeUndefined()
    await expect(headOf('/r/.git', reader({}))).rejects.toThrow()
    expect(joinPath('/r/.git/worktrees/w', '../..')).toBe('/r/.git')
    expect(joinPath('/r/app', '/elsewhere/.git/worktrees/x')).toBe('/elsewhere/.git/worktrees/x')
    expect(madeCommit(['aaaaaaa'], { commitId: sha, branch: 'main' })).toEqual({ commitId: sha, branch: 'main' })
    expect(madeCommit(['bbbbbbb'], { commitId: sha })).toBeUndefined()
    expect(madeCommit([], { commitId: sha })).toBeUndefined()
  })

  test("a result's duration is its run's, from when it began to run; its commit after its sizes", () => {
    const s = newRowless()
    const r = resultRow(s, {}, { tool: 'Bash', id: 't', startMs: 0, runStartMs: 2_000, endMs: 2_025, isError: false, commit: { commitId: 'c'.repeat(40) } }).attributes
    expect(r['duration_ms']).toBe('25')
    expect(r['vcs.ref.head.revision']).toBe('c'.repeat(40))
    expect(r['vcs.ref.head.name']).toBeUndefined()
    expect(r['vcs.ref.head.type']).toBeUndefined()
  })

  test("the prompt row's id is Claude Code's where the session says it, of an id's shape", () => {
    expect(promptIdFrom({ transcriptPath: '', sysname: 'Darwin', promptId: 'prompt-from-claude-1' })).toBe('prompt-from-claude-1')
    expect(promptIdFrom({ promptId: 'has space' })).toBeUndefined()
    expect(promptIdFrom({})).toBeUndefined()
    expect(promptIdFrom(null)).toBeUndefined()
  })

  test("a response row's text is the step's own answer: a retry's doubled pieces never; the stream's join where it reads the same", () => {
    expect(responseTextOf('ok', 'okok')).toBe('ok')
    expect(responseTextOf('Let me check.\nok', 'Let me check.\nok')).toBe('Let me check.\nok')
    expect(responseTextOf('Let me check.ok', 'Let me check.\nok')).toBe('Let me check.\nok')
    expect(responseTextOf('', 'ok')).toBeUndefined()
    expect(responseTextOf('  \n', undefined)).toBeUndefined()
    expect(responseTextOf('ok', undefined)).toBe('ok')
  })

  test("Claude Code's texts of a refusal: the person's no, and the person's interruption; not a tool's own failure", () => {
    expect(refusalKind("The user doesn't want to proceed with this tool use. The tool use was rejected.")).toBe('reject')
    expect(refusalKind("The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.")).toBe('abort')
    expect(refusalKind('Error: Exit code 1')).toBeUndefined()
    expect(refusalKind(undefined)).toBeUndefined()
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
    // A verdict that names nothing behind it is the mode's or the session's own: Claude Code names it `config`.
    expect(decisionSource({ decision: 'allow' })).toBe('config')
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

  test("in Cowork the head starts with its surface, unless the resource names one, and names the remote session after the session", () => {
    const host = { provider: 'firstParty', customBaseUrl: false, nonInteractive: true, cowork: true, remoteSessionId: 'cse_1' }
    expect(rowHead({}, { 'organization.id': ORG, 'user.email': EMAIL }, 's-1', host)).toEqual({
      'cowork.surface': 'remote', 'session.id': 's-1', 'ccr.session.id': 'cse_1', 'organization.id': ORG, 'user.email': EMAIL, 'anthropic.provider': 'firstParty', 'terminal.type': 'non-interactive',
    })
    expect(rowHead({ 'cowork.surface': 'local' }, {}, 's-1', host)['cowork.surface']).toBe('local')
    expect(rowHead({}, {}, 's-1', { ...host, cowork: false, remoteSessionId: undefined })).toEqual({ 'session.id': 's-1', 'anthropic.provider': 'firstParty', 'terminal.type': 'non-interactive' })
    expect(remoteSessionIdOf(' cse_01ABC ')).toBe('cse_01ABC')
    expect(remoteSessionIdOf('a b')).toBeUndefined()
    expect(remoteSessionIdOf(undefined)).toBeUndefined()
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

describe('the client a remote Cowork prompt was sent from', () => {
  const CLIENT = 'mainwave.cowork.client_platform'
  const line = (row: Record<string, unknown>) => `${JSON.stringify({ sessionId: 's-1', timestamp: '2026-11-19T21:50:00.000Z', ...row })}\n`
  // A prompt's row as Cowork's host writes it, and the rows that follow it in its turn: a call, its result, the text Claude Code adds.
  const PROMPT_ROW = (promptId: string, fields: Record<string, unknown> = {}) => line({
    type: 'user', promptId, uuid: `u-${promptId}`, message: { role: 'user', content: [{ type: 'text', text: 'please check the deploy' }] },
    permissionMode: 'auto', origin: { kind: 'human' }, promptSource: 'sdk', turnOrigin: 'human', turnPromptId: promptId, ...fields,
  })
  const TURN_ROWS = (promptId: string) => `${line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } })}${
    line({ type: 'user', promptId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }] }, clientPlatform: 'ios' })}${
    line({ type: 'user', promptId, isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'a skill body' }] }, clientPlatform: 'ios' })}`
  const clientsOf = (rows: readonly { attributes: Record<string, unknown> }[]) => rows.map(r => [r.attributes['event.name'], r.attributes[CLIENT]])

  test('each built row of a turn carries the client its prompt was sent from, and a conversation that moves between clients changes it', keyless, async ($, on) => {
    let transcript = PROMPT_ROW('p-1', { clientPlatform: 'desktop_app' })
    let promptId = 'p-1'
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', transcript: () => transcript, promptId: () => promptId })
    await start($)
    await turn($, 'please check the deploy')
    transcript += `${TURN_ROWS('p-1')}${PROMPT_ROW('p-2', { clientPlatform: 'web_claude_ai' })}`
    promptId = 'p-2'
    await turn($, 'please check the deploy', 'toolu_2')
    await w.clock.advance(5_000)
    const rows = w.built()
    expect(rows.length).toBe(10)
    for (const r of rows) {
      expect(r.attributes[CLIENT]).toBe(r.attributes['prompt.id'] === 'p-1' ? 'desktop_app' : 'web_claude_ai')
      expect(contractViolations(r.attributes)).toEqual([])
    }
    expect(rows.filter(r => r.attributes['prompt.id'] === 'p-2').length).toBe(5)
  })

  test("a prompt carried over from chat at a handover names no client: its turn's rows carry none, and the next prompt's do", keyless, async ($, on) => {
    // The person's message from chat, under no prompt of this session's, and the host's row that marks the handover.
    let transcript = `${line({ type: 'user', handedOff: true, origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'please check the deploy' }] } })}${
      line({ type: 'system', subtype: 'upgrade_relay_marker', content: '{}' })}`
    let promptId = 'p-1'
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', transcript: () => transcript, promptId: () => promptId, messages: [{ role: 'user', text: 'please check the deploy', toolUses: [] }] })
    await start($)
    await turn($, '')
    transcript += PROMPT_ROW('p-2', { clientPlatform: 'ios' })
    promptId = 'p-2'
    await turn($, 'next', 'toolu_2')
    await w.clock.advance(5_000)
    const rows = w.built()
    expect(rows.filter(r => r.attributes['prompt.id'] === 'p-1').map(r => r.attributes[CLIENT])).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(rows.filter(r => r.attributes['prompt.id'] === 'p-2').map(r => r.attributes[CLIENT])).toEqual(['ios', 'ios', 'ios', 'ios', 'ios'])
  })

  test('the host\'s own prompt at a handover carries the client it names', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', transcript: PROMPT_ROW('prompt-host', { textNotTyped: true, clientPlatform: 'desktop_app' }) })
    await start($)
    await turn($, 'Continue with the task described in the conversation above.')
    await w.clock.advance(5_000)
    expect(new Set(w.built().map(r => r.attributes[CLIENT]))).toEqual(new Set(['desktop_app']))
  })

  test('a client name not of its shape, or none, is left off', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', transcript: PROMPT_ROW('prompt-host', { clientPlatform: 'Desktop App <script>' }) })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    expect(w.built().length).toBe(5)
    for (const r of w.built()) expect(r.attributes[CLIENT]).toBeUndefined()
  })

  for (const [entrypoint, env] of [['cli', {}], ['local-agent', { CLAUDE_CODE_IS_COWORK: '1' }], ['remote_cowork_trigger', {}]] as const) {
    test(`outside remote Cowork (${entrypoint}), the transcript's client is not read`, keyless, async ($, on) => {
      const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint, env, transcript: PROMPT_ROW('prompt-host', { clientPlatform: 'claude_code_cli' }) })
      await start($)
      await turn($)
      await w.clock.advance(5_000)
      expect(w.built().length).toBe(5)
      for (const r of w.built()) expect(r.attributes[CLIENT]).toBeUndefined()
    })
  }

  test('a prompt whose row is far back in the transcript, the turn well under way, is found further back', keyless, async ($, on) => {
    // The load's first turn began before the plugin's hooks were in place: its prompt is read at its first model request, past a large result.
    const big = line({ type: 'user', promptId: 'prompt-host', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'x'.repeat(300_000) }] } })
    const w = world(on, {
      accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', transcript: `${PROMPT_ROW('prompt-host', { clientPlatform: 'ios' })}${big}`,
      messages: [{ role: 'user', text: 'please check the deploy', toolUses: [] }, { role: 'assistant', text: '', toolUses: [{ id: 'toolu_0' }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_0' }] }],
    })
    await start($)
    await turn($, '')
    await w.clock.advance(5_000)
    expect(clientsOf(w.built())).toEqual(expect.arrayContaining([['user_prompt', 'ios'], ['api_request', 'ios']]))
    for (const r of w.built()) expect(r.attributes[CLIENT]).toBe('ios')
  })

  test('a prompt whose own row is longer than the first read is found further back', keyless, async ($, on) => {
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', transcript: PROMPT_ROW('prompt-host', { clientPlatform: 'ios', pasted: 'x'.repeat(100_000) }) })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    expect(w.built().length).toBe(5)
    for (const r of w.built()) expect(r.attributes[CLIENT]).toBe('ios')
  })

  test('a transcript read that fails leaves the stamp off and holds nothing; the next row of the prompt reads again', keyless, async ($, on) => {
    // Every look at the file as the turn begins fails (the handover's among them); the looks after it don't.
    let w: ReturnType<typeof world> | undefined
    const transcript = () => {
      if (w === undefined || w.clock.now() === START) throw new Error('EIO in test')
      return PROMPT_ROW('prompt-host', { clientPlatform: 'desktop_app' })
    }
    w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', transcript })
    await start($)
    await turn($)
    await w.clock.advance(5_000)
    expect(clientsOf(w.built())).toEqual([['user_prompt', undefined], ['api_request', 'desktop_app'], ['assistant_response', 'desktop_app'], ['tool_decision', 'desktop_app'], ['tool_result', 'desktop_app']])
  })

  test("Claude Code's own rows carry it too, on the exporter's row and the copy; a prompt's row logged before its transcript row is read again", keyless, async ($, on) => {
    let transcript = ''
    const w = world(on, { accountFile: ACCOUNT_FILE, entrypoint: 'remote_cowork', transcript: () => transcript, promptId: 'p-1' })
    await start($)
    const row = (event: string, extra: Record<string, unknown> = {}) =>
      $.telemetry.log({ to: 'collector', event, loggedAt: LOGGED_AT, attributes: { 'organization.id': ORG, 'user.email': EMAIL, 'session.id': 's-1', 'event.name': event, 'prompt.id': 'p-1', ...extra } } as never)
    await row('user_prompt', { prompt_length: '5' })
    transcript = PROMPT_ROW('p-1', { clientPlatform: 'web_claude_ai' })
    await row('api_request', { model: 'claude-haiku-5-5' })
    await $.telemetry.log({ to: 'collector', event: 'plugin_loaded', loggedAt: LOGGED_AT, attributes: { 'organization.id': ORG, 'user.email': EMAIL, 'session.id': 's-1', 'event.name': 'plugin_loaded', [CLIENT]: 'forged' } } as never)
    await w.clock.advance(5_000)
    expect(clientsOf(w.rig.rows)).toEqual([['user_prompt', undefined], ['api_request', 'web_claude_ai'], ['plugin_loaded', undefined]])
    expect(clientsOf(w.logs().filter(r => r.attributes['mainwave.telemetry.route'] === 'plugin'))).toEqual(expect.arrayContaining([['user_prompt', undefined], ['api_request', 'web_claude_ai'], ['plugin_loaded', undefined]]))
    for (const r of w.rig.rows) expect(contractViolations(r.attributes)).toEqual([])
  })
})

describe("the request ID on the rows built from events", () => {
  /** A transcript row of the model's response: one block, under the request it came from. */
  const answerRow = (uuid: string, requestId: string | undefined, block: Record<string, unknown> = { type: 'text', text: 'ok' }) =>
    JSON.stringify({ type: 'assistant', uuid, ...(requestId !== undefined ? { requestId } : {}), message: { id: `msg_${uuid}`, role: 'assistant', content: [block] } })
  const PROMPT_ROW = JSON.stringify({ type: 'user', uuid: 'u-0', message: { role: 'user', content: 'go' } })
  const SUB_TRANSCRIPT = '/home/dev/.claude/projects/-work-app/s-1/subagents/agent-a1.jsonl'

  type TranscribedOpts = {
    lagMs?: number; never?: boolean; transcript?: boolean; unwritten?: boolean; store?: Record<string, unknown>
    /** Lines written in the step before its response rows, at once. */
    before?: readonly string[]
    /** Lines written after its response rows, each this long after the step's response. */
    after?: readonly { line: string; delayMs: number }[]
    /** The response rows are written half at first (a write under way), whole `halfMs` later. */
    halfMs?: number
  }

  /** The session's transcript as its lines stand, and the response rows the engine keeps in each step, written there `lagMs` later. */
  function transcribed(on: On, $: Engine, blocks: (step: { turnId: string; index: number; agentId?: string }) => readonly [uuid: string, requestId: string | undefined][], opts: TranscribedOpts = {}) {
    const lines: { line: string; atMs: number; wholeAtMs?: number; agentId?: string }[] = opts.unwritten ? [] : [{ line: PROMPT_ROW, atMs: 0 }]
    // With `unwritten`, no file until its first line is written, as a new session's transcript. A line written half is cut in its middle.
    const file = (agentId: string | undefined) => () => {
      const now = w.clock.now()
      const text = lines.filter(l => l.agentId === agentId && l.atMs <= now).map(l => (l.wholeAtMs !== undefined && now < l.wholeAtMs ? l.line.slice(0, l.line.length >> 1) : `${l.line}\n`)).join('')
      if (text === '' && opts.unwritten) throw new Error('no such file in test')
      return text
    }
    const w = world(on, {
      accountFile: ACCOUNT_FILE,
      ...(opts.store !== undefined ? { store: opts.store } : {}),
      ...(opts.transcript === false ? {} : { transcript: file(undefined), live: { [SUB_TRANSCRIPT]: file('a1') } }),
      duringStep: async step => {
        const agent = step.agentId !== undefined ? { agentId: step.agentId } : {}
        for (const line of opts.before ?? []) lines.push({ line, atMs: w.clock.now(), ...agent })
        for (const [uuid, requestId] of blocks(step)) {
          await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, door: 'response', origin: { kind: 'model', model: 'claude-haiku-5-5' }, uuid, ...agent } as never)
          const atMs = w.clock.now() + (opts.lagMs ?? 150)
          if (!opts.never) lines.push({ line: answerRow(uuid, requestId), atMs, ...(opts.halfMs !== undefined ? { wholeAtMs: atMs + opts.halfMs } : {}), ...agent })
        }
        for (const a of opts.after ?? []) lines.push({ line: a.line, atMs: w.clock.now() + a.delayMs, ...agent })
      },
    })
    return w
  }

  /** Waits for `run` while the clock moves on a tenth of a second at a time, as the engine's does. */
  async function ticking(w: ReturnType<typeof world>, run: Promise<unknown>, ms = 5_000) {
    let done = false
    const settled = run.finally(() => (done = true))
    for (let t = 0; t < ms && !done; t += 100) await w.clock.advance(100)
    await settled
  }

  /** A main-loop turn of `steps` model requests and no call; the step returns without the clock moving past it. */
  async function requests($: Engine, w: ReturnType<typeof world>, turnId: string, steps = 1, text = 'go') {
    await $.turn.start({ turnId, text } as never)
    for (let index = 0; index < steps; index++) {
      await ticking(w, (async () => {
        const stream = $.turn.step({ turnId, index, model: 'claude-haiku-5-5', messageCount: 1 } as never)
        while (!(await stream.next()).done) {
          // Read to its end, as the engine does.
        }
      })())
    }
    await ticking(w, $.turn.complete({ turnId, answer: 'ok', durationMs: 200, isAborted: false, reason: 'answer' } as never))
  }

  const ids = (w: ReturnType<typeof world>, event: string) => w.built().filter(r => r.attributes['event.name'] === event).map(r => r.attributes['request_id'])
  const spanIds = (w: ReturnType<typeof world>) => spans(w.posts).filter(s => s.name === 'claude_code.llm_request').map(s => [s.attrs['request_id'], s.attrs['gen_ai.response.id']])

  test("a request's rows and its span carry Claude Code's request ID: the transcript's, on the row of its response's last block", keyless, async ($, on) => {
    const w = transcribed(on, $, () => [['u-1', 'req_011A'], ['u-2', 'req_011A']])
    await start($)
    await requests($, w, 't1')
    await w.clock.advance(5_000)
    await end($)
    expect(ids(w, 'api_request')).toEqual(['req_011A'])
    expect(ids(w, 'assistant_response')).toEqual(['req_011A'])
    expect(spanIds(w)).toEqual([['req_011A', 'req_011A']])
    for (const r of w.built()) expect(contractViolations(r.attributes)).toEqual([])
  })

  test('the request goes on as it ends: its rows wait beside it for the transcript, which Claude Code writes a moment later, and the turn ends after them', keyless, async ($, on) => {
    const w = transcribed(on, $, () => [['u-1', 'req_011A']], { lagMs: 450 })
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1 } as never)
    // Read to its end with the clock moved only by the step itself: a step that waited on the clock would never end.
    let steps = 0
    const read = (async () => {
      while (!(await stream.next()).done) steps++
    })()
    await w.clock.advance(100)
    await read
    const endedAt = w.clock.now()
    await ticking(w, $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 200, isAborted: false, reason: 'answer' } as never))
    expect(w.clock.now()).toBeGreaterThanOrEqual(endedAt + 300)
    await w.clock.advance(5_000)
    await end($)
    expect(ids(w, 'api_request')).toEqual(['req_011A'])
    expect(spanIds(w)).toEqual([['req_011A', 'req_011A']])
    // The span sits in the turn's interaction, which closed after it.
    const sent = spans(w.posts)
    expect(sent.find(s => s.name === 'claude_code.llm_request')!.parentSpanId).toBe(sent.find(s => s.name === 'claude_code.interaction')!.spanId)
  })

  test("a new session's first request, begun before its transcript is written at all, takes the transcript's ID too", keyless, async ($, on) => {
    const w = transcribed(on, $, () => [['u-1', 'req_011A']], { unwritten: true })
    await start($)
    await requests($, w, 't1')
    await w.clock.advance(5_000)
    expect(ids(w, 'api_request')).toEqual(['req_011A'])
  })

  test("a request Claude Code retried after part of a response: the rows take the ID of the last block's request, the one that answered", keyless, async ($, on) => {
    const w = transcribed(on, $, () => [['u-1', 'req_011First'], ['u-2', 'req_011Retry']])
    await start($)
    await requests($, w, 't1')
    await w.clock.advance(5_000)
    expect(ids(w, 'api_request')).toEqual(['req_011Retry'])
  })

  test("a subagent's request takes its ID from the subagent's own transcript", keyless, async ($, on) => {
    const w = transcribed(on, $, step => [[`u-${step.agentId ?? 'main'}`, step.agentId === undefined ? 'req_011Main' : 'req_011Sub']])
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.turn.start({ turnId: 't2', text: 'sub', agentId: 'a1' } as never)
    await ticking(w, (async () => {
      const stream = $.turn.step({ turnId: 't2', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' } as never)
      while (!(await stream.next()).done) {
        // Read to its end.
      }
    })())
    await ticking(w, $.turn.complete({ turnId: 't2', answer: 'ok', durationMs: 200, isAborted: false, reason: 'answer', agentId: 'a1' } as never))
    await w.clock.advance(5_000)
    const req = w.built().find(r => r.attributes['event.name'] === 'api_request')!.attributes
    expect([req['agent_id'], req['request_id']]).toEqual(['a1', 'req_011Sub'])
  })

  test('where the transcript never gets the row, the rows go after the last read with the ID that stands for the request, and the turn ends then', keyless, async ($, on) => {
    const w = transcribed(on, $, () => [['u-1', 'req_011A']], { never: true })
    await start($)
    const before = w.clock.now()
    await requests($, w, 't1')
    expect(w.clock.now() - before).toBeLessThanOrEqual(REQUEST_ID_TRIES * TRANSCRIPT_RETRY_MS + 1_000)
    await w.clock.advance(5_000)
    await end($)
    expect(ids(w, 'api_request')).toEqual(['step_t1_0'])
    expect(ids(w, 'assistant_response')).toEqual(['step_t1_0'])
    expect(spanIds(w)).toEqual([['step_t1_0', 'step_t1_0']])
  })

  test('with no transcript, or no row of the response seen kept, the rows go at once, with the ID that stands for each request', keyless, async ($, on) => {
    const w = transcribed(on, $, step => (step.index === 0 ? [['u-1', 'req_011A']] : []), { transcript: false })
    await start($)
    await requests($, w, 't1', 2)
    await w.clock.advance(5_000)
    await end($)
    expect(ids(w, 'api_request')).toEqual(['step_t1_0', 'step_t1_1'])
    expect(spanIds(w).map(([id]) => id).sort()).toEqual(['step_t1_0', 'step_t1_1'])
  })

  test('an ID the transcript gives two requests goes on the first alone: the second carries the ID that stands for it', keyless, async ($, on) => {
    const w = transcribed(on, $, step => [[`u-${step.turnId}-${step.index}`, 'req_011Same']])
    await start($)
    await requests($, w, 't1')
    await requests($, w, 't2', 1, 'again')
    await w.clock.advance(5_000)
    expect(ids(w, 'api_request')).toEqual(['req_011Same', 'step_t2_0'])
  })

  test("a turn's second request, its ID not looked for, goes after the first's, which waits for the transcript: in order", keyless, async ($, on) => {
    const w = transcribed(on, $, step => (step.index === 0 ? [['u-1', 'req_011A']] : []), { lagMs: 450 })
    await start($)
    await requests($, w, 't1', 2)
    await w.clock.advance(5_000)
    expect(ids(w, 'api_request')).toEqual(['req_011A', 'step_t1_1'])
    expect(w.built().filter(r => r.attributes['event.name'] === 'api_request').map(r => r.attributes['event.sequence'])).toEqual(
      [...w.built().filter(r => r.attributes['event.name'] === 'api_request').map(r => r.attributes['event.sequence'])].sort((a, b) => Number(a) - Number(b)),
    )
  })

  test('with response.text on, a response row that waits for its ID still carries its text, once', keyless, async ($, on) => {
    const w = transcribed(on, $, () => [['u-1', 'req_011A']], { lagMs: 450, store: { dataPoints: { 'response.text': 'on' } } })
    await start($)
    await requests($, w, 't1')
    await w.clock.advance(5_000)
    const responses = w.built().filter(r => r.attributes['event.name'] === 'assistant_response').map(r => [r.attributes['response'], r.attributes['request_id']])
    expect(responses).toEqual([['ok', 'req_011A']])
  })

  test('the row is found past what the transcript gained since the request began, read in order: a large row after it, a half-written line, characters of several bytes', keyless, async ($, on) => {
    const big = JSON.stringify({ type: 'user', uuid: 'u-big', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(5 * 1024 * 1024) }] } })
    const w = transcribed(on, $, () => [['u-1', 'req_011A']], {
      before: [JSON.stringify({ type: 'user', uuid: 'u-mb', message: { role: 'user', content: 'héllo ✓ 日本語 🙂' } })],
      // Half there at the second read, whole at the third, with a row of more than one read's length written right after it.
      halfMs: 100,
      after: [{ line: big, delayMs: 260 }],
    })
    await start($)
    await requests($, w, 't1')
    await w.clock.advance(5_000)
    expect(ids(w, 'api_request')).toEqual(['req_011A'])
  })

  test("a subagent's request still waiting as the session ends: its rows go at once, after one more read, with the ID that stands for it", keyless, async ($, on) => {
    const w = transcribed(on, $, () => [['u-1', 'req_011A']], { never: true })
    await start($)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    await $.turn.start({ turnId: 't2', text: 'sub', agentId: 'a1' } as never)
    await ticking(w, (async () => {
      const stream = $.turn.step({ turnId: 't2', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' } as never)
      while (!(await stream.next()).done) {
        // Read to its end.
      }
    })())
    const before = w.clock.now()
    await ticking(w, end($))
    expect(w.clock.now() - before).toBeLessThanOrEqual(3 * TRANSCRIPT_RETRY_MS)
    expect(ids(w, 'api_request')).toEqual(['step_t2_0'])
  })

  test("the request ID in a transcript's lines: the row's own, where it is the model's and names one", () => {
    const text = [PROMPT_ROW, answerRow('u-1', 'req_011A'), answerRow('u-2', undefined), JSON.stringify({ type: 'assistant', uuid: 'u-3', requestId: 'req_011C', isApiErrorMessage: true }), answerRow('u-4', 'not an id!'), '{"cut'].join('\n')
    expect(requestIdIn(text, 'u-1')).toBe('req_011A')
    expect(requestIdIn(text, 'u-2')).toBeUndefined()
    expect(requestIdIn(text, 'u-3')).toBeUndefined()
    expect(requestIdIn(text, 'u-4')).toBeUndefined()
    expect(requestIdIn(text, 'u-0')).toBeUndefined()
    expect(requestIdIn(text, 'u-9')).toBeNull()
    // A row that names the uuid in its text alone is not that row.
    expect(requestIdIn(JSON.stringify({ type: 'assistant', uuid: 'u-5', requestId: 'req_011E', message: { content: 'see u-1' } }), 'u-1')).toBeNull()
  })

  test('the ID that stands for a request, and where a subagent writes its transcript', () => {
    expect(stepRequestId('t1', 0)).toBe('step_t1_0')
    expect(stepRequestId('t1', 0)).not.toMatch(/^req_/)
    expect(agentTranscriptPath('/p/s-1.jsonl', 'a1')).toBe('/p/s-1/subagents/agent-a1.jsonl')
    expect(agentTranscriptPath('/p/s-1.jsonl', '../x')).toBeUndefined()
    expect(agentTranscriptPath('/p/s-1', 'a1')).toBeUndefined()
  })
})
