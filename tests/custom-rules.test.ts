// Custom redaction rules and the allow-list, end to end: as an organization's data collection settings give them (Mainwave's answer, and
// the store that keeps it), as its managed settings and a person's user settings give rules, and as the packs and the gate run them.
// Every request the plugin makes is read back whole.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

import { resolveRedaction } from '../hooks/gate.ts'
import { redact } from '../hooks/protect.ts'
import { compileRule, type Rule } from '../hooks/rules.ts'
import { boot, EMAIL, keylessAnswer, LOGGED_AT, memoryStore, network, ORG, packsOption, type Layers, type Post, type Reply } from './rig.ts'

const keyless = { options: {} }
const START = 1_800_000_000_000
const TICK = 5_000
const COMMON = { 'organization.id': ORG, 'user.email': EMAIL, 'user.account_uuid': '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 'user.id': 'device-1', 'session.id': 's-1' }

const WORKER = { name: 'worker_id', pattern: '\\bW\\d{6}\\b' }
const ACCOUNT = { name: 'account_number', pattern: '\\bACC-\\d{4,10}\\b' }
const SUPPORT = 'support@acme.example'
const TOKEN = `ghp_${'a1B2'.repeat(9)}`
const PROMPT = `Pay W123456 on ACC-0012345; mail ${SUPPORT} and ana.lee@example.com. W000000 is the test worker.`
const REDACTED = 'Pay [REDACTED:custom.worker_id] on [REDACTED:custom.account_number]; mail support@acme.example and [REDACTED:pii.contact.email]. W000000 is the test worker.'

/** Mainwave's answer, as its settings API gives it now: prompts on, the packs in force, `custom.<name>` for each rule, and the rest. */
function answer(opts: { rules?: unknown; allow?: unknown; packs?: string[]; omit?: boolean } = {}): Reply {
  const rules = (opts.rules ?? [WORKER, ACCOUNT]) as { name?: unknown }[]
  const packs = opts.packs ?? ['secrets', 'pii.contact', ...(Array.isArray(rules) ? rules.map(r => `custom.${String(r.name)}`) : [])]
  return {
    status: 200,
    text: JSON.stringify({
      revision: 4, catalog_version: 1, data_points: { 'prompt.text': 'on' }, in_force: { 'prompt.text': 'on' }, redaction_packs: packs,
      default_data_points: [], redaction_packs_default: false,
      ...(opts.omit ? {} : { custom_rules: rules, allow_list: opts.allow ?? [SUPPORT, 'W000000'] }),
    }),
  }
}

const rulesOption = (value: unknown, id = 'mainwave@synced'): Record<string, unknown> => ({ pluginConfigs: { [id]: { options: { redactionRules: value } } } })

function world(on: On, opts: { settings?: () => Reply; store?: Record<string, unknown>; layers?: Layers } = {}) {
  const clock = mock.clock(on, { now: START })
  const store = memoryStore(on, opts.store)
  const posts = network(on, (_n, post) => {
    const a = keylessAnswer(post)
    return { status: a.status, text: a.text }
  }, undefined, opts.settings ?? (() => ({ status: 503 })))
  boot(on, { entrypoint: 'cli', layers: opts.layers })
  const logs: string[] = []
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  on('session.end', (_$, e) => ({ sessionId: (e as { sessionId: string }).sessionId }) as never)
  on('ui.log', (_$, e) => {
    logs.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  return { clock, store, posts, logs }
}

let seq = 0
async function row($: Engine, event: string, attributes: Record<string, unknown>) {
  seq += 1
  await $.telemetry.log({ to: 'collector', event, loggedAt: LOGGED_AT, attributes: { ...COMMON, 'event.name': event, 'event.sequence': seq, ...attributes } } as never)
}

type Attrs = Record<string, unknown>
const kvs = (l: { key: string; value: Record<string, unknown> }[] = []): Attrs => Object.fromEntries(l.map(a => [a.key, Object.values(a.value)[0]]))
const rowsOf = (posts: readonly Post[]): Attrs[] =>
  posts.filter(p => p.url.endsWith('/v1/logs')).flatMap(p => JSON.parse(p.body).resourceLogs.flatMap((r: any) => r.scopeLogs.flatMap((s: any) => s.logRecords))).map((r: any) => kvs(r.attributes))
const prompts = (posts: readonly Post[]) => rowsOf(posts).filter(r => r['event.name'] === 'user_prompt')
const findings = (attrs: Attrs) => JSON.parse((attrs['mainwave.redaction.findings'] as string | undefined) ?? '[]') as Attrs[]

/** The session names its organization and email, the settings are asked for, and each prompt goes as a row. */
async function send($: Engine, clock: { advance: (ms: number) => Promise<unknown> }, ...texts: string[]) {
  await row($, 'api_request', { cost_usd: 0.1 })
  await clock.advance(1)
  for (const text of texts) await row($, 'user_prompt', { prompt: text, prompt_length: String(text.length) })
  await clock.advance(TICK)
}

const rule = (name: string, pattern: string): Rule => {
  const r = compileRule({ name, pattern })
  if ('refused' in r) throw new Error(r.refused)
  return r
}

describe("the organization's rules, from Mainwave", () => {
  test('each runs as the pack custom.<name>, after the built-in packs: its match becomes [REDACTED:custom.<name>]', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer() })
    await send($, clock, PROMPT)
    expect(prompts(posts)[0]!['prompt']).toBe(REDACTED)
    expect(prompts(posts)[0]!['mainwave.redaction.count']).toBe(3)
  })

  test('they count toward the findings, as pack custom.<name> and rule <name>', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer() })
    await send($, clock, `${PROMPT} W654321`)
    expect(findings(prompts(posts)[0]!)).toEqual([
      { pack: 'pii.contact', rule: 'email', field: 'prompt.text', count: 1 },
      { pack: 'custom.worker_id', rule: 'worker_id', field: 'prompt.text', count: 2 },
      { pack: 'custom.account_number', rule: 'account_number', field: 'prompt.text', count: 1 },
    ])
  })

  test('kept in the store with the rest of the answer, and applied from it while Mainwave cannot be reached', keyless, async ($, on) => {
    const first = world(on, { settings: () => answer() })
    await send($, first.clock, 'first')
    expect(first.store.data.get('dataCollectionSettings')).toEqual({
      organizationId: ORG, revision: 4, dataPoints: { 'prompt.text': 'on' }, inForce: { 'prompt.text': 'on' },
      redactionPacks: ['secrets', 'pii.contact', 'custom.worker_id', 'custom.account_number'], customRules: [WORKER, ACCOUNT], allowList: [SUPPORT, 'W000000'],
    })
  })

  test('a later session starts from what the store keeps', keyless, async ($, on) => {
    const kept = {
      dataCollectionSettings: {
        organizationId: ORG, revision: 4, dataPoints: { 'prompt.text': 'on' }, redactionPacks: ['secrets', 'pii.contact', 'custom.worker_id', 'custom.account_number'],
        customRules: [WORKER, ACCOUNT], allowList: [SUPPORT, 'W000000'],
      },
    }
    const { clock, posts } = world(on, { store: kept })
    await send($, clock, PROMPT)
    expect(prompts(posts)[0]!['prompt']).toBe(REDACTED)
  })

  test("an older Mainwave's answer, without custom_rules or allow_list: no rules, nothing spared", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ omit: true, packs: ['secrets', 'pii.contact'] }) })
    await send($, clock, PROMPT)
    expect(prompts(posts)[0]!['prompt']).toBe('Pay W123456 on ACC-0012345; mail [REDACTED:pii.contact.email] and [REDACTED:pii.contact.email]. W000000 is the test worker.')
  })

  test('a rule changed or removed in Mainwave reaches the session at the next ask', keyless, async ($, on) => {
    let n = 0
    const { clock, posts } = world(on, { settings: () => (++n === 1 ? answer() : answer({ rules: [ACCOUNT] })) })
    await send($, clock, 'W123456')
    await clock.advance(4 * 60_000)
    await row($, 'user_prompt', { prompt: 'W123456', prompt_length: '7' })
    await clock.advance(TICK)
    expect(prompts(posts).map(r => r['prompt'])).toEqual(['[REDACTED:custom.worker_id]', 'W123456'])
  })
})

describe('a rule the plugin cannot use holds identifier and content values back, as a pack it does not have', () => {
  const CASES: [string, Reply][] = [
    ['a pattern with lookbehind', answer({ rules: [{ name: 'after_x', pattern: '(?<=x)y' }] })],
    ['a pattern that does not compile', answer({ rules: [{ name: 'broken', pattern: '(W\\d+' }] })],
    ['a pattern that matches the empty string', answer({ rules: [{ name: 'empty', pattern: 'W*' }] })],
    ['a name of the wrong shape', answer({ rules: [{ name: 'Worker-ID', pattern: 'W\\d{6}' }] })],
    ['custom.<name> listed with no rule of that name', answer({ rules: [WORKER], packs: ['secrets', 'custom.worker_id', 'custom.account_number'] })],
    ['custom_rules of the wrong shape', answer({ rules: '\\bW\\d{6}\\b', packs: ['secrets'] })],
    ['a rule of the wrong shape in the list', answer({ rules: [WORKER, { name: 'x' }], packs: ['secrets'] })],
  ]
  for (const [name, reply] of CASES) {
    test(`${name}: the row goes without its prompt`, keyless, async ($, on) => {
      const { clock, posts } = world(on, { settings: () => reply })
      await send($, clock, PROMPT)
      expect(prompts(posts)).toHaveLength(1)
      expect(prompts(posts)[0]).not.toHaveProperty('prompt')
      expect(prompts(posts)[0]!['prompt_length']).toBe(String(PROMPT.length))
    })
  }

  test('the debug log says why, never the rule', keyless, async ($, on) => {
    const { clock, logs } = world(on, { settings: () => answer({ rules: [{ name: 'secret_rule', pattern: '(?<=x)y' }] }) })
    await send($, clock, PROMPT)
    await $.session.end({ reason: 'other', sessionId: 's-1', resume: { id: 's-1' } } as never)
    expect(logs.join('\n')).toContain("a custom rule it can't use")
    expect(logs.join('\n')).not.toContain('secret_rule')
  })

  test('resolveRedaction: held for each, the packs and rules in force otherwise', () => {
    const worker = { org: [WORKER] }
    expect(resolveRedaction(['custom.worker_id'], undefined, worker)).toMatchObject({ packs: ['secrets'], custom: [{ name: 'worker_id' }] })
    expect(resolveRedaction(['custom.worker_id'], undefined, {})).toEqual({ held: 'unknown pack' })
    expect(resolveRedaction(undefined, ['custom.worker_id'], {})).toEqual({ held: 'unknown pack' })
    expect(resolveRedaction(undefined, undefined, { org: [{ name: 'bad', pattern: '(' }] })).toEqual({ held: 'unknown pack' })
    expect(resolveRedaction(undefined, undefined, { person: [{ name: 'bad', pattern: 'a?' }] })).toEqual({ held: 'unknown pack' })
    expect(resolveRedaction(undefined, undefined, { org: 'unreadable' })).toEqual({ held: 'unreadable' })
    expect(resolveRedaction(undefined, undefined, { person: 'unreadable' })).toEqual({ held: 'unreadable' })
    // A rule runs whether or not a pack list names it: more redaction, never less.
    expect(resolveRedaction(undefined, undefined, worker)).toMatchObject({ packs: ['secrets'], custom: [{ name: 'worker_id' }] })
  })
})

describe('the allow-list', () => {
  test('spares a match of a built-in or a custom pack that is an entry, whole and without case', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer() })
    await send($, clock, `mail SUPPORT@Acme.Example, W000000 and w000000x; not support@acme.example.org nor W0000001`)
    expect(prompts(posts)[0]!['prompt']).toBe('mail SUPPORT@Acme.Example, W000000 and w000000x; not [REDACTED:pii.contact.email] nor W0000001')
  })

  test('never spares a secret', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ allow: [TOKEN, `token=${TOKEN}`] }) })
    await send($, clock, `use ${TOKEN}`)
    expect(prompts(posts)[0]!['prompt']).toBe('use [REDACTED:github_token]')
  })

  test('an allow-list of the wrong shape spares nothing: it redacts more, never less', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ allow: SUPPORT }) })
    await send($, clock, `mail ${SUPPORT}`)
    expect(prompts(posts)[0]!['prompt']).toBe('mail [REDACTED:pii.contact.email]')
  })

  test("a person's settings give no allow-list", keyless, async ($, on) => {
    const layers: Layers = { user: { pluginConfigs: { 'mainwave@synced': { options: { allowList: ['ana.lee@example.com'], allow_list: ['ana.lee@example.com'] } } } } }
    const { clock, posts } = world(on, { settings: () => answer(), layers })
    await send($, clock, 'mail ana.lee@example.com')
    expect(prompts(posts)[0]!['prompt']).toBe('mail [REDACTED:pii.contact.email]')
  })
})

describe('custom rules in the packs', () => {
  const caps = rule('caps', '[A-Z]{2,}')

  test('never match inside a marker: the protections\', Claude Code\'s, or the cut marker', () => {
    const text = `<REDACTED> mail ana.lee@example.com NOW, key ${TOKEN}\n[TRUNCATED - Content exceeds 60KB limit]`
    expect(redact(text, ['pii.contact'], undefined, { custom: [caps] })).toEqual({
      text: '<REDACTED> mail [REDACTED:pii.contact.email] [REDACTED:custom.caps], key [REDACTED:github_token]\n[TRUNCATED - Content exceeds 60KB limit]',
      count: 3,
    })
    // Redacting again changes nothing more, as each value is redacted as it is queued and again as it is sent.
    const once = redact(text, ['pii.contact'], undefined, { custom: [caps] })
    expect(redact(once.text, ['pii.contact'], undefined, { custom: [caps] })).toEqual({ text: once.text, count: 0 })
    // Nor one another's: a second rule never reads the first's marker.
    expect(redact('AB', [], undefined, { custom: [caps, rule('letters', '[A-Za-z_.]+')] })).toEqual({ text: '[REDACTED:custom.caps]', count: 1 })
  })

  test('text that only looks like a marker is scanned', () => {
    expect(redact('[REDACTED:project_falcon]', [], undefined, { custom: [rule('codename', 'project_[a-z]+')] })).toEqual({ text: '[REDACTED:[REDACTED:custom.codename]]', count: 1 })
  })

  test('run after the secrets and the built-in packs: a match they replaced is theirs', () => {
    const ssnLike = rule('ssn_like', '\\d{3}-\\d{2}-\\d{4}')
    expect(redact('ssn 078-05-1120', ['pii.us_gov_id'], undefined, { custom: [ssnLike] }).text).toBe('ssn [REDACTED:pii.us_gov_id.ssn]')
    expect(redact(`key ${TOKEN}`, [], undefined, { custom: [rule('gh', 'ghp_\\w+')] }).text).toBe('key [REDACTED:github_token]')
  })

  test('run in a JSON value in place, value by value', () => {
    const json = JSON.stringify({ command: 'pay W123456', n: 7 })
    expect(redact(json, [], undefined, { custom: [rule('worker_id', WORKER.pattern)] })).toEqual({ text: '{"command":"pay [REDACTED:custom.worker_id]","n":7}', count: 1 })
  })
})

describe('rules a person adds, and the managed settings', () => {
  test("a person's rules, in their user settings, add to the organization's", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ rules: [WORKER] }), layers: { user: rulesOption([{ name: 'ticket', pattern: '\\bT-\\d+\\b' }]) } })
    await send($, clock, 'W123456 T-42')
    expect(prompts(posts)[0]!['prompt']).toBe('[REDACTED:custom.worker_id] [REDACTED:custom.ticket]')
  })

  test("a person can't remove the organization's: not by listing packs, not by a rule of the same name", keyless, async ($, on) => {
    const layers: Layers = { user: { pluginConfigs: { 'mainwave@synced': { options: { redactionPacks: ['secrets'], redactionRules: [{ name: 'worker_id', pattern: 'nothing_\\d' }] } } } } }
    const { clock, posts } = world(on, { settings: () => answer({ rules: [WORKER] }), layers })
    await send($, clock, 'W123456 nothing_1')
    expect(prompts(posts)[0]!['prompt']).toBe('[REDACTED:custom.worker_id] [REDACTED:custom.worker_id]')
  })

  test("a person's rule the plugin can't use holds their own content back", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer(), layers: { user: rulesOption([{ name: 'mine', pattern: '(?=x)' }]) } })
    await send($, clock, PROMPT)
    expect(prompts(posts)[0]).not.toHaveProperty('prompt')
  })

  test("the organization's managed settings give rules too", keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ rules: [], packs: ['secrets'] }), layers: { policy: rulesOption([ACCOUNT], 'mainwave') } })
    await send($, clock, 'ACC-12345')
    expect(prompts(posts)[0]!['prompt']).toBe('[REDACTED:custom.account_number]')
  })

  test("a repository's settings give none", keyless, async ($, on) => {
    const opt = rulesOption([{ name: 'repo_rule', pattern: 'W\\d+' }])
    const { clock, posts } = world(on, { settings: () => answer({ rules: [], packs: ['secrets'] }), layers: { project: opt, local: opt } })
    await send($, clock, 'W123456')
    expect(prompts(posts)[0]!['prompt']).toBe('W123456')
  })

  test("settings written by hand in the store apply while it keeps no answer, as its packs do", keyless, async ($, on) => {
    const { clock, posts } = world(on, { store: { dataPoints: { 'prompt.text': 'on' }, redactionRules: [WORKER] } })
    await send($, clock, 'W123456')
    expect(prompts(posts)[0]!['prompt']).toBe('[REDACTED:custom.worker_id]')
  })

  test('so do user settings with both packs and rules: under any of the plugin ids', keyless, async ($, on) => {
    const layers: Layers = { user: { ...packsOption(['pii.contact']), ...rulesOption([WORKER], 'mainwave') } }
    const { clock, posts } = world(on, { settings: () => answer({ rules: [], packs: ['secrets'] }), layers })
    await send($, clock, 'W123456')
    expect(prompts(posts)[0]!['prompt']).toBe('[REDACTED:custom.worker_id]')
  })
})

describe('the cost of a rule, bounded', () => {
  const LONG = 61_440

  test('a pattern RegExp would backtrack on for hours scans a value of the longest length at once, and redacts', keyless, async ($, on) => {
    // In RegExp, `\w+\w+\w+x` on a run of word characters with no `x` tries every way to split the run at each start: for 60,000 of
    // them, about 10^13 steps. (Short of the limit, so the marker, longer than its match, doesn't push the value past it.)
    const RUN = LONG - 1440
    const { clock, posts } = world(on, { settings: () => answer({ rules: [{ name: 'slow', pattern: '\\w+\\w+\\w+x' }], allow: [] }) })
    const at = Date.now()
    await send($, clock, `${'a'.repeat(RUN)} bbbx`)
    expect(Date.now() - at).toBeLessThan(5000)
    expect(prompts(posts)[0]!['prompt']).toBe(`${'a'.repeat(RUN)} [REDACTED:custom.slow]`)
  })

  test('a scan that spends its budget holds that value back; the record goes, and so does every other value', keyless, async ($, on) => {
    const { clock, posts } = world(on, { settings: () => answer({ rules: [{ name: 'wide', pattern: '[a-z]{1000}x' }], allow: [] }) })
    const at = Date.now()
    await send($, clock, 'a'.repeat(LONG), 'short and fine')
    expect(Date.now() - at).toBeLessThan(5000)
    expect(prompts(posts)).toHaveLength(2)
    expect(prompts(posts)[0]).not.toHaveProperty('prompt')
    expect(prompts(posts)[0]!['prompt_length']).toBe(String(LONG))
    expect(prompts(posts)[1]!['prompt']).toBe('short and fine')
  })
})
