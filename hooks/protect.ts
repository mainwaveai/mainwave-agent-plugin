// The protections that apply to every identifier and content value the plugin sends, whatever the gate says: secrets are replaced,
// with the personal-data packs in force after them (packs.ts), and long values are cut. Pure: tests call it directly.
//
// Secrets: Mainwave's shared secret rules (AWS access key IDs, GitHub tokens, Anthropic and OpenAI-style API keys, Slack tokens,
// private key blocks, JSON Web Tokens), plus `Authorization` header values, passwords in web addresses and values assigned to names
// that say they are secret. Each match is replaced with a marker naming its kind, as Mainwave's own SDKs mark it: `[REDACTED:<kind>]`.
//
// Length: Claude Code's own limit for telemetry content, and its marker, so a value the plugin cuts reads as one Claude Code cut.

import { addHit, scanPacks, type Hits, type PackName } from './packs.ts'

/** Claude Code's limit on a telemetry content value, in characters, when nothing sets a lower one. */
export const CONTENT_MAX_LENGTH = 61_440

/** The settings that lower the limit, as Claude Code reads them: the smallest wins. */
export const LENGTH_SETTINGS = ['CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH', 'OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT', 'OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT', 'OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT'] as const

/** The limit from those settings: `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` in place of the default, the attribute limits below it. */
export function contentLimit(env: Readonly<Partial<Record<(typeof LENGTH_SETTINGS)[number], string | undefined>>>): number {
  const n = (raw: string | undefined) => {
    const v = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
    return Number.isInteger(v) && v > 0 ? v : undefined
  }
  return Math.min(n(env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH) ?? CONTENT_MAX_LENGTH, ...LENGTH_SETTINGS.slice(1).map(k => n(env[k]) ?? Number.POSITIVE_INFINITY))
}

/** A value cut as Claude Code cuts it: within the limit, ending with its `[TRUNCATED` marker. */
export function cut(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  const marker = `\n[TRUNCATED - Content exceeds ${limit >= 1024 ? `${Math.floor(limit / 1024)}KB` : `${limit} character`} limit]`
  if (marker.length >= limit) return { text: text.slice(0, limit), truncated: true }
  return { text: text.slice(0, limit - marker.length) + marker, truncated: true }
}

type Rule = { name: string; pattern: RegExp; replace?: (match: string, ...groups: string[]) => string }

/** Mainwave's shared secret rules, as its telemetry packs define them. */
const SECRETS: readonly Rule[] = [
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: 'github_fine_grained_pat', pattern: /github_pat_[A-Za-z0-9_]{22,255}\b/g },
  { name: 'anthropic_api_key', pattern: /sk-ant-[A-Za-z0-9_-]{20,256}/g },
  { name: 'openai_style_scoped_key', pattern: /sk-(?:proj|svcacct|admin|None|or-v1)-[A-Za-z0-9_-]{20,256}/g },
  { name: 'openai_api_key', pattern: /\bsk-[A-Za-z0-9]{20,256}/g },
  { name: 'slack_token', pattern: /(?:xox[abcdprs]|xapp)-[A-Za-z0-9-]{10,256}/g },
  { name: 'private_key', pattern: /-----BEGIN (?:[A-Z]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8192}?-----END (?:[A-Z]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-----/g },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,1024}\.[A-Za-z0-9_-]{10,8192}\.[A-Za-z0-9_-]{10,8192}/g },
  // A private key cut short before its END line (a preview, a value cut at the limit): its body to where it stops.
  { name: 'private_key', pattern: /-----BEGIN (?:[A-Z]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s:,-]{0,8192}/g },
]

const marker = (name: string) => `[REDACTED:${name}]`
const isMarker = (value: string) => value.startsWith('[REDACTED')
/** A value no secret is: a marker already, or a plain number (`max_tokens: 4096`, `token.ts:42`). */
const notSecret = (value: string) => isMarker(value) || /^\d+$/.test(value)

/**
 * The plugin's own rules beside them: header values, passwords in web addresses, values of names that say they are secret. Every run
 * of characters is bounded, so a long value without a match is read in time linear in its length.
 */
const ASSIGNED: readonly Rule[] = [
  {
    name: 'authorization',
    pattern: /\b((?:proxy-)?authorization["']?[ \t]{0,8}[:=][ \t]{0,8}["']?(?:(?:bearer|basic|token|digest)[ \t]{1,8})?)([^\s"',;]{1,4096})/gi,
    replace: (m, head: string, value: string) => (notSecret(value) ? m : `${head}${marker('authorization')}`),
  },
  {
    name: 'url_password',
    pattern: /(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{1,256}:)([^\s@/]{1,1024})(@)/gi,
    replace: (m, head: string, value: string, at: string) => (isMarker(value) ? m : `${head}${marker('url_password')}${at}`),
  },
  {
    name: 'assigned_secret',
    pattern: /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]{0,64})(["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)([^\s"'&,;)\]}]{1,4096})/gi,
    replace: (m, name: string, sep: string, value: string) => (notSecret(value) ? m : `${name}${sep}${marker('assigned_secret')}`),
  },
]

/**
 * A value with every secret replaced, then every match of the personal-data packs among `packs` (packs.ts), and how many were. The
 * secret rules always run, and first, so a pack never reads the digits inside a token they replace. Each match replaced is counted in
 * `hits` too, where given: a secret under the `secrets` pack and its rule's name, a pack's match under its pack and rule.
 */
export function redact(text: string, packs: readonly PackName[] = [], hits?: Hits): { text: string; count: number } {
  let out = text
  let count = 0
  for (const rule of SECRETS) {
    out = out.replace(rule.pattern, () => ((count += 1), addHit(hits, 'secrets', rule.name), marker(rule.name)))
  }
  for (const rule of ASSIGNED) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      const m = args[0] as string
      const next = rule.replace!(m, ...(args.slice(1, -2) as string[]))
      if (next !== m) {
        count += 1
        addHit(hits, 'secrets', rule.name)
      }
      return next
    })
  }
  const p = scanPacks(out, packs, hits)
  return { text: p.text, count: count + p.count }
}
