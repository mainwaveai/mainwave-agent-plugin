// The organization's data collection settings, from Mainwave: asked for once the rows name the organization and email, applied to what
// is sent, kept in the store for later sessions, asked for again every few minutes, and left as they were when the request fails. The
// network beneath is rig.ts's: the collector answers as keyless ingest does, and the settings API as each test says.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { nextWait, REFRESH_MS, RETRY_MS, settingsOf, settingsUrlOf } from '../hooks/orgsettings.ts'
import { boot, EMAIL, keyOption, keylessAnswer, LOGGED_AT, memoryStore, network, optInOption, ORG, packsOption, SETTINGS_URL, type Layers, type Post, type Reply } from './rig.ts'

const keyless = { options: {} }
const START = 1_800_000_000_000
const TICK = 5_000
const ORG_B = '0f8fad5b-d9cb-469f-a165-70867728950e'
const EMAIL_B = 'other@example.org'
const COMMON = { 'organization.id': ORG, 'user.email': EMAIL, 'user.account_uuid': '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'user.id': 'device-1', 'session.id': 's-1' }
const MAIL = 'ana.lee@example.com'
const SSN = '078-05-1120'

/** Mainwave's answer, as its settings API gives it. */
const answer = (dataPoints: Record<string, string>, packs: string[] = ['secrets'], revision = 3): Reply => ({
  status: 200,
  text: JSON.stringify({
    revision, catalog_version: 1, data_points: dataPoints, in_force: { 'tool.call': 'on', ...dataPoints },
    redaction_packs: packs, default_data_points: ['tool.call'], redaction_packs_default: false,
  }),
})

function world(on: On, opts: { settings?: (n: number, post: Post) => Reply; store?: Record<string, unknown>; layers?: Layers; env?: Record<string, string>; down?: () => boolean } = {}) {
  const clock = mock.clock(on, { now: START })
  const store = memoryStore(on, opts.store)
  const posts = network(on, (_n, post) => {
    if (opts.down?.()) return { status: 503 }
    const a = keylessAnswer(post)
    return { status: a.status, text: a.text }
  }, undefined, opts.settings)
  const rig = boot(on, { entrypoint: 'cli', layers: opts.layers, env: opts.env })
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  return { clock, store, posts, rig, logs }
}

let seq = 0
async function row($: Engine, event: string, attributes: Record<string, unknown>, common: Record<string, unknown> = COMMON) {
  seq += 1
  await $.telemetry.log({ to: 'collector', event, loggedAt: LOGGED_AT, attributes: { ...common, 'event.name': event, 'event.sequence': seq, ...attributes } } as never)
}
const prompt = ($: Engine, text: string, common?: Record<string, unknown>) => row($, 'user_prompt', { prompt: text, prompt_length: String(text.length) }, common)
const decision = ($: Engine) => row($, 'tool_decision', { decision: 'accept', source: 'config', tool_name: 'Bash', tool_use_id: 'toolu_1' })
const response = ($: Engine, text: string) => row($, 'assistant_response', { response: text })

type Attrs = Record<string, unknown>
const kvs = (l: { key: string; value: Record<string, unknown> }[] = []): Attrs => Object.fromEntries(l.map(a => [a.key, Object.values(a.value)[0]]))
const rowsOf = (posts: readonly Post[]): Attrs[] =>
  posts.filter(p => p.url.endsWith('/v1/logs')).flatMap(p => JSON.parse(p.body).resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords))).map((r: any) => kvs(r.attributes))
const sent = (posts: readonly Post[], event: string) => rowsOf(posts).filter(r => r['event.name'] === event)

describe('asking Mainwave', () => {
  test('once the rows name the organization and email: a POST of the two, and nothing else', keyless, async ($, on) => {
    const { clock, posts } = world(on)
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    expect(posts.settings.length).toBe(1)
    const [ask] = posts.settings
    expect(ask!.url).toBe(SETTINGS_URL)
    expect(ask!.method).toBe('POST')
    expect(Object.keys(ask!.headers).map(h => h.toLowerCase())).toEqual(['content-type'])
    expect(JSON.parse(ask!.body)).toEqual({ claude_org_id: ORG, email: EMAIL })
  })

  test('again as a session starts, once the organization and email are known', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({}) })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(1)
    expect(posts.settings.length).toBe(0)
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
    await clock.advance(1)
    expect(posts.settings.length).toBe(2)
  })

  test('the debug line at session end says where the settings came from, never the email', keyless, async ($, on) => {
    const { clock, logs } = world(on, { settings: () => answer({}, ['secrets'], 7) })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(logs.join('')).toContain('data collection settings: from Mainwave, revision 7; last request: ok')
    expect(logs.join('')).not.toContain(EMAIL)
  })

  test('no more once a repository stops the copy', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({}), layers: { project: keyOption('mw_dev_example_key_0001') } })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(TICK)
    await clock.advance(2 * REFRESH_MS)
    expect(posts.settings.length).toBeLessThanOrEqual(1)
  })

  test('a session whose rows name no email asks nothing', keyless, async ($, on) => {
    const { clock, posts } = world(on)
    await row($, 'api_request', { cost_usd: 0.1 }, { 'organization.id': ORG, 'session.id': 's-1' })
    await row($, 'api_request', { cost_usd: 0.1 }, { 'session.id': 's-1' })
    await clock.advance(REFRESH_MS + TICK)
    expect(posts.settings).toEqual([])
  })

  test('again every few minutes, within the five the settings page promises, while the session runs', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({}) })
    expect(REFRESH_MS).toBeLessThanOrEqual(5 * 60_000)
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await clock.advance(REFRESH_MS - 1_000)
    expect(posts.settings.length).toBe(1)
    await clock.advance(1_000)
    expect(posts.settings.length).toBe(2)
    await clock.advance(2 * REFRESH_MS)
    expect(posts.settings.length).toBe(4)
  })

  for (const [status, text] of [[403, '{"error":"not accepted","reason":"unclaimed"}'], [403, '{"error":"not accepted","reason":"email_domain"}'], [404, '{"detail":"Not Found"}'], [422, '{}'], [429, '{"error":"rate_limited"}']] as const) {
    test(`a ${status} ${text.includes('reason') ? JSON.parse(text).reason + ' ' : ''}is quiet: nothing written, the session goes on, asked again a refresh later`, keyless, async ($, on) => {
      const { clock, posts, store, rig } = world(on, { settings: () => ({ status, text }) })
      await row($, 'api_request', { cost_usd: 0.1 })
      await clock.advance(1)
      await prompt($, 'go')
      await clock.advance(RETRY_MS * 2)
      expect(posts.settings.length).toBe(1)
      await clock.advance(REFRESH_MS)
      expect(posts.settings.length).toBe(2)
      expect(rig.rows.length).toBe(2)
      expect(store.sets.filter(s => !s.key.startsWith('outbox:'))).toEqual([])
    })
  }

  test('a failure that can pass (no network, a 5xx, a timeout) is tried again sooner, the wait doubling up to the refresh', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: n => (n === 1 ? 'reject' : n === 2 ? { status: 503 } : n === 3 ? 'hang' : answer({})) })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    expect(posts.settings.length).toBe(1)
    await clock.advance(RETRY_MS)
    expect(posts.settings.length).toBe(2)
    await clock.advance(2 * RETRY_MS)
    expect(posts.settings.length).toBe(3)
    // The third hangs: answered as a timeout, then 4 * RETRY_MS on.
    await clock.advance(5_000 + 4 * RETRY_MS)
    expect(posts.settings.length).toBe(4)
  })

  test('the waits', () => {
    expect(nextWait('ok', 0)).toBe(REFRESH_MS)
    expect(nextWait('403 unclaimed', 0)).toBe(REFRESH_MS)
    expect(nextWait('429', 0)).toBe(REFRESH_MS)
    expect(nextWait('503', 0)).toBe(RETRY_MS)
    expect(nextWait('timeout', RETRY_MS)).toBe(2 * RETRY_MS)
    expect(nextWait('failed', REFRESH_MS)).toBe(REFRESH_MS)
    expect(nextWait('invalid', 0)).toBe(RETRY_MS)
  })
})

describe('the answer', () => {
  test('applies to what is sent, to records queued before it as well, and is kept in the store as it came', keyless, async ($, on) => {
    const { clock, posts, store } = world(on, { settings: () => answer({ 'tool.call': 'off', 'prompt.text': 'on' }, ['secrets', 'pii.contact']) })
    // Queued under the defaults, before the answer: the call's decision is metadata, on by default.
    await decision($)
    await clock.advance(1)
    await prompt($, `mail ${MAIL}`)
    await clock.advance(TICK)
    expect(sent(posts, 'tool_decision')[0]).not.toHaveProperty('decision')
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('mail [REDACTED:pii.contact.email]')
    expect(store.data.get('dataPoints')).toEqual({ 'tool.call': 'off', 'prompt.text': 'on' })
    expect(store.data.get('redactionPacks')).toEqual(['secrets', 'pii.contact'])
    expect(store.data.get('dataCollectionSettings')).toEqual({ organizationId: ORG, revision: 3 })
  })

  test('content captured before the first answer stays out: until then, the defaults', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ 'prompt.text': 'on' }) })
    await prompt($, 'first')
    await clock.advance(1)
    await prompt($, 'second')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['<REDACTED>', 'second'])
  })

  test('a change reaches the session at the next ask; one that turns a data point off, records already queued too', keyless, async ($, on) => {
    // The collector is down until after the second answer, so what is captured before it waits in the queue.
    let down = true
    const { clock, posts, store } = world(on, {
      settings: n => (n === 1 ? answer({ 'prompt.text': 'on' }, ['secrets'], 1) : answer({ 'prompt.text': 'off' }, ['secrets'], 2)),
      down: () => down,
    })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'captured under revision 1')
    expect(store.data.get('dataCollectionSettings')).toEqual({ organizationId: ORG, revision: 1 })
    await clock.advance(REFRESH_MS)
    expect(store.data.get('dataCollectionSettings')).toEqual({ organizationId: ORG, revision: 2 })
    expect(store.data.get('dataPoints')).toEqual({ 'prompt.text': 'off' })
    down = false
    const before = posts.length
    await clock.advance(2 * 60_000)
    expect(sent(posts.slice(before), 'user_prompt').map(r => r['prompt'])).toEqual(['<REDACTED>'])
  })

  test('one that turns a data point on reaches what is captured after it', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: n => (n === 1 ? answer({}, ['secrets'], 1) : answer({ 'prompt.text': 'on' }, ['secrets'], 2)) })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'before')
    await clock.advance(REFRESH_MS)
    await prompt($, 'after')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['<REDACTED>', 'after'])
  })

  test("the organization's off wins over the person's opt-in; what it left unset follows the opt-in", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ 'prompt.text': 'off' }), layers: { user: optInOption(['prompt.text', 'response.text']) } })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'hidden')
    await response($, 'shown')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('<REDACTED>')
    expect(sent(posts, 'assistant_response')[0]!['response']).toBe('shown')
  })

  test("the organization's on wins over a Claude Code switch at 0", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ 'prompt.text': 'on' }), env: { OTEL_LOG_USER_PROMPTS: '0' } })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'shown')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('shown')
  })

  test("its packs run beside those of the organization's managed settings", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ 'prompt.text': 'on' }, ['secrets', 'pii.contact']), layers: { policy: packsOption(['pii.us_gov_id']) } })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, `${MAIL} ${SSN}`)
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('[REDACTED:pii.contact.email] [REDACTED:pii.us_gov_id.ssn]')
  })

  test('a pack this version does not have holds identifier and content values back', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ 'prompt.text': 'on' }, ['secrets', 'pii.future']) })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'held')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')).toHaveLength(1)
    expect(sent(posts, 'user_prompt')[0]).not.toHaveProperty('prompt')
  })

  test('one of the wrong shape changes nothing, and is tried again sooner', keyless, async ($, on) => {
    const { clock, posts, store } = world(on, { settings: () => ({ status: 200, text: '{"revision":"3","data_points":{"prompt.text":"on"},"redaction_packs":[]}' }) })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'hidden')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('<REDACTED>')
    expect(store.sets.filter(s => !s.key.startsWith('outbox:'))).toEqual([])
    await clock.advance(RETRY_MS)
    expect(posts.settings.length).toBe(2)
  })
})

describe('what the store keeps', () => {
  const kept = (org: string) => ({ dataPoints: { 'prompt.text': 'on' }, redactionPacks: ['secrets', 'pii.contact'], dataCollectionSettings: { organizationId: org, revision: 2 } })

  test("the organization's last answer applies while Mainwave cannot be reached", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => ({ status: 503 }), store: kept(ORG) })
    await prompt($, `mail ${MAIL}`)
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('mail [REDACTED:pii.contact.email]')
  })

  test("another organization's never applies", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => ({ status: 503 }), store: kept(ORG_B) })
    await prompt($, `mail ${MAIL}`)
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('<REDACTED>')
  })

  test('with none kept and no answer, required and metadata data points only', keyless, async ($, on) => {
    const { clock, posts } = world(on)
    await decision($)
    await prompt($, 'hidden')
    await clock.advance(TICK)
    expect(sent(posts, 'tool_decision')[0]!['decision']).toBe('accept')
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('<REDACTED>')
  })

  test('settings written by hand, for no organization, apply until an answer replaces them', keyless, async ($, on) => {
    const { clock, posts, store } = world(on, { settings: n => (n === 1 ? { status: 503 } : answer({ 'prompt.text': 'off' })), store: { dataPoints: { 'prompt.text': 'on' } } })
    await prompt($, 'shown')
    await clock.advance(TICK)
    await clock.advance(RETRY_MS)
    await prompt($, 'hidden')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['shown', '<REDACTED>'])
    expect(store.data.get('dataPoints')).toEqual({ 'prompt.text': 'off' })
  })

  test('a session that moves to another organization drops the first one\'s settings and asks for its own', keyless, async ($, on) => {
    const { clock, posts } = world(on, {
      settings: (_n, post) => (JSON.parse(post.body).claude_org_id === ORG ? answer({ 'prompt.text': 'on' }) : { status: 503 }),
    })
    await prompt($, 'a')
    await clock.advance(1)
    const other = { ...COMMON, 'organization.id': ORG_B, 'user.email': EMAIL_B }
    await prompt($, 'b', other)
    await clock.advance(1)
    await prompt($, 'c', other)
    await clock.advance(TICK)
    expect(posts.settings.map(p => JSON.parse(p.body))).toEqual([{ claude_org_id: ORG, email: EMAIL }, { claude_org_id: ORG_B, email: EMAIL_B }])
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['<REDACTED>', '<REDACTED>', '<REDACTED>'])
  })
})

describe('the answer, read', () => {
  test('the fields the plugin keeps, as they came', () => {
    expect(settingsOf(JSON.stringify({ revision: 0, data_points: {}, redaction_packs: ['secrets'], in_force: {} }))).toEqual({ revision: 0, dataPoints: {}, redactionPacks: ['secrets'] })
    expect(settingsOf(JSON.stringify({ revision: 7, data_points: { 'future.point': 'on' }, redaction_packs: [] }))).toEqual({ revision: 7, dataPoints: { 'future.point': 'on' }, redactionPacks: [] })
  })
  for (const bad of ['', 'null', '[]', '{}', '{"revision":-1,"data_points":{},"redaction_packs":[]}', '{"revision":1.5,"data_points":{},"redaction_packs":[]}', '{"revision":1,"data_points":[],"redaction_packs":[]}', '{"revision":1,"data_points":{"a":true},"redaction_packs":[]}', '{"revision":1,"data_points":{},"redaction_packs":"secrets"}', '{"revision":1,"data_points":{},"redaction_packs":[1]}']) {
    test(`not the settings: ${bad || '(empty)'}`, () => expect(settingsOf(bad)).toBeNull())
  }
  test('where it is asked for: the API beside the collector the copy goes to', () => {
    expect(settingsUrlOf('https://collector.dev.mainwave.com')).toBe('https://api.dev.mainwave.com/api/plugin/data-collection-settings')
    expect(settingsUrlOf('https://collector.mainwave.com')).toBe('https://api.mainwave.com/api/plugin/data-collection-settings')
    expect(settingsUrlOf('http://127.0.0.1:4318/plugin/')).toBe('http://127.0.0.1:4318/plugin/api/plugin/data-collection-settings')
  })
})
