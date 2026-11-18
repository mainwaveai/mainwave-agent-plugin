// End to end: the redaction packs, as a Cowork session runs with personal data in its prompt, its shell command, the command's output,
// the model's answer and an API error. The packs reach the plugin as an organization sets them today (the redactionPacks option in its
// managed settings), as its data collection settings will (kept in the plugin's store), and as a person adds them (their own user
// settings). Every request the plugin makes is read back whole.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { boot, EMAIL, itemAttributes, keylessAnswer, LOGGED_AT, memoryStore, network, ORG, packsOption, type Layers, type Post } from './rig.ts'

const keyless = { options: {} }
const START = 1_800_000_000_000
const COMMON = { 'organization.id': ORG, 'user.email': EMAIL, 'user.id': 'device-1', 'session.id': 's-1', 'anthropic.provider': 'firstParty', 'cowork.surface': 'desktop' }
const USAGE = { input_tokens: 1201, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const DEVICE_BASH = 'mcp__remote-devices__device_bash'

// The personal data in the session, one of each kind, none of it the session's own identity.
const MAIL = 'ana.lee@example.com'
const AUTHOR = 'bob@example.com'
const PHONE = '(415) 555-2671'
const SSN = '078-05-1120'
const CARD = '4111 1111 1111 1111'
const PROMPT = `Email ${MAIL} the refund for card ${CARD}`
const COMMAND = `git log --author=${AUTHOR}`
const OUTPUT = `commit 1a2b3c by ${AUTHOR}, SSN ${SSN} in fixtures`
const ANSWER = `Done. Call ${PHONE} if it fails.`
const API_ERROR = `quota exceeded for ${AUTHOR}`
const ALL = ['pii.contact', 'pii.us_gov_id', 'pii.payment_card']
const PERSONAL = [MAIL, AUTHOR, PHONE, SSN, CARD, '4111111111111111']

function world(on: On, layers: Layers = {}, store: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  mock.clock(on, { now: START })
  const kept = memoryStore(on, store)
  const posts = network(on)
  const rig = boot(on, { entrypoint: 'remote_cowork', layers, env })
  const logs: string[] = []
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('ui.log', (_$, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('turn.start', (_$, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', () => ({ text: 'ok' }) as never)
  on('prompt.submit', (_$, e) => ({ text: (e as { text: string }).text }) as never)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: ANSWER } as never
    yield { kind: 'stop', stopReason: 'end_turn', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
    return { turnId: e.turnId, index: e.index, answer: ANSWER, toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, model: 'claude-haiku-5-5' } } as never
  })
  on('tool.call', () => ({ result: [{ type: 'text', text: OUTPUT }] }) as never)
  return { posts, rig, logs, store: kept }
}

async function row($: Engine, event: string, attributes: Record<string, unknown>) {
  await $.telemetry.log({ to: 'collector', event, loggedAt: LOGGED_AT, attributes: { ...COMMON, 'event.name': event, 'event.sequence': 1, ...attributes } } as never)
}

/** One Cowork turn: a prompt, a request that fails once, a device_bash call, and the turn's end. */
async function turn($: Engine) {
  await $.prompt.submit({ text: PROMPT } as never)
  await row($, 'user_prompt', { prompt: '<REDACTED>', prompt_text: '<REDACTED>', prompt_length: String(PROMPT.length) })
  await $.turn.start({ turnId: 't1', text: PROMPT } as never)
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1 } as never)
  while (!(await stream.next()).done) {
    // Read to its end, as the engine does.
  }
  await row($, 'api_error', { model: 'claude-haiku-5-5', error: API_ERROR, status_code: '429', attempt: 1, duration_ms: 5, request_id: 'req_0' })
  await row($, 'api_request', { model: 'claude-haiku-5-5', input_tokens: 1201, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.25, duration_ms: 10, ttft_ms: 4, request_id: 'req_1', query_source: 'sdk' })
  await row($, 'assistant_response', { response: '<REDACTED>', response_length: ANSWER.length, request_id: 'req_1' })
  await $.tool.call({ tool: DEVICE_BASH, command: COMMAND, description: 'History', tool_use_id: 'toolu_1' } as never)
  await row($, 'tool_decision', { decision: 'accept', source: 'config', tool_name: 'mcp_tool', tool_use_id: 'toolu_1' })
  await row($, 'tool_result', { tool_name: 'mcp_tool', tool_use_id: 'toolu_1', success: 'true', tool_input_size_bytes: '60' })
  await $.turn.complete({ turnId: 't1', answer: ANSWER, durationMs: 40, isAborted: false, reason: 'answer' } as never)
}

async function session($: Engine, on: On, layers: Layers = {}, store: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const w = world(on, layers, store, env)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
  await turn($)
  await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
  return w
}

const kvs = (l: { key: string; value: Record<string, unknown> }[] = []) => Object.fromEntries(l.map(a => [a.key, Object.values(a.value)[0]]))
const bodies = (posts: readonly Post[], path: string) => posts.filter(p => p.url.endsWith(path)).map(p => JSON.parse(p.body))
const rowsOf = (posts: readonly Post[]) => bodies(posts, '/v1/logs').flatMap(b => b.resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords))).map((r: any) => kvs(r.attributes))
const spansOf = (posts: readonly Post[]) => bodies(posts, '/v1/traces').flatMap(b => b.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans))).map((s: any) => ({ name: s.name as string, attrs: kvs(s.attributes), events: (s.events ?? []).map((e: any) => kvs(e.attributes)), status: s.status }))
const rowOf = (posts: readonly Post[], event: string) => rowsOf(posts).find(r => r['event.name'] === event)!
const spanOf = (posts: readonly Post[], name: string) => spansOf(posts).find(s => s.name === name)!
const sent = (posts: readonly Post[]) => posts.map(p => p.body).join('\n')

describe('with no choice of packs', () => {
  test('secrets alone: personal data in content goes as it is', keyless, async ($, on) => {
    const { posts } = await session($, on)
    expect(rowOf(posts, 'user_prompt')['prompt']).toBe(PROMPT)
    expect(sent(posts)).toContain(AUTHOR)
    expect(sent(posts)).not.toContain('[REDACTED:pii.')
  })
})

describe("the organization's packs, in its managed settings", () => {
  test('every content and identifier value of the copy is redacted: prompt, answer, command, tool input and output, errors', keyless, async ($, on) => {
    const { posts } = await session($, on, { policy: packsOption(ALL) })
    for (const p of PERSONAL) expect([p, sent(posts).includes(p)]).toEqual([p, false])
    expect(rowOf(posts, 'user_prompt')['prompt']).toBe('Email [REDACTED:pii.contact.email] the refund for card [REDACTED:pii.payment_card.card_number]')
    expect(rowOf(posts, 'user_prompt')['mainwave.redaction.count']).toBe(4)
    expect(rowOf(posts, 'assistant_response')['response']).toBe('Done. Call [REDACTED:pii.contact.phone_nanp] if it fails.')
    expect(rowOf(posts, 'api_error')['error']).toBe('quota exceeded for [REDACTED:pii.contact.email]')
    expect(JSON.parse(rowOf(posts, 'tool_result')['tool_parameters'] as string)['full_command']).toBe('git log --author=[REDACTED:pii.contact.email]')
    expect(JSON.parse(rowOf(posts, 'tool_result')['tool_input'] as string)['command']).toBe('git log --author=[REDACTED:pii.contact.email]')
    expect(spanOf(posts, 'claude_code.interaction').attrs['user_prompt']).toBe('Email [REDACTED:pii.contact.email] the refund for card [REDACTED:pii.payment_card.card_number]')
    const tool = spanOf(posts, 'claude_code.tool')
    expect(tool.attrs['full_command']).toBe('git log --author=[REDACTED:pii.contact.email]')
    expect(tool.events).toEqual([{ output: 'commit 1a2b3c by [REDACTED:pii.contact.email], SSN [REDACTED:pii.us_gov_id.ssn] in fixtures' }])
    expect(tool.attrs['mainwave.redaction.count']).toBe(3)
  })

  test("the session's identity is untouched on every record, and keyless ingest takes every request", keyless, async ($, on) => {
    const { posts } = await session($, on, { policy: packsOption(ALL) })
    expect(posts.length).toBeGreaterThan(0)
    for (const post of posts) expect(keylessAnswer(post).status).toBe(200)
    for (const attrs of posts.flatMap(itemAttributes)) {
      const a = kvs(attrs)
      expect([a['organization.id'], a['user.email']]).toEqual([ORG, EMAIL])
    }
  })

  test("the exporter's rows to the organization's collector go on as Claude Code wrote them", keyless, async ($, on) => {
    const { rig } = await session($, on, { policy: packsOption(ALL) })
    expect(rig.rows.find(r => r.event === 'api_error')!.attributes['error']).toBe(API_ERROR)
  })

  test("the resource's values are scanned too, but for the keys Mainwave routes and joins on", keyless, async ($, on) => {
    const env = { OTEL_RESOURCE_ATTRIBUTES: `team.owner=lead@example.com,department=eng,user.email=${EMAIL}` }
    const { posts } = await session($, on, { policy: packsOption(ALL) }, {}, env)
    const resources = bodies(posts, '/v1/logs').flatMap(b => b.resourceLogs.map((r: any) => kvs(r.resource.attributes)))
    expect(resources.length).toBeGreaterThan(0)
    for (const r of resources) {
      expect(r['team.owner']).toBe('[REDACTED:pii.contact.email]')
      expect(r['department']).toBe('eng')
      expect(r['user.email']).toBe(EMAIL)
      expect(r['service.name']).toBe('claude-code')
    }
  })

  test('under any of the plugin ids, as a string', keyless, async ($, on) => {
    const { posts } = await session($, on, { policy: packsOption('pii.contact', 'mainwave') })
    expect(rowOf(posts, 'user_prompt')['prompt']).toBe(`Email [REDACTED:pii.contact.email] the refund for card ${CARD}`)
  })

  test("a person can add packs, and can't turn off a pack the organization turned on", keyless, async ($, on) => {
    const { posts } = await session($, on, { policy: packsOption(['pii.contact']), user: packsOption(['secrets', 'pii.payment_card']) })
    expect(rowOf(posts, 'user_prompt')['prompt']).toBe('Email [REDACTED:pii.contact.email] the refund for card [REDACTED:pii.payment_card.card_number]')
  })

  test('naming a pack this plugin does not have holds every content and identifier value back; the records go, and the debug log says why', keyless, async ($, on) => {
    const { posts, logs } = await session($, on, { policy: packsOption(['pii.contact', 'pii.passport']) })
    for (const p of PERSONAL) expect([p, sent(posts).includes(p)]).toEqual([p, false])
    const prompt = rowOf(posts, 'user_prompt')
    expect(prompt['prompt']).toBeUndefined()
    expect(prompt['prompt_length']).toBe(String(PROMPT.length))
    expect(rowOf(posts, 'api_error')['status_code']).toBe('429')
    // The output event goes, without its output.
    expect(spanOf(posts, 'claude_code.tool').events).toEqual([{}])
    expect(logs.join('\n')).toContain("name a pack this plugin does not have")
    expect(logs.join('\n')).not.toContain('pii.passport')
  })

  test("managed settings that can't be read hold content back too", keyless, async ($, on) => {
    const { posts } = await session($, on, { policy: 'reject' })
    expect(rowOf(posts, 'user_prompt')['prompt']).toBeUndefined()
    expect(sent(posts)).not.toContain(AUTHOR)
  })

  test('set after records were queued: they go redacted, as the packs are read again before each send', keyless, async ($, on) => {
    const layers: Layers = {}
    const { posts } = world(on, layers)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($)
    layers.policy = packsOption(['pii.contact'])
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(sent(posts)).not.toContain(AUTHOR)
    expect(rowOf(posts, 'user_prompt')['prompt']).toBe(`Email [REDACTED:pii.contact.email] the refund for card ${CARD}`)
  })
})

describe('a person who adds packs in their own user settings', () => {
  test('gets them on top of the default', keyless, async ($, on) => {
    const { posts } = await session($, on, { user: packsOption('pii.payment_card') })
    expect(rowOf(posts, 'user_prompt')['prompt']).toBe(`Email ${MAIL} the refund for card [REDACTED:pii.payment_card.card_number]`)
  })

  test("a repository's settings, the local project's and --settings add none", keyless, async ($, on) => {
    const opt = packsOption(ALL)
    const { posts } = await session($, on, { project: opt, local: opt, flag: opt, undefined: opt } as Layers)
    expect(rowOf(posts, 'user_prompt')['prompt']).toBe(PROMPT)
  })
})

describe("the organization's data collection settings, kept in the plugin's store", () => {
  test('their packs apply through the same gate input, with those of its managed settings', keyless, async ($, on) => {
    const { posts } = await session($, on, { policy: packsOption(['pii.payment_card']) }, { redactionPacks: ['pii.contact'] })
    expect(rowOf(posts, 'user_prompt')['prompt']).toBe('Email [REDACTED:pii.contact.email] the refund for card [REDACTED:pii.payment_card.card_number]')
  })

  test('written mid-session, they apply to records already queued: the store is read again before each send', keyless, async ($, on) => {
    const { posts, store } = world(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await turn($)
    store.data.set('redactionPacks', 'pii.contact')
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(sent(posts)).not.toContain(AUTHOR)
  })

  test('a value of the wrong type holds content back', keyless, async ($, on) => {
    const { posts } = await session($, on, {}, { redactionPacks: { 'pii.contact': true } })
    expect(rowOf(posts, 'user_prompt')['prompt']).toBeUndefined()
  })
})
