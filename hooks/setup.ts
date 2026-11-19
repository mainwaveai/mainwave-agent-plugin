// What the plugin can see of the session's telemetry setup, and what it finds wrong with it: the codes on its own `plugin_status` row
// (register.ts), which Mainwave shows the organization with what fixes each. Pure: tests call it directly.
//
// It reads Claude Code's exporter settings from the environment and the merged settings. Whether the CLI's hooks run, and can send, is
// read as the markers read it (markers.ts, `cliHookKinds` and `cliCanSend`).
// Of a headers variable it reads only whether a header is named `Authorization`: never a value. Nothing it reads goes on a row but the
// codes: no endpoint, host, header or command.
//
// When no row of Claude Code's reaches the plugin (a built-in plugin that runs first can send them on past it), the session's identity
// can come from Claude's account file instead (`accountIdentityOf`): the plugin's own rows need it to be sent.

import { identityOf } from './identity.ts'
import { ISSUE_CODES, type IssueCode } from './stamps.ts'

/** The environment variables an exporter is set up by, as the session reads them. */
export type ExporterEnv = {
  CLAUDE_CODE_ENABLE_TELEMETRY?: string | undefined
  OTEL_EXPORTER_OTLP_ENDPOINT?: string | undefined
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?: string | undefined
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?: string | undefined
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string | undefined
  OTEL_EXPORTER_OTLP_HEADERS?: string | undefined
  OTEL_EXPORTER_OTLP_LOGS_HEADERS?: string | undefined
  OTEL_EXPORTER_OTLP_METRICS_HEADERS?: string | undefined
  OTEL_EXPORTER_OTLP_TRACES_HEADERS?: string | undefined
}

/**
 * Claude Code's exporter as the session sets it up: whether telemetry is on; and for each signal with an endpoint (its own, else the
 * general one), whether that endpoint is Mainwave's and whether a key goes with it (an `Authorization` header in its own headers
 * variable or the general one, or a headers helper).
 */
export type Exporter = { on: boolean; signals: readonly { where: 'mainwave' | 'other'; key: boolean }[] }

const truthy = (raw: string | undefined) => ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase())
const set = (raw: string | undefined): raw is string => raw !== undefined && raw.trim() !== ''
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Whether an endpoint is Mainwave's: a URL on `mainwave.com` or under it. Anything else, one that is no URL too, is another's. */
export function endpointOf(raw: string): 'mainwave' | 'other' {
  try {
    const host = new URL(raw.trim()).hostname.toLowerCase()
    return host === 'mainwave.com' || host.endsWith('.mainwave.com') ? 'mainwave' : 'other'
  } catch {
    return 'other'
  }
}

/** Whether an OTLP headers value (`key=value,key=value`, keys URL-encoded) names an `Authorization` header. Reads the keys alone. */
export function namesAuthorization(raw: string | undefined): boolean {
  if (!set(raw)) return false
  return raw.split(',').some(pair => {
    const eq = pair.indexOf('=')
    if (eq <= 0) return false
    let key = pair.slice(0, eq).trim()
    try {
      key = decodeURIComponent(key)
    } catch {
      // Read as written.
    }
    return key.toLowerCase() === 'authorization' && pair.slice(eq + 1).trim() !== ''
  })
}

/** The exporter from the environment and the merged settings (`otelHeadersHelper`). */
export function exporterOf(env: ExporterEnv, settings: Readonly<Record<string, unknown>>): Exporter {
  const helper = typeof settings['otelHeadersHelper'] === 'string' && settings['otelHeadersHelper'].trim() !== ''
  const general = namesAuthorization(env.OTEL_EXPORTER_OTLP_HEADERS) || helper
  const signal = (endpoint: string | undefined, headers: string | undefined) => {
    const at = set(endpoint) ? endpoint : env.OTEL_EXPORTER_OTLP_ENDPOINT
    return set(at) ? [{ where: endpointOf(at), key: general || namesAuthorization(headers) }] : []
  }
  return {
    on: truthy(env.CLAUDE_CODE_ENABLE_TELEMETRY),
    signals: [
      ...signal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, env.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
      ...signal(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, env.OTEL_EXPORTER_OTLP_METRICS_HEADERS),
      ...signal(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    ],
  }
}

/** What the plugin saw of the session, for `issuesOf`. */
export type SetupFacts = {
  /** A main-loop turn ended and no row of Claude Code's reached the plugin since it loaded. */
  rowsSkipped: boolean
  /** The merged settings run the CLI's hook for some marker, its script on this machine (register.ts, `cliHooksOf`). */
  cliHooks: boolean
  /** The CLI's hooks have a key to send with (markers.ts, `cliCanSend`). */
  cliKeyed: boolean
  exporter: Exporter
  /** The organization's settings were asked for and can't be had (orgsettings.ts, `settingsUnavailable`). */
  settingsUnavailable: boolean
  /** Why identifier and content values are held back, where they are (gate.ts, `Redaction`). */
  redactionHeld?: 'unreadable' | 'unknown pack' | undefined
  /** Records the copy dropped this load (sender.ts, `snapshot`). */
  dropped: number
}

/**
 * The codes of what is wrong, in `ISSUE_CODES`' order. The exporter's codes only while telemetry is on: no signal with an endpoint;
 * a signal whose endpoint is not Mainwave's; a signal whose endpoint is Mainwave's with no key.
 */
export function issuesOf(f: SetupFacts): IssueCode[] {
  const found = new Set<IssueCode>()
  if (f.rowsSkipped) found.add('rows_skipped')
  if (f.cliHooks && !f.cliKeyed) found.add('cli_hooks_no_exporter')
  if (f.exporter.on) {
    if (f.exporter.signals.length === 0) found.add('exporter_no_endpoint')
    if (f.exporter.signals.some(s => s.where === 'other')) found.add('exporter_elsewhere')
    if (f.exporter.signals.some(s => s.where === 'mainwave' && !s.key)) found.add('exporter_no_key')
  }
  if (f.settingsUnavailable) found.add('settings_unavailable')
  if (f.redactionHeld === 'unreadable') found.add('redaction_unreadable')
  if (f.redactionHeld === 'unknown pack') found.add('redaction_unknown_pack')
  if (f.dropped > 0) found.add('copy_dropped')
  return ISSUE_CODES.filter(c => found.has(c))
}

/** The variables that sign a session in some way other than the login in Claude's account file. */
export type SignInEnv = {
  ANTHROPIC_API_KEY?: string | undefined
  ANTHROPIC_AUTH_TOKEN?: string | undefined
  CLAUDE_CODE_OAUTH_TOKEN?: string | undefined
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR?: string | undefined
  CLAUDE_CODE_OAUTH_REFRESH_TOKEN?: string | undefined
  CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR?: string | undefined
  CLAUDE_CODE_GATEWAY_TOKEN?: string | undefined
  CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR?: string | undefined
  CLAUDE_CODE_USE_BEDROCK?: string | undefined
  CLAUDE_CODE_USE_VERTEX?: string | undefined
  CLAUDE_CODE_USE_FOUNDRY?: string | undefined
}

/**
 * Whether the session may be signed in some way other than the account file's login: an API key or token in the environment or
 * handed in on a file descriptor, an OAuth or refresh token a host hands in, a gateway's token, a cloud provider, or an API key helper
 * in the settings. The account file's login may then be someone else's,
 * or an old one, so it says nothing about who the session is.
 */
export function signedInElsewhere(env: SignInEnv, settings: Readonly<Record<string, unknown>>): boolean {
  const helper = settings['apiKeyHelper']
  return [
    env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN,
    env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR, env.CLAUDE_CODE_GATEWAY_TOKEN, env.CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR,
  ].some(set)
    || truthy(env.CLAUDE_CODE_USE_BEDROCK) || truthy(env.CLAUDE_CODE_USE_VERTEX) || truthy(env.CLAUDE_CODE_USE_FOUNDRY)
    || (typeof helper === 'string' && helper.trim() !== '')
}

/**
 * Who the session is, as Claude's account file (`.claude.json`) says: `oauthAccount`'s organization, email and account, and the
 * installation's `userID`, under the attributes Claude Code's rows name them by, each where it fits its shape (identity.ts). Empty
 * unless both the organization and the email fit: the plugin's rows go nowhere without them.
 */
export function accountIdentityOf(json: unknown): Record<string, string> {
  if (!isObject(json)) return {}
  const account = isObject(json['oauthAccount']) ? json['oauthAccount'] : {}
  const seen = identityOf({
    'organization.id': account['organizationUuid'],
    'user.email': account['emailAddress'],
    'user.account_uuid': account['accountUuid'],
    'user.id': json['userID'],
  })
  if (seen.organizationId === undefined || seen.email === undefined) return {}
  return {
    'organization.id': seen.organizationId,
    'user.email': seen.email,
    ...(seen.accountUuid !== undefined ? { 'user.account_uuid': seen.accountUuid } : {}),
    ...(seen.deviceId !== undefined ? { 'user.id': seen.deviceId } : {}),
  }
}
