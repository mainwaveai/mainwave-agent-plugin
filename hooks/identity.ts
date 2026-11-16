// Who a session is, as Claude Code's own telemetry rows say: the organization, the account, the email and the device. Pure.
//
// Claude Code puts these on every row it exports: `organization.id`, `user.account_uuid`, `user.email` and `user.id` (an ID Claude
// Code keeps per installation, which the plugin calls the device ID). They are claims: anyone who controls the machine controls them.
// A value that does not fit its shape is ignored, never stored.

import type { RowIdentity } from '../types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether a value is a Claude organization ID: a UUID. */
export const isOrgId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
// One @, no spaces or controls, a dot in the domain; at most 254 characters (RFC 5321's path limit).
const EMAIL = /^[^\s@\u0000-\u001f\u007f]{1,64}@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/
const DEVICE = /^[A-Za-z0-9._:-]{1,128}$/

/** The row attribute each field is read from, and the shape it must have. */
export const IDENTITY_FIELDS: readonly { field: keyof RowIdentity; attribute: string; fits: (v: string) => boolean }[] = [
  { field: 'organizationId', attribute: 'organization.id', fits: isOrgId },
  { field: 'accountUuid', attribute: 'user.account_uuid', fits: v => UUID.test(v) },
  { field: 'email', attribute: 'user.email', fits: v => v.length <= 254 && EMAIL.test(v) },
  { field: 'deviceId', attribute: 'user.id', fits: v => DEVICE.test(v) },
]

/** The identity fields one row carries, each only where it fits its shape. */
export function identityOf(attributes: Readonly<Record<string, unknown>>): RowIdentity {
  const out: RowIdentity = {}
  for (const { field, attribute, fits } of IDENTITY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(attributes, attribute)) continue
    const value = attributes[attribute]
    if (typeof value === 'string' && fits(value)) out[field] = value
  }
  return out
}

/**
 * The session's identity after one more row: each field the row carries replaces the one held, and a field it lacks keeps the one
 * held. Answers the held object itself when nothing changed, so a caller can skip the write.
 */
export function mergeIdentity(held: RowIdentity, seen: RowIdentity): RowIdentity {
  let changed = false
  const next: RowIdentity = { ...held }
  for (const { field } of IDENTITY_FIELDS) {
    const value = seen[field]
    if (value !== undefined && value !== held[field]) {
      next[field] = value
      changed = true
    }
  }
  return changed ? next : held
}

/**
 * Keys a Mainwave source processor stores in place of a record's `user.email`. Keyless ingest refuses a record that carries one, as
 * it could be routed by one address and shown under another.
 */
const EMAIL_OVERRIDES = ['kiro.user.email']

/**
 * Who a record is routed to without a key: its own `organization.id` and `user.email`, as one string, when both fit their shapes and
 * nothing would override the email; undefined otherwise. Keyless ingest reads the pair from each record, span and data point (never
 * the resource) and takes one pair per request.
 */
export function routingIdentityOf(attributes: Readonly<Record<string, unknown>>): string | undefined {
  const own = (k: string) => Object.prototype.hasOwnProperty.call(attributes, k)
  if (EMAIL_OVERRIDES.some(own)) return undefined
  const { organizationId, email } = identityOf(attributes)
  return organizationId !== undefined && email !== undefined ? `${organizationId} ${email}` : undefined
}
