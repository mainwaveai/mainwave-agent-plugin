// What the plugin finds wrong with the session's telemetry setup, from what it reads (hooks/setup.ts). Pure.

import { describe, expect, test } from 'claude-code/testing'

import { accountIdentityOf, endpointOf, exporterOf, issuesOf, namesAuthorization, signedInElsewhere, type SetupFacts } from '../hooks/setup.ts'
import { issuesStamp } from '../hooks/stamps.ts'
import { ACCOUNT, CONTRACT, DEVICE, EMAIL, ISSUE_CODES, ORG } from './rig.ts'

const off = { on: false, signals: [] }
const none: SetupFacts = { rowsSkipped: false, cliHooks: false, cliKeyed: false, exporter: off, settingsUnavailable: false, dropped: 0 }
const MW = 'https://collector.mainwave.com'
const KEY = 'Authorization=Bearer k'

describe('endpointOf', () => {
  test("Mainwave's: mainwave.com and anything under it", () => {
    for (const u of ['https://collector.mainwave.com', 'https://collector.mainwave.com/v1/logs', 'https://MAINWAVE.com', 'http://dev.collector.mainwave.com:4318']) expect(endpointOf(u)).toBe('mainwave')
  })
  test("another's: any other host, a look-alike, a loopback, or no URL at all", () => {
    for (const u of ['https://otel.example.com', 'https://mainwave.com.example.com', 'https://notmainwave.com', 'http://localhost:4318', 'collector.mainwave.com', '']) expect(endpointOf(u)).toBe('other')
  })
})

describe('namesAuthorization', () => {
  test('a header named Authorization with a value, in any case, encoded or not, among others', () => {
    for (const h of ['Authorization=Bearer k', 'authorization=Bearer%20k', 'x-a=1, AUTHORIZATION = Bearer k', 'Author%69zation=k']) expect(namesAuthorization(h)).toBe(true)
  })
  test('none: no headers, another header, an empty value, a key that only holds the word', () => {
    for (const h of [undefined, '', 'x-api-key=k', 'Authorization=', 'Authorization', 'x-authorization=k', 'Authorization-Extra=k']) expect(namesAuthorization(h)).toBe(false)
  })
})

describe('exporterOf', () => {
  test('telemetry on as Claude Code reads it; each signal its own endpoint, else the general one', () => {
    expect(exporterOf({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: MW, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://otel.example.com' }, {})).toEqual({
      on: true,
      signals: [{ where: 'other', key: false }, { where: 'mainwave', key: false }, { where: 'mainwave', key: false }],
    })
    expect(exporterOf({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: MW }, {}).signals).toEqual([{ where: 'mainwave', key: false }])
    expect(exporterOf({ CLAUDE_CODE_ENABLE_TELEMETRY: '0', OTEL_EXPORTER_OTLP_ENDPOINT: '  ' }, {})).toEqual(off)
  })
  test("a signal's key: its own headers, the general ones, or a headers helper", () => {
    const keys = (env: Record<string, string>, settings: Record<string, unknown> = {}) => exporterOf({ OTEL_EXPORTER_OTLP_ENDPOINT: MW, ...env }, settings).signals.map(x => x.key)
    expect(keys({ OTEL_EXPORTER_OTLP_HEADERS: KEY })).toEqual([true, true, true])
    expect(keys({}, { otelHeadersHelper: '/bin/headers' })).toEqual([true, true, true])
    expect(keys({}, { otelHeadersHelper: ' ' })).toEqual([false, false, false])
    // A key for the traces alone: the logs and metrics go without one.
    expect(keys({ OTEL_EXPORTER_OTLP_TRACES_HEADERS: KEY })).toEqual([false, false, true])
  })
})

describe('issuesOf', () => {
  const at = (where: 'mainwave' | 'other', key: boolean) => ({ where, key })
  test('nothing wrong: no codes', () => {
    expect(issuesOf(none)).toEqual([])
  })
  test('each fact its code, in the list order', () => {
    expect(issuesOf({ ...none, rowsSkipped: true, settingsUnavailable: true, redactionHeld: 'unreadable', dropped: 3 })).toEqual(['rows_skipped', 'settings_unavailable', 'redaction_unreadable', 'copy_dropped'])
    expect(issuesOf({ ...none, redactionHeld: 'unknown pack' })).toEqual(['redaction_unknown_pack'])
  })
  test("the CLI's hooks need an exporter they can send with, whether telemetry is on or not", () => {
    expect(issuesOf({ ...none, cliHooks: true })).toEqual(['cli_hooks_no_exporter'])
    expect(issuesOf({ ...none, cliHooks: true, exporter: { on: false, signals: [at('mainwave', true)] } })).toEqual(['cli_hooks_no_exporter'])
    expect(issuesOf({ ...none, cliHooks: true, cliKeyed: true })).toEqual([])
    expect(issuesOf({ ...none, cliKeyed: false })).toEqual([])
  })
  test("the exporter's codes only while telemetry is on", () => {
    expect(issuesOf({ ...none, exporter: { on: false, signals: [at('other', false)] } })).toEqual([])
    expect(issuesOf({ ...none, exporter: { on: true, signals: [] } })).toEqual(['exporter_no_endpoint'])
    expect(issuesOf({ ...none, exporter: { on: true, signals: [at('mainwave', false)] } })).toEqual(['exporter_no_key'])
    expect(issuesOf({ ...none, exporter: { on: true, signals: [at('mainwave', true), at('mainwave', false)] } })).toEqual(['exporter_no_key'])
    expect(issuesOf({ ...none, exporter: { on: true, signals: [at('mainwave', false), at('other', true)] } })).toEqual(['exporter_no_key', 'exporter_elsewhere'])
    expect(issuesOf({ ...none, exporter: { on: true, signals: [at('other', false)] } })).toEqual(['exporter_elsewhere'])
  })
  test('every list it gives passes the issues stamp and the test contract', () => {
    const all = issuesOf({ rowsSkipped: true, cliHooks: true, cliKeyed: false, exporter: { on: true, signals: [at('mainwave', false), at('other', false)] }, settingsUnavailable: true, redactionHeld: 'unreadable', dropped: 1 })
    expect(all).toEqual(ISSUE_CODES.filter(c => c !== 'exporter_no_endpoint' && c !== 'redaction_unknown_pack'))
    expect(issuesStamp(all)).toEqual({ 'mainwave.telemetry.issues': all })
    expect(CONTRACT['mainwave.telemetry.issues']!(all)).toBe(true)
  })
})

describe('the issues stamp', () => {
  test('the codes match the test contract, in its order', () => {
    expect(issuesStamp(ISSUE_CODES)).toEqual({ 'mainwave.telemetry.issues': ISSUE_CODES })
    expect(CONTRACT['mainwave.telemetry.issues']!(ISSUE_CODES)).toBe(true)
  })
  test('none, a code it does not know, a code twice, or out of order: no stamp', () => {
    for (const bad of [[], ['made_up'], ['rows_skipped', 'rows_skipped'], ['copy_dropped', 'rows_skipped']]) expect(issuesStamp(bad)).toEqual({})
  })
})

describe('signedInElsewhere', () => {
  test('an API key or token, a host token, a cloud provider, or an API key helper', () => {
    for (const env of [{ ANTHROPIC_API_KEY: 'k' }, { ANTHROPIC_AUTH_TOKEN: 't' }, { CLAUDE_CODE_OAUTH_TOKEN: 't' }, { CLAUDE_CODE_USE_BEDROCK: '1' }, { CLAUDE_CODE_USE_VERTEX: 'true' }, { CLAUDE_CODE_USE_FOUNDRY: '1' }]) {
      expect(signedInElsewhere(env, {})).toBe(true)
    }
    expect(signedInElsewhere({}, { apiKeyHelper: '/bin/key' })).toBe(true)
  })
  test("none of them: the account file's login is the session's", () => {
    expect(signedInElsewhere({}, {})).toBe(false)
    expect(signedInElsewhere({ ANTHROPIC_API_KEY: ' ', CLAUDE_CODE_USE_BEDROCK: '0' }, { apiKeyHelper: '' })).toBe(false)
  })
})

describe('accountIdentityOf', () => {
  test("a login's organization, email and account, and the installation's ID, under the attributes rows name them by", () => {
    expect(accountIdentityOf({ userID: DEVICE, oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL, accountUuid: ACCOUNT, displayName: 'Dev', organizationName: 'Example' } }))
      .toEqual({ 'organization.id': ORG, 'user.email': EMAIL, 'user.account_uuid': ACCOUNT, 'user.id': DEVICE })
  })
  test('the organization and email alone are enough; a field of the wrong shape is left out', () => {
    expect(accountIdentityOf({ userID: 'has spaces', oauthAccount: { organizationUuid: ORG, emailAddress: EMAIL, accountUuid: 'no' } })).toEqual({ 'organization.id': ORG, 'user.email': EMAIL })
  })
  test('nothing without both the organization and the email', () => {
    for (const f of [undefined, null, 'text', {}, { userID: DEVICE }, { oauthAccount: { organizationUuid: ORG } }, { oauthAccount: { emailAddress: EMAIL } }, { oauthAccount: { organizationUuid: 'x', emailAddress: EMAIL } }]) {
      expect(accountIdentityOf(f)).toEqual({})
    }
  })
})
