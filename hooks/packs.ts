// The personal-data redaction packs: the same packs, rule names and matches as Mainwave's SDKs and CLI hooks, so a pack an
// organization turns on means the same thing in the plugin as in an application or a coding tool's hooks. Pure: tests call it
// directly.
//
// Each pack is a list of rules run in order; the packs run in their fixed order (`PACK_NAMES`), whatever order a setting lists them
// in. A match is replaced with `[REDACTED:<pack>.<rule>]`. A card number is replaced only when it passes the Luhn check. A value that
// is JSON (an object or an array, as `tool_parameters` is) is redacted in place: each string and number value is scanned on its own,
// decoded, and only a value that changed is rewritten, as a JSON string; keys, punctuation and spacing stay byte for byte. A value that
// reads as JSON but no longer parses (cut at the length limit, or changed by a secret rule) is scanned as text, and again with each
// JSON escape (`\n`, `\"`, `\u0040`) as a boundary, so a number written after `\n` is still found.
//
// One difference from the CLI hooks, on purpose: there an organization's packs run before the secrets pack unless it lists it, while
// here the secret rules always run first, so a match inside a secret is replaced as the secret, whole.
//
// `secrets` is the pack of secret rules (protect.ts), on whatever a setting says. The keys in `EXEMPT_KEYS` are never scanned by a
// pack: the identity and routing keys Mainwave joins on.

/** Every pack, in the order they run. */
export const PACK_NAMES = ['secrets', 'pii.contact', 'pii.us_gov_id', 'pii.payment_card'] as const
export type PackName = (typeof PACK_NAMES)[number]

/**
 * The packs that apply with no choice from the organization: secrets alone, as Mainwave's org-wide setup applies to its hooks by
 * default. A person may add packs to these, and an organization's choice replaces them.
 */
export const DEFAULT_PACKS: readonly PackName[] = ['secrets']

type PackRule = { name: string; pattern: RegExp; luhn?: true }

/**
 * The personal-data packs' rules. Every pattern is ASCII: `\d` and `\b` read ASCII digits and word characters only, so a non-ASCII
 * letter is a word boundary and other scripts' digits are not digits.
 */
const PII_PACKS: Readonly<Record<Exclude<PackName, 'secrets'>, readonly PackRule[]>> = {
  'pii.contact': [
    { name: 'email', pattern: /\b[A-Za-z0-9._%+'-]{1,64}(?:@|%40)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/gu },
    {
      name: 'phone_nanp',
      pattern: /(?:\+1[ .-]?)?(?:\([2-9]\d{2}\)[ .-]?[2-9]\d{2}[ .-]\d{4}|\b[2-9]\d{2}[ .-][2-9]\d{2}[ .-]\d{4})\b|\+1[ .-]?[2-9]\d{2}[ .-]?[2-9]\d{2}[ .-]?\d{4}\b/gu,
    },
    { name: 'phone_e164', pattern: /\B\+[1-9](?:[ .-]?\d){7,14}\b/gu },
  ],
  'pii.us_gov_id': [
    { name: 'ssn', pattern: /\b(?:00[1-9]|0[1-9]\d|[1-578]\d\d|6[0-57-9]\d|66[0-57-9])-(?:0[1-9]|[1-9]\d)-(?:000[1-9]|00[1-9]\d|0[1-9]\d\d|[1-9]\d{3})\b/gu },
  ],
  'pii.payment_card': [
    { name: 'card_number_grouped_19', pattern: /\b[2-6]\d{3}[ .-]\d{4}[ .-]\d{4}[ .-]\d{4}[ .-]\d{3}\b/gu, luhn: true },
    { name: 'card_number', pattern: /\b[2-6](?:\d{12,18}|\d{3}[ .-]\d{4}[ .-]\d{4}[ .-]\d{1,4}|\d{3}[ .-]\d{6}[ .-]\d{4,5})\b/gu, luhn: true },
  ],
}

/**
 * The keys no pack scans, whatever the packs say: the identity and routing keys Mainwave joins on, the same list its SDKs and hooks
 * ship. Most never reach a pack in the plugin, as the protections apply to identifier and content values alone; the list keeps those
 * that do (a repository's address, a commit) as Mainwave's other paths send them.
 */
export const EXEMPT_KEYS: ReadonlySet<string> = new Set([
  'agent.decision', 'agent_id', 'ccr.session.id', 'cowork.surface', 'decision', 'devtool.cr_number', 'devtool.cr_url', 'devtool.external_id',
  'devtool.review_id', 'devtool.review_verdict', 'devtool.wi_key', 'devtool.wi_prev_state_category', 'devtool.wi_state_category', 'devtool.wi_url',
  'event.kind', 'gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.conversation.id', 'gen_ai.generation.id', 'gen_ai.operation.name',
  'gen_ai.provider.name', 'gen_ai.response.id', 'gen_ai.system', 'gen_ai.tool.call.id', 'gen_ai.tool.name', 'gen_ai.tool.type', 'github.pr_number',
  'github.pr_url', 'kiro.account.id', 'kiro.client.type', 'kiro.file.op', 'kiro.hook_event_name', 'kiro.metric', 'kiro.profile.arn', 'kiro.profile.id',
  'kiro.surface', 'kiro.tool_name', 'kiro.user.email', 'kiro.user.id', 'linear.issue_id', 'linear.issue_url', 'linear.op', 'llm.system',
  'mainwave.caller.span_id', 'mainwave.caller.trace_id', 'mainwave.claude_code.stop_failure.error', 'mainwave.codex.agent_type',
  'mainwave.codex.parent_turn_id', 'mainwave.codex.tool_name', 'mainwave.codex.turn.end_reason', 'mainwave.codex.turn_id',
  'mainwave.codex.wait.end_event', 'mainwave.connector_id', 'mainwave.connector_type', 'mainwave.devtool_vendor', 'mainwave.host_source',
  'mainwave.mod.entrypoint', 'mainwave.mod.name', 'mainwave.organization_id', 'mainwave.plugin.entrypoint', 'mainwave.plugin.name',
  'mainwave.reasoning.present', 'mainwave.redaction.count', 'mainwave.request.thinking', 'mainwave.run_id', 'mainwave.source',
  'mainwave.subagent.id', 'mainwave.subscription.billing_type', 'mainwave.subscription.organization_role', 'mainwave.subscription.organization_type',
  'mainwave.subscription.provider', 'mainwave.subscription.rate_limit_tier', 'mainwave.subscription.seat_tier', 'mainwave.subscription.trigger',
  'mainwave.subscription.workspace_role', 'mainwave.telemetry.route', 'mainwave.ucid', 'mainwave.ucid_source', 'mainwave.user_email',
  'mcp_server_scope', 'organization.id', 'prompt.id', 'query_source', 'service.name', 'status_code', 'user.account_uuid', 'user.email',
  'vcs.change.external_id', 'vcs.change.file.status', 'vcs.change.id', 'vcs.change.merge_commit_sha', 'vcs.change.review.id',
  'vcs.change.review.verdict', 'vcs.change.state', 'vcs.commit.parent_sha', 'vcs.commit.sha', 'vcs.provider.name', 'vcs.repository.default_branch',
  'vcs.repository.id', 'vcs.repository.url.full', 'work.instance', 'work.item.external_id', 'work.item.id', 'work.item.op', 'work.item.previous_state',
  'work.item.state', 'work.item.url', 'work.vendor',
])

/** Whether the digits in `text` pass the Luhn check: from the rightmost, every second one doubled (less 9 above 9), the sum divisible by 10. */
export function luhnValid(text: string): boolean {
  let sum = 0
  let double = false
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text.charCodeAt(i)
    if (c < 0x30 || c > 0x39) continue
    let digit = c - 0x30
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/** Plain text with every match of the packs' rules replaced, in pack order, and how many were. */
function scanText(text: string, packs: readonly PackName[]): { text: string; count: number } {
  let out = text
  let count = 0
  if (out === '') return { text: out, count }
  for (const pack of PACK_NAMES) {
    if (pack === 'secrets' || !packs.includes(pack)) continue
    for (const rule of PII_PACKS[pack]) {
      out = out.replace(rule.pattern, match => {
        if (match === '' || (rule.luhn && !luhnValid(match))) return match
        count += 1
        return `[REDACTED:${pack}.${rule.name}]`
      })
    }
  }
  return { text: out, count }
}

/** A JSON escape: what a JSON string writes for a quote, a backslash, a slash, a control character or any character by its code. */
const JSON_ESCAPE = /\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})/g

/**
 * Text that is not JSON: scanned whole, as the CLI hooks scan it, then each run between JSON escapes on its own, for text that was
 * JSON before it was cut or changed. The second pass only finds more: a marker the first wrote is never matched again.
 */
function scanLoose(text: string, packs: readonly PackName[]): { text: string; count: number } {
  const whole = scanText(text, packs)
  if (!whole.text.includes('\\')) return whole
  let count = whole.count
  let out = ''
  let last = 0
  for (const m of whole.text.matchAll(JSON_ESCAPE)) {
    const run = scanText(whole.text.slice(last, m.index), packs)
    count += run.count
    out += run.text + m[0]
    last = m.index + m[0].length
  }
  const tail = scanText(whole.text.slice(last), packs)
  return { text: out + tail.text, count: count + tail.count }
}

/**
 * A value with every match of the personal-data packs among `packs` replaced, and how many were: in place where the value is JSON,
 * else as text (`scanLoose`). `secrets` is not run here (protect.ts runs it first).
 */
export function scanPacks(text: string, packs: readonly PackName[]): { text: string; count: number } {
  if (!packs.some(p => p !== 'secrets')) return { text, count: 0 }
  const tokens = tokenizeJson(text)
  if (tokens === undefined) return scanLoose(text, packs)
  let out = ''
  let last = 0
  let count = 0
  for (const token of tokens) {
    const raw = text.slice(token.start, token.end)
    const value = token.kind === 'string' ? decodeJsonString(raw) : raw
    const r = scanText(value, packs)
    if (r.text === value) continue
    count += r.count
    out += text.slice(last, token.start) + encodeJsonString(r.text)
    last = token.end
  }
  return { text: last === 0 ? text : out + text.slice(last), count }
}

// ── JSON in place ─────────────────────────────────────────────────────────────
// A strict RFC 8259 tokenizer that finds the string and number values of a JSON object or array, with an explicit stack so no depth
// of nesting can overflow the call stack. The value is never parsed into objects and never written out again whole.

type Token = { kind: 'string' | 'number'; start: number; end: number }

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
const isHex = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y

/** The index after the string that starts at `text[start]` (a quote), or -1 when it is not a valid JSON string. */
function stringEnd(text: string, start: number): number {
  const n = text.length
  for (let i = start + 1; i < n; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x22) return i + 1
    if (c < 0x20) return -1
    if (c !== 0x5c) continue
    const next = text[i + 1]
    if (next === undefined) return -1
    if ('"\\/bfnrt'.includes(next)) i++
    else if (next === 'u') {
      for (let k = 2; k <= 5; k++) if (i + k >= n || !isHex(text.charCodeAt(i + k))) return -1
      i += 5
    } else return -1
  }
  return -1
}

/**
 * The value tokens of `text` when it is one JSON object or array (leading and trailing JSON whitespace allowed), in order; undefined
 * when it is not. Keys, punctuation and the literals `true`, `false` and `null` are not tokens.
 */
export function tokenizeJson(text: string): Token[] | undefined {
  const n = text.length
  let i = 0
  while (i < n && isSpace(text.charCodeAt(i))) i++
  if (text[i] !== '{' && text[i] !== '[') return undefined
  const tokens: Token[] = []
  // true: an object, false: an array.
  const stack: boolean[] = []
  let state: 'value' | 'valueOrEnd' | 'keyOrEnd' | 'key' | 'colon' | 'after' = 'value'
  for (;;) {
    while (i < n && isSpace(text.charCodeAt(i))) i++
    if (state === 'after' && stack.length === 0) return i === n ? tokens : undefined
    if (i >= n) return undefined
    const char = text[i]!
    switch (state) {
      case 'valueOrEnd':
        if (char === ']') {
          stack.pop()
          i++
          state = 'after'
        } else state = 'value'
        break
      case 'value':
        if (char === '{') {
          stack.push(true)
          i++
          state = 'keyOrEnd'
        } else if (char === '[') {
          stack.push(false)
          i++
          state = 'valueOrEnd'
        } else if (char === '"') {
          const end = stringEnd(text, i)
          if (end < 0) return undefined
          tokens.push({ kind: 'string', start: i, end })
          i = end
          state = 'after'
        } else if (char === '-' || (char >= '0' && char <= '9')) {
          NUMBER.lastIndex = i
          const m = NUMBER.exec(text)
          if (m === null) return undefined
          tokens.push({ kind: 'number', start: i, end: i + m[0].length })
          i += m[0].length
          state = 'after'
        } else if (text.startsWith('true', i)) {
          i += 4
          state = 'after'
        } else if (text.startsWith('false', i)) {
          i += 5
          state = 'after'
        } else if (text.startsWith('null', i)) {
          i += 4
          state = 'after'
        } else return undefined
        break
      case 'keyOrEnd':
        if (char === '}') {
          stack.pop()
          i++
          state = 'after'
        } else state = 'key'
        break
      case 'key': {
        if (char !== '"') return undefined
        const end = stringEnd(text, i)
        if (end < 0) return undefined
        i = end
        state = 'colon'
        break
      }
      case 'colon':
        if (char !== ':') return undefined
        i++
        state = 'value'
        break
      case 'after': {
        const inObject = stack[stack.length - 1]
        if (char === ',') {
          i++
          state = inObject ? 'key' : 'value'
        } else if (char === (inObject ? '}' : ']')) {
          stack.pop()
          i++
        } else return undefined
        break
      }
    }
  }
}

const ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

/** The text of a valid JSON string token, quotes included in `raw`. A lone surrogate escape stays a lone surrogate. */
export function decodeJsonString(raw: string): string {
  if (!raw.includes('\\')) return raw.slice(1, -1)
  let out = ''
  let run = 1
  const end = raw.length - 1
  for (let i = 1; i < end; i++) {
    if (raw.charCodeAt(i) !== 0x5c) continue
    out += raw.slice(run, i)
    const next = raw[i + 1]!
    if (next === 'u') {
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 6), 16))
      i += 5
    } else {
      out += ESCAPES[next]
      i++
    }
    run = i + 1
  }
  return out + raw.slice(run, end)
}

const hex4 = (c: number) => `\\u${c.toString(16).padStart(4, '0')}`

/**
 * `text` as a JSON string: `"` and `\` escaped, backspace, form feed, newline, carriage return and tab as `\b \f \n \r \t`, every other
 * character below U+0020 and every lone surrogate as `\u` and four lowercase hex digits, everything else as it is.
 */
export function encodeJsonString(text: string): string {
  let out = '"'
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x22) out += '\\"'
    else if (c === 0x5c) out += '\\\\'
    else if (c === 0x08) out += '\\b'
    else if (c === 0x0c) out += '\\f'
    else if (c === 0x0a) out += '\\n'
    else if (c === 0x0d) out += '\\r'
    else if (c === 0x09) out += '\\t'
    else if (c < 0x20) out += hex4(c)
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i]! + text[i + 1]!
        i++
      } else out += hex4(c)
    } else if (c >= 0xdc00 && c <= 0xdfff) out += hex4(c)
    else out += text[i]
  }
  return `${out}"`
}
