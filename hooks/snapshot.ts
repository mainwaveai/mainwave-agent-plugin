// The plan snapshot: the signed-in Claude account's plan, its usage against its rate limits and its extra-usage spend, read from
// Claude Code's account record (`.claude.json`), which keeps them and refreshes them on its own schedule. Claude Code's telemetry
// carries none of them. Pure: the hooks module reads the file and sends the span (register.ts), as `mainwave.subscription.snapshot`
// under source `hook.anthropic`, as the CLI's hook does on every prompt.
//
// Strings go exactly as Claude Code stores them; money in the currency's minor unit. Each group carries when Claude Code fetched it:
// the profile `profile_observed_at`, the usage figures `observed_at`. A field missing from the record is left out, never sent as 0.
// The usage figures go only when they name the same account. Nothing else in the file is read into the span.

import type { TelemetryAttribute } from 'claude-code'

const P = 'mainwave.subscription.'
/** At most this many rate limits, and extra usage windows, become keys. */
export const MAX_LIMITS = 16
export const MAX_USAGE_WINDOWS = 16
const USAGE_WINDOW = /^(five_hour|seven_day)(_[a-z0-9_]+)?$/

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const rawString = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined)
const count = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined)
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)
const trimmed = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
const isoFromMs = (v: unknown) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** Adds each pair whose value is there. */
function put(out: Record<string, TelemetryAttribute>, pairs: readonly (readonly [string, TelemetryAttribute | undefined])[]): void {
  for (const [k, v] of pairs) if (v !== undefined) out[k] = v
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A rate limit's kind or scope as a key segment: lowercased, each run outside `[a-z0-9_]` one `_`, trimmed of `_`, at most 64
 * characters; one that would be cut keeps 55 characters, `_`, and the first 8 hex of the SHA-256 of the raw value.
 */
export async function limitKeySegment(v: unknown): Promise<string | undefined> {
  if (typeof v !== 'string') return undefined
  const seg = v.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
  if (seg === '') return undefined
  if (seg.length <= 64) return seg
  return `${seg.slice(0, 55).replace(/_+$/, '')}_${(await sha256Hex(v)).slice(0, 8)}`
}

/** The label a limit's scope is known by: its model's ID, else its model's name, else its surface. */
export function limitScopeLabel(scope: unknown): string | undefined {
  if (!isObject(scope)) return undefined
  const model = isObject(scope['model']) ? scope['model'] : {}
  return rawString(model['id']) ?? rawString(model['display_name']) ?? rawString(scope['surface'])
}

/**
 * The rate limits, one key group per entry: `limit.<kind>.<field>`, or `limit.<kind>.<scope>.<field>` with the raw `scope_label` for
 * a scoped one. Entries landing on the same group go once where they agree and not at all where they differ.
 */
export async function limitAttributes(limits: unknown): Promise<Record<string, TelemetryAttribute>> {
  if (!Array.isArray(limits)) return {}
  const groups = new Map<string, Record<string, TelemetryAttribute>[]>()
  for (const l of limits.slice(0, MAX_LIMITS)) {
    if (!isObject(l)) continue
    const kind = await limitKeySegment(l['kind'])
    if (kind === undefined) continue
    const label = limitScopeLabel(l['scope'])
    const scope = await limitKeySegment(label)
    const base = scope === undefined ? kind : `${kind}.${scope}`
    const key = (field: string) => `${P}limit.${base}.${field}`
    const attrs: Record<string, TelemetryAttribute> = {}
    put(attrs, [
      [key('group'), rawString(l['group'])],
      [key('percent'), finite(l['percent'])],
      [key('severity'), rawString(l['severity'])],
      [key('is_active'), bool(l['is_active'])],
      [key('resets_at'), rawString(l['resets_at'])],
      ...(scope === undefined ? [] : [[key('scope_label'), label] as const]),
    ])
    groups.set(base, [...(groups.get(base) ?? []), attrs])
  }
  const out: Record<string, TelemetryAttribute> = {}
  for (const variants of groups.values()) {
    const first = JSON.stringify(variants[0])
    if (variants.every(v => JSON.stringify(v) === first)) Object.assign(out, variants[0])
  }
  return out
}

/** The rolling windows besides `five_hour` and `seven_day` (`seven_day_opus`, ...): each one's utilization and reset, in key order. */
export function usageWindowAttributes(usage: Record<string, unknown>): Record<string, TelemetryAttribute> {
  const out: Record<string, TelemetryAttribute> = {}
  const names = Object.keys(usage).filter(k => USAGE_WINDOW.test(k) && k !== 'five_hour' && k !== 'seven_day' && isObject(usage[k])).sort().slice(0, MAX_USAGE_WINDOWS)
  for (const name of names) {
    const w = usage[name] as Record<string, unknown>
    put(out, [[`${P}usage.${name}.utilization`, finite(w['utilization'])], [`${P}usage.${name}.resets_at`, rawString(w['resets_at'])]])
  }
  return out
}

export type Snapshot = { accountUuid: string; email?: string; organizationId?: string; attributes: Record<string, TelemetryAttribute> }

/**
 * The snapshot in Claude Code's account record, or undefined where it names no account. The profile from `oauthAccount` and the
 * record's first-token date; extra usage on or off; and, only where the usage cache names the same account, the usage windows, the
 * rate limits, the extra-usage figures and when they were fetched.
 */
export async function snapshotOf(doc: unknown): Promise<Snapshot | undefined> {
  if (!isObject(doc) || !isObject(doc['oauthAccount'])) return undefined
  const account = doc['oauthAccount']
  const accountUuid = trimmed(account['accountUuid'])
  if (accountUuid === undefined) return undefined
  const cache = doc['cachedUsageUtilization']
  const usage = isObject(cache) && trimmed(cache['accountUuid']) === accountUuid && isObject(cache['utilization']) ? cache['utilization'] : undefined
  const extra = isObject(usage?.['extra_usage']) ? (usage['extra_usage'] as Record<string, unknown>) : undefined
  const window = (name: string): Record<string, unknown> => (isObject(usage?.[name]) ? (usage[name] as Record<string, unknown>) : {})
  const organizationId = trimmed(account['organizationUuid'])
  const out: Record<string, TelemetryAttribute> = {}
  put(out, [
    [`${P}provider`, 'anthropic'],
    ['organization.id', organizationId],
    [`${P}organization_type`, rawString(account['organizationType'])],
    [`${P}seat_tier`, rawString(account['seatTier'])],
    [`${P}rate_limit_tier`, rawString(account['userRateLimitTier'])],
    [`${P}billing_type`, rawString(account['billingType'])],
    [`${P}organization_role`, rawString(account['organizationRole'])],
    [`${P}workspace_role`, rawString(account['workspaceRole'])],
    [`${P}created_at`, rawString(account['subscriptionCreatedAt'])],
    [`${P}trial.ends_at`, rawString(account['claudeCodeTrialEndsAt'])],
    [`${P}trial.duration_days`, count(account['claudeCodeTrialDurationDays'])],
    [`${P}first_token_date`, rawString(doc['claudeCodeFirstTokenDate'])],
    [`${P}profile_observed_at`, isoFromMs(account['profileFetchedAt'])],
    [`${P}extra_usage.enabled`, bool(extra?.['is_enabled']) ?? bool(account['hasExtraUsageEnabled'])],
  ])
  const email = trimmed(account['emailAddress'])
  const base = { accountUuid, ...(email !== undefined ? { email } : {}), ...(organizationId !== undefined ? { organizationId } : {}) }
  if (usage === undefined || !isObject(cache)) return { ...base, attributes: out }
  put(out, [
    [`${P}usage.five_hour.utilization`, finite(window('five_hour')['utilization'])],
    [`${P}usage.five_hour.resets_at`, rawString(window('five_hour')['resets_at'])],
    [`${P}usage.seven_day.utilization`, finite(window('seven_day')['utilization'])],
    [`${P}usage.seven_day.resets_at`, rawString(window('seven_day')['resets_at'])],
  ])
  Object.assign(out, usageWindowAttributes(usage), await limitAttributes(usage['limits']))
  put(out, [
    [`${P}extra_usage.used_minor`, count(extra?.['used_credits'])],
    [`${P}extra_usage.limit_minor`, count(extra?.['monthly_limit'])],
    [`${P}extra_usage.currency`, rawString(extra?.['currency'])],
    [`${P}extra_usage.exponent`, count(extra?.['decimal_places'])],
    [`${P}extra_usage.spend_limit_reached`, bool(extra?.['spend_limit_reached'])],
    [`${P}extra_usage.disabled_reason`, rawString(extra?.['disabled_reason'])],
    [`${P}extra_usage.user_disabled`, bool(extra?.['user_disabled'])],
    [`${P}extra_usage.cached_disabled_reason`, rawString(doc['cachedExtraUsageDisabledReason'])],
    [`${P}observed_at`, isoFromMs(cache['fetchedAtMs'])],
  ])
  return { ...base, attributes: out }
}

/** The snapshot in the record's text; undefined for text that is not JSON or names no account. */
export async function snapshotOfText(text: string | undefined): Promise<Snapshot | undefined> {
  if (text === undefined) return undefined
  try {
    return await snapshotOf(JSON.parse(text))
  } catch {
    return undefined
  }
}
