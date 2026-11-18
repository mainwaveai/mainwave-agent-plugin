// The personal-data packs, called directly: the shared sample strings, the Luhn check and the JSON scan.

import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_PACKS, decodeJsonString, encodeJsonString, EXEMPT_KEYS, luhnValid, PACK_NAMES, scanPacks, tokenizeJson } from '../hooks/packs.ts'
import { redact } from '../hooks/protect.ts'
import { VECTORS } from './pack-vectors.ts'

describe('the packs', () => {
  test("the same four as Mainwave's SDKs and CLI hooks, in the order they run; secrets alone by default", () => {
    expect([...PACK_NAMES]).toEqual(['secrets', 'pii.contact', 'pii.us_gov_id', 'pii.payment_card'])
    expect([...DEFAULT_PACKS]).toEqual(['secrets'])
  })

  test('the shared sample strings give the replacements and counts the CLI hooks give them', () => {
    expect(VECTORS.length).toBeGreaterThan(50)
    for (const v of VECTORS) {
      expect([v.name, scanPacks(v.input, v.packs)]).toEqual([v.name, { text: v.output, count: v.count }])
      // With the secret rules before them, as every value the plugin sends goes: none of these holds a secret.
      expect([v.name, redact(v.input, v.packs)]).toEqual([v.name, { text: v.output, count: v.count }])
    }
  })

  test('with no personal-data pack, nothing changes', () => {
    expect(scanPacks('alice@example.com 4111111111111111', [])).toEqual({ text: 'alice@example.com 4111111111111111', count: 0 })
    expect(scanPacks('alice@example.com 4111111111111111', ['secrets'])).toEqual({ text: 'alice@example.com 4111111111111111', count: 0 })
  })

  test('the secret rules run first, so a card rule never reads the digits of a secret they replaced', () => {
    const key = 'sk-ant-abcdefghij-4111111111111111-z'
    expect(redact(`key ${key}`, ['pii.payment_card'])).toEqual({ text: 'key [REDACTED:anthropic_api_key]', count: 1 })
  })

  test('a marker is never matched again: redacting twice changes nothing more', () => {
    const once = redact('mail alice@example.com, call +44 20 7183 8750, card 4111 1111 1111 1111, ssn 078-05-1120', PACK_NAMES)
    expect(once.count).toBe(4)
    expect(redact(once.text, PACK_NAMES)).toEqual({ text: once.text, count: 0 })
  })
})

describe('luhnValid', () => {
  test('known card numbers pass, one digit off fails; separators are skipped', () => {
    for (const n of ['4111111111111111', '5555 5555 5555 4444', '3782-822463-10005', '6011111111111117']) expect([n, luhnValid(n)]).toEqual([n, true])
    for (const n of ['4111111111111112', '5555 5555 5555 4445', '1234567890123456']) expect([n, luhnValid(n)]).toEqual([n, false])
  })
})

describe('JSON in place', () => {
  test('finds string and number values, not keys or literals', () => {
    const text = '{"a": "x", "b": [1, true, null, "y"], "c": {"d": -2.5e3}}'
    expect(tokenizeJson(text)!.map(t => text.slice(t.start, t.end))).toEqual(['"x"', '1', '"y"', '-2.5e3'])
  })

  test('anything but one valid object or array is not JSON', () => {
    for (const text of ['"x"', '42', 'plain', '{"a": 1', '{"a": 1} x', "{'a': 1}", '{"a": "\u0001"}', '{"a": "\\x"}', '[1,]', '{"a" 1}']) {
      expect([text, tokenizeJson(text)]).toEqual([text, undefined])
    }
  })

  test('nesting of any depth is read without running out of stack', () => {
    const deep = `${'['.repeat(100_000)}"bob@example.com"${']'.repeat(100_000)}`
    const r = scanPacks(deep, ['pii.contact'])
    expect(r.count).toBe(1)
    expect(r.text).toBe(`${'['.repeat(100_000)}"[REDACTED:pii.contact.email]"${']'.repeat(100_000)}`)
  })

  test('strings decode and encode as JSON writes them', () => {
    expect(decodeJsonString('"a\\n\\u0040\\"b"')).toBe('a\n@"b')
    expect(encodeJsonString('a\n"b\\\u0001\ud800')).toBe('"a\\n\\"b\\\\\\u0001\\ud800"')
    expect(encodeJsonString('plain / ü 😀')).toBe('"plain / ü 😀"')
  })
})

describe('the keys no pack scans', () => {
  test('the identity and routing keys Mainwave joins on, a repository and a commit among them', () => {
    for (const key of ['organization.id', 'user.email', 'user.account_uuid', 'service.name', 'prompt.id', 'mainwave.redaction.count', 'vcs.repository.url.full', 'vcs.commit.sha']) {
      expect([key, EXEMPT_KEYS.has(key)]).toEqual([key, true])
    }
    for (const key of ['prompt', 'full_command', 'tool_parameters', 'file_path', 'output', 'error']) expect([key, EXEMPT_KEYS.has(key)]).toEqual([key, false])
  })
})
