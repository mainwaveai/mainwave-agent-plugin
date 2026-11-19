// The organization's data collection settings, from Mainwave: asked for once the rows name the organization and email, applied to what
// is sent, kept in the store for later sessions, asked for again every few minutes, and left as they were when the request fails. The
// network beneath is rig.ts's: the collector answers as keyless ingest does, and the settings API as each test says.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { nextWait, REFRESH_MS, RETRY_MS, settingsOf, settingsUrlOf } from '../hooks/orgsettings.ts'
import { SETTINGS_WAIT_MS } from '../hooks/register.ts'
import vendored from './fixtures/data-points.ts'
import { boot, collectorOption, EMAIL, keylessAnswer, LOGGED_AT, memoryStore, network, optInOption, ORG, packsOption, SETTINGS_URL, type Layers, type Post, type Reply } from './rig.ts'

const keyless = { options: {} }
const START = 1_800_000_000_000
const TICK = 5_000
const ORG_B = '0f8fad5b-d9cb-469f-a165-70867728950e'
const EMAIL_B = 'other@example.org'
const COMMON = { 'organization.id': ORG, 'user.email': EMAIL, 'user.account_uuid': '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'user.id': 'device-1', 'session.id': 's-1' }
const MAIL = 'ana.lee@example.com'
const SSN = '078-05-1120'

/**
 * Mainwave's answer, as its settings API gives it, but with `in_force` naming only `tool.call` and the data points the organization set:
 * the rest keep the plugin's defaults, so these tests show what the explicit settings do. `pageAnswer` gives every data point in force.
 */
const answer = (dataPoints: Record<string, string>, packs: string[] = ['secrets'], revision = 3): Reply => ({
  status: 200,
  text: JSON.stringify({
    revision, catalog_version: 1, data_points: dataPoints, in_force: { 'tool.call': 'on', ...dataPoints },
    redaction_packs: packs, default_data_points: ['tool.call'], redaction_packs_default: false,
  }),
})

/** Every switchable data point at the default of Mainwave's catalog (fixtures/data-points.ts, a copy of it): all on. */
const CATALOG_DEFAULTS: Record<string, string> = Object.fromEntries(
  (vendored as unknown as { data_points: { id: string; required?: boolean; default?: string }[] }).data_points.filter(d => !d.required).map(d => [d.id, d.default!]),
)
/**
 * Mainwave's answer as it really comes: `data_points` the organization set, and `in_force` every switchable data point as its settings
 * page shows it, the catalog's defaults for the rest. `inForce: null` leaves it out, as an older Mainwave's answer does.
 */
const pageAnswer = (dataPoints: Record<string, string>, opts: { inForce?: Record<string, string> | null; packs?: string[]; revision?: number } = {}): Reply => ({
  status: 200,
  text: JSON.stringify({
    revision: opts.revision ?? 3, catalog_version: 1, data_points: dataPoints,
    ...(opts.inForce === null ? {} : { in_force: opts.inForce ?? { ...CATALOG_DEFAULTS, ...dataPoints } }),
    redaction_packs: opts.packs ?? ['secrets'], default_data_points: Object.keys(CATALOG_DEFAULTS).filter(id => !(id in dataPoints)), redaction_packs_default: opts.packs === undefined,
  }),
})

function world(on: On, opts: { settings?: (n: number, post: Post) => Reply | Promise<Reply>; store?: Record<string, unknown>; layers?: Layers; env?: Record<string, string>; down?: () => boolean; unreadable?: string } = {}) {
  const clock = mock.clock(on, { now: START })
  const store = memoryStore(on, opts.store, opts.unreadable)
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
    expect(logs.join('')).toContain('data collection settings: from Mainwave, revision 7, 1 data point in force; last request: ok')
    expect(logs.join('')).not.toContain(EMAIL)
  })

  test('nothing asked where a repository names the collector option, as the copy goes nowhere', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({}), layers: { project: collectorOption('https://collector.example.com') } })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(TICK)
    await clock.advance(2 * REFRESH_MS)
    expect(posts.settings).toEqual([])
  })

  test("the person's collectorUrl names where to ask: Mainwave's dev API beside its dev collector, read before the first request", keyless, async ($, on) => {
    const { clock, posts } = world(on, { layers: { user: collectorOption('https://collector.dev.mainwave.com') } })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    expect(posts.settings).toEqual([])
    const asked = posts.filter(p => p.url.endsWith('/api/plugin/data-collection-settings'))
    expect(asked.map(p => p.url)).toEqual(['https://api.dev.mainwave.com/api/plugin/data-collection-settings'])
    expect(JSON.parse(asked[0]!.body)).toEqual({ claude_org_id: ORG, email: EMAIL })
  })

  test("user settings that can't be read ask nothing (they may name another Mainwave), and the plugin asks once they can be", keyless, async ($, on) => {
    const layers: Layers = { user: 'reject' }
    const { clock, posts } = world(on, { settings: () => answer({}), layers })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(RETRY_MS + TICK)
    expect(posts.settings).toEqual([])
    expect(posts.filter(p => p.url.includes('/api/plugin/'))).toEqual([])
    layers.user = {}
    await clock.advance(RETRY_MS + TICK)
    expect(posts.settings.length).toBe(1)
  })

  test("a malformed collectorUrl asks nothing, as it sends nothing", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({}), layers: { user: collectorOption('http://collector.example.com') } })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(2 * REFRESH_MS)
    expect(posts.settings).toEqual([])
    expect(posts).toEqual([])
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
    expect(nextWait('429', 0, 10 * 60_000)).toBe(10 * 60_000)
    expect(nextWait('429', 0, 5_000)).toBe(REFRESH_MS)
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
    // Kept whole, in one write, with the organization it is for.
    expect(store.sets.filter(s => !s.key.startsWith('outbox:'))).toEqual([
      { key: 'dataCollectionSettings', value: { organizationId: ORG, revision: 3, dataPoints: { 'tool.call': 'off', 'prompt.text': 'on' }, inForce: { 'tool.call': 'off', 'prompt.text': 'on' }, redactionPacks: ['secrets', 'pii.contact'] } },
    ])
  })

  test("content captured before the first answer goes with it: a row's copy waits for the first answer, the row itself never", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ 'prompt.text': 'on' }) })
    await prompt($, 'first')
    await clock.advance(1)
    await prompt($, 'second')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['first', 'second'])
  })

  test('a first answer that does not come in time: the copy goes after a few seconds, under the defaults, the row at once', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => 'hang' })
    await prompt($, 'first')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')).toEqual([])
    await clock.advance(SETTINGS_WAIT_MS)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['<REDACTED>'])
  })

  test('content the first answer turns off never goes, though settings written by hand had it on as the row was built', keyless, async ($, on) => {
    // The answer arrives after the row is built, as a session's first answer does.
    const { clock, posts } = world(on, { settings: async () => {
      await clock.advance(1_000)
      return answer({ 'prompt.text': 'off' })
    }, store: { dataPoints: { 'prompt.text': 'on' } } })
    await prompt($, 'secret first prompt')
    await clock.advance(TICK + SETTINGS_WAIT_MS)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['<REDACTED>'])
    expect(JSON.stringify(posts.map(p => p.body))).not.toContain('secret first prompt')
  })

  test('an answer that arrives after the first prompt row is built still fills it: the copy waits for it', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: async () => {
      await clock.advance(2_000)
      return answer({ 'prompt.text': 'on' })
    } })
    await prompt($, 'first prompt')
    await clock.advance(TICK + SETTINGS_WAIT_MS)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['first prompt'])
  })

  test("with the organization's answer in the store, nothing waits: the copy goes under it at once", keyless, async ($, on) => {
    const kept = { dataCollectionSettings: { organizationId: ORG, revision: 2, dataPoints: { 'prompt.text': 'on' }, redactionPacks: ['secrets'] } }
    const { clock, posts } = world(on, { settings: () => 'hang', store: kept })
    await prompt($, 'first')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['first'])
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
    expect(store.data.get('dataCollectionSettings')).toMatchObject({ organizationId: ORG, revision: 1 })
    await clock.advance(REFRESH_MS)
    expect(store.data.get('dataCollectionSettings')).toEqual({ organizationId: ORG, revision: 2, dataPoints: { 'prompt.text': 'off' }, inForce: { 'tool.call': 'on', 'prompt.text': 'off' }, redactionPacks: ['secrets'] })
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
  const kept = (org: string) => ({ dataCollectionSettings: { organizationId: org, revision: 2, dataPoints: { 'prompt.text': 'on' }, redactionPacks: ['secrets', 'pii.contact'] } })

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
    expect(store.data.get('dataCollectionSettings')).toMatchObject({ organizationId: ORG, dataPoints: { 'prompt.text': 'off' } })
  })

  test('an answer that arrives after the session moved to another organization is let go, and the new one is asked for at once', keyless, async ($, on) => {
    let release: (r: Reply) => void = () => undefined
    const late = new Promise<Reply>(r => (release = r))
    const { clock, posts, store } = world(on, { settings: (_n, post) => (JSON.parse(post.body).claude_org_id === ORG ? late : { status: 503 }) })
    await prompt($, 'a')
    await clock.advance(1)
    expect(posts.settings.length).toBe(1)
    const other = { ...COMMON, 'organization.id': ORG_B, 'user.email': EMAIL_B }
    await prompt($, 'b', other)
    await clock.advance(1)
    release(answer({ 'prompt.text': 'on' }))
    await clock.settle()
    await clock.advance(1)
    // Asked for the second organization at once, not a refresh later.
    expect(posts.settings.map(p => JSON.parse(p.body).claude_org_id)).toEqual([ORG, ORG_B])
    await prompt($, 'c', other)
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['<REDACTED>', '<REDACTED>', '<REDACTED>'])
    expect(store.data.get('dataCollectionSettings')).toBeUndefined()
  })

  test('a store that cannot be read applies nothing of the organization\'s, and holds content back', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => ({ status: 503 }), unreadable: 'dataCollectionSettings' })
    await prompt($, 'held')
    await decision($)
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]).not.toHaveProperty('prompt')
    expect(sent(posts, 'tool_decision')[0]!['decision']).toBe('accept')
  })

  test('a session that moves to another organization drops the first one\'s settings and asks for its own', keyless, async ($, on) => {
    const { clock, posts } = world(on, {
      settings: (_n, post) => (JSON.parse(post.body).claude_org_id === ORG ? answer({ 'prompt.text': 'on' }) : { status: 503 }),
    })
    await prompt($, 'a')
    await clock.advance(1)
    // The first organization's answer is in force, and its record sent under it.
    await prompt($, 'a, after its answer')
    await clock.advance(TICK)
    const other = { ...COMMON, 'organization.id': ORG_B, 'user.email': EMAIL_B }
    await prompt($, 'b', other)
    await clock.advance(1)
    await prompt($, 'c', other)
    await clock.advance(TICK)
    expect(posts.settings.map(p => JSON.parse(p.body))).toEqual([{ claude_org_id: ORG, email: EMAIL }, { claude_org_id: ORG_B, email: EMAIL_B }])
    // The first organization's first record waited for its answer; the second's, asked for later in the load, waits for none.
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['a', 'a, after its answer', '<REDACTED>', '<REDACTED>'])
  })
})

describe("what Mainwave's settings page shows", () => {
  // The organization set two data points itself; the page shows the rest at the catalog's defaults, all on.
  const SET = { 'file.path': 'on', 'tool.input': 'on' }
  const keptPage = { organizationId: ORG, revision: 3, dataPoints: SET, inForce: { ...CATALOG_DEFAULTS, ...SET }, redactionPacks: ['secrets'] }

  test('the data points the organization left alone go as the page shows them, and the store keeps what is in force with the rest', keyless, async ($, on) => {
    const { clock, posts, store, logs } = world(on, { settings: () => pageAnswer(SET, { packs: ['secrets'] }) })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'shown')
    await response($, 'also shown')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('shown')
    expect(sent(posts, 'assistant_response')[0]!['response']).toBe('also shown')
    expect(store.data.get('dataCollectionSettings')).toEqual(keptPage)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(logs.join('')).toContain(`from Mainwave, revision 3, ${Object.keys(CATALOG_DEFAULTS).length} data points in force; last request: ok`)
  })

  test('a later session starts from what the store keeps in force, while Mainwave cannot be reached', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => ({ status: 503 }), store: { dataCollectionSettings: keptPage } })
    await prompt($, 'shown')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('shown')
  })

  test("what the organization set itself wins over what is in force", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => pageAnswer({ 'prompt.text': 'off' }, { inForce: CATALOG_DEFAULTS }) })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'hidden')
    await response($, 'shown')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('<REDACTED>')
    expect(sent(posts, 'assistant_response')[0]!['response']).toBe('shown')
  })

  test("an answer without in_force (an older Mainwave's): the explicit settings alone, the plugin's defaults for the rest", keyless, async ($, on) => {
    const { clock, posts, store, logs } = world(on, { settings: () => pageAnswer({ 'response.text': 'on' }, { inForce: null }) })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'hidden')
    await response($, 'shown')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('<REDACTED>')
    expect(sent(posts, 'assistant_response')[0]!['response']).toBe('shown')
    expect(store.data.get('dataCollectionSettings')).not.toHaveProperty('inForce')
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(logs.join('')).toContain('from Mainwave, revision 3, explicit settings only; last request: ok')
  })

  test('an answer an earlier version kept, without in_force: its explicit settings alone', keyless, async ($, on) => {
    const older = { organizationId: ORG, revision: 3, dataPoints: { 'response.text': 'on' }, redactionPacks: ['secrets'] }
    const { clock, posts } = world(on, { settings: () => ({ status: 503 }), store: { dataCollectionSettings: older } })
    await prompt($, 'hidden')
    await response($, 'shown')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('<REDACTED>')
    expect(sent(posts, 'assistant_response')[0]!['response']).toBe('shown')
  })

  test("what another organization's kept answer gives in force never applies", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => ({ status: 503 }), store: { dataCollectionSettings: { ...keptPage, organizationId: ORG_B } } })
    await prompt($, 'hidden')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt')[0]!['prompt']).toBe('<REDACTED>')
  })

  test("a later answer without in_force: the store drops it, and the plugin's defaults stand for the rest", keyless, async ($, on) => {
    const { clock, posts, store } = world(on, { settings: n => (n === 1 ? pageAnswer(SET) : pageAnswer(SET, { inForce: null })) })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'shown')
    await clock.advance(REFRESH_MS)
    await prompt($, 'hidden')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['shown', '<REDACTED>'])
    expect(store.data.get('dataCollectionSettings')).toEqual({ organizationId: ORG, revision: 3, dataPoints: SET, redactionPacks: ['secrets'] })
  })

  test('a change to what is in force alone (a catalog default changed in a deploy, no new revision) reaches the session and the store', keyless, async ($, on) => {
    const { clock, posts, store } = world(on, {
      settings: n => pageAnswer({}, { inForce: n === 1 ? CATALOG_DEFAULTS : { ...CATALOG_DEFAULTS, 'prompt.text': 'off' } }),
    })
    await row($, 'api_request', { cost_usd: 0.1 })
    await clock.advance(1)
    await prompt($, 'shown')
    await clock.advance(REFRESH_MS)
    await prompt($, 'hidden')
    await clock.advance(TICK)
    expect(sent(posts, 'user_prompt').map(r => r['prompt'])).toEqual(['shown', '<REDACTED>'])
    expect(store.data.get('dataCollectionSettings')).toMatchObject({ revision: 3, inForce: { 'prompt.text': 'off' } })
  })
})

describe('the answer, read', () => {
  test('the fields the plugin keeps, as they came', () => {
    expect(settingsOf(JSON.stringify({ revision: 0, data_points: {}, redaction_packs: ['secrets'], in_force: { repo: 'on' } }))).toEqual({ revision: 0, dataPoints: {}, inForce: { repo: 'on' }, redactionPacks: ['secrets'] })
    // An `in_force` of another shape is left out; the answer still counts.
    expect(settingsOf(JSON.stringify({ revision: 1, data_points: { repo: 'on' }, redaction_packs: [], in_force: ['repo'] }))).toEqual({ revision: 1, dataPoints: { repo: 'on' }, redactionPacks: [] })
    expect(settingsOf(JSON.stringify({ revision: 1, data_points: {}, redaction_packs: [], in_force: { repo: true } }))).toEqual({ revision: 1, dataPoints: {}, redactionPacks: [] })
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
