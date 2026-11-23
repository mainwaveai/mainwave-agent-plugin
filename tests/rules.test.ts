// Custom redaction rules, called directly: the syntax a rule may use, the matches the Pike VM finds (the ones `RegExp` finds), the cost
// of a scan, and how a rule, a list of rules and an allow-list are read.

import { describe, expect, test } from 'claude-code/testing'

import { allowListOf, BudgetSpent, budgetFor, compilePattern, compileRule, matchAt, MAX_PROGRAM, MIN_STEPS, rulesOf, STEPS_PER_CHAR, type Program } from '../hooks/rules.ts'
import { CONTENT_MAX_LENGTH } from '../hooks/protect.ts'

const program = (pattern: string): Program => {
  const p = compilePattern(pattern)
  if ('refused' in p) throw new Error(`${pattern}: ${p.refused}`)
  return p
}

/** Every match, as a `/gu` replace finds them: `start:end`. */
function ours(pattern: string, text: string): string[] {
  const p = program(pattern)
  const out: string[] = []
  const budget = budgetFor(text.length)
  for (let pos = 0; ; ) {
    const m = matchAt(p, text, pos, budget)
    if (m === undefined) return out
    out.push(`${m[0]}:${m[1]}`)
    pos = m[1]
  }
}

function theirs(pattern: string, text: string): string[] {
  return [...text.matchAll(new RegExp(pattern, 'gu'))].map(m => `${m.index}:${m.index + m[0].length}`)
}

describe('what a rule may be written with', () => {
  const OK = [
    '\\bW\\d{6}\\b', '\\bACC-\\d{4,10}\\b', 'a.c', '^start', 'end$', '\\Bx', '[A-Za-z_][\\w-]*', '[^\\s@]+@example\\.com', '\\t\\n\\r\\f\\v',
    '\\x41\\x7e', '\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\/\\\\\\^\\$', '[\\-\\]\\\\]', '(ab)+', '(?:ab|cd)*x', 'a{3}', 'a{2,}', 'a{2,5}', 'a+?b', 'a{2,5}?',
    'a*?b', 'x??y', '\\w+\\w+x', '(a+)+b', '(?:x|xy)*z', '\\d{1000}', 'é+', '😀{2}', '[^a]', '[\\d.-]', '(|a)b', '\\D\\W\\S',
  ]
  for (const p of OK) test(`takes ${p}`, () => expect('refused' in compilePattern(p)).toBe(false))

  // `undefined`: refused, whether by RegExp or by the parser (a newer RegExp may take what an older one refuses).
  const REFUSED: [string, string | undefined][] = [
    ['', 'the pattern is empty'],
    ['a'.repeat(301), 'the pattern is longer than 300 characters'],
    ['(?<id>a)', 'only (?: groups are allowed'],
    ['(?=a)b', 'only (?: groups are allowed'],
    ['(?<!a)b', 'only (?: groups are allowed'],
    ['(a)\\1', '\\1 is not allowed'],
    ['(?i)abc', undefined],
    ['(?i:a)bc', undefined],
    ['\\p{L}+', '\\p is not allowed'],
    ['\\u0041', '\\u is not allowed'],
    ['\\cA', '\\c is not allowed'],
    ['\\0', '\\0 is not allowed'],
    ['a{1001}', 'a count above 1000'],
    ['[\\b]x', '\\b in a class'],
    ['[]x', 'an empty class'],
    ['[^]x', 'an empty class'],
    ['a*', 'the pattern can match the empty string'],
    ['^$', 'the pattern can match the empty string'],
    ['\\b', 'the pattern can match the empty string'],
    ['a|', 'the pattern can match the empty string'],
    ['(?:a?)*b', 'a repeat of what can match the empty string'],
    ['(?:x{1000}){11}', 'the pattern is too large'],
    ['a{,3}', undefined],
    ['a]', "the pattern doesn't compile"],
    ['a)', "the pattern doesn't compile"],
    ['[z-a]', "the pattern doesn't compile"],
    ['a**', "the pattern doesn't compile"],
  ]
  for (const [p, why] of REFUSED) {
    test(`refuses ${p.length > 40 ? `${p.slice(0, 20)}...` : p || '(empty)'}${why === undefined ? '' : `: ${why}`}`, () => {
      const r = compilePattern(p)
      if (why === undefined) expect('refused' in r).toBe(true)
      else expect(r).toEqual({ refused: why })
    })
  }

  test(`a program is at most ${MAX_PROGRAM} instructions once its counts are written out`, () => {
    expect('refused' in compilePattern('(?:\\d{1000}-){9}')).toBe(false)
    expect(compilePattern('(?:\\d{1000}-){10}')).toEqual({ refused: 'the pattern is too large' })
  })
})

describe('the matches: those RegExp finds', () => {
  const CASES: [string, string][] = [
    ['\\bW\\d{6}\\b', 'worker W123456, not W1234567 or XW123456; W000001.'],
    ['\\bACC-\\d{4,10}\\b', 'ACC-123 ACC-1234 ACC-12345678901 (ACC-9999)'],
    ['a+?', 'aaa'],
    ['a{2,3}', 'aaaaaaa'],
    ['a{2,3}?', 'aaaaaaa'],
    ['(?:x|xy)*z', 'xyxz xxyz z'],
    ['(?:ab|a)(?:bc|c)', 'abc'],
    ['^\\w+', 'first second'],
    ['\\w+$', 'first second'],
    ['\\Bo\\B', 'foo boot o'],
    ['.+', 'line one\nline two\r\nthree four'],
    ['[^a-z]+', 'abcDEF123ghi😀é'],
    ['\\s+', 'a \t 　b﻿c'],
    ['\\S+', 'a \t 　b'],
    ['😀+', 'x😀😀y😀'],
    ['[😀-😂]', '😀😁😂😃'],
    ['.', '😀\ud800x'],
    ['\\d+\\.\\d+', 'v1.22 and 3.4.5'],
  ]
  for (const [p, text] of CASES) test(`${p} on ${JSON.stringify(text)}`, () => expect(ours(p, text)).toEqual(theirs(p, text)))

  test('random patterns of the allowed syntax on random text: the same matches as RegExp, every time', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!
    const ATOMS = ['a', 'b', 'x', '.', '\\d', '\\w', '\\s', '\\W', '[a-c]', '[^a]', '[\\d-]', '\\b', '\\B', '^', '$', '-', '\\.', '\\x41']
    const QUANTIFIERS = ['*', '+', '?', '{2}', '{1,3}', '{0,2}', '{2,}', '*?', '+?', '??', '{1,3}?']
    const gen = (d: number): string => {
      const r = rnd()
      if (d > 3 || r < 0.4) return pick(ATOMS)
      if (r < 0.55) return gen(d + 1) + gen(d + 1)
      if (r < 0.65) return `(?:${gen(d + 1)}|${gen(d + 1)})`
      if (r < 0.7) return `(${gen(d + 1)})`
      return `(?:${gen(d + 1)})${pick(QUANTIFIERS)}`
    }
    const CHARS = ['a', 'b', 'x', 'A', '1', ' ', '-', '.', '\n', 'é', '😀', '_']
    let compared = 0
    for (let n = 0; n < 3000; n++) {
      const p = gen(0) + gen(0)
      if ('refused' in compilePattern(p)) continue
      for (let t = 0; t < 3; t++) {
        let text = ''
        for (let k = Math.floor(rnd() * 16); k > 0; k--) text += pick(CHARS)
        expect([p, text, ours(p, text)]).toEqual([p, text, theirs(p, text)])
        compared++
      }
    }
    expect(compared).toBeGreaterThan(5000)
  })

  test('a character a marker holds is never part of a match', () => {
    const text = 'AB[REDACTED:x]CD'
    const blocked = new Uint8Array(text.length).fill(1, 2, 14)
    const p = program('[A-Z]+')
    const budget = budgetFor(text.length)
    expect(matchAt(p, text, 0, budget, blocked)).toEqual([0, 2])
    expect(matchAt(p, text, 2, budget, blocked)).toEqual([14, 16])
  })
})

describe('the cost of a scan', () => {
  const N = CONTENT_MAX_LENGTH
  /** Every match of `pattern` in `text`, with the steps the scan took, or `spent` where it spent its budget. */
  function scan(pattern: string, text: string): { matches: number; steps: number } | 'spent' {
    const p = program(pattern)
    const budget = budgetFor(text.length)
    const start = budget.left
    let matches = 0
    try {
      for (let pos = 0; ; ) {
        const m = matchAt(p, text, pos, budget)
        if (m === undefined) break
        matches++
        pos = m[1]
      }
    } catch (e) {
      if (e instanceof BudgetSpent) return 'spent'
      throw e
    }
    return { matches, steps: start - budget.left }
  }

  test(`a pattern that backtracks without end in RegExp runs in steps linear in the value: ${N} characters`, () => {
    // In RegExp, each of these tries every way to split the run of `a`s at each place it starts: the cube of the length and more.
    for (const p of ['\\w+\\w+x', '\\w+\\w+\\w+\\w+x', '(?:a+)+b', '(?:a|a)+b', '(?:\\w|\\d)+\\s{3}x']) {
      const half = scan(p, 'a'.repeat(N / 2))
      const whole = scan(p, 'a'.repeat(N))
      if (half === 'spent' || whole === 'spent') throw new Error(`${p} spent its budget`)
      expect([p, whole.matches]).toEqual([p, 0])
      // Twice the text, twice the steps (give or take the start): linear.
      expect([p, whole.steps / half.steps < 2.1]).toEqual([p, true])
      expect([p, whole.steps <= STEPS_PER_CHAR * N]).toEqual([p, true])
    }
  })

  test('a pattern whose threads are many at once spends its budget and stops: the scan throws, in bounded time', () => {
    for (const [p, text] of [['[a-z]{1000}x', 'a'.repeat(N)], ['\\d{1000}', '1'.repeat(N)], ['a{1,1000}a{1,1000}b', 'a'.repeat(N)]] as const) {
      const at = Date.now()
      expect([p, scan(p, text)]).toEqual([p, 'spent'])
      expect(Date.now() - at).toBeLessThan(2000)
    }
  })

  test('the same patterns on ordinary text cost little', () => {
    const prose = 'Ticket ACC-20391 for worker W123456: the quick brown fox jumps over the lazy dog. '.repeat(800).slice(0, N)
    for (const p of ['\\bW\\d{6}\\b', '\\bACC-\\d{4,10}\\b', '[a-z]{1000}x', '\\w+\\w+x', '[A-Z]+']) {
      const r = scan(p, prose)
      if (r === 'spent') throw new Error(`${p} spent its budget`)
      expect([p, r.steps < (STEPS_PER_CHAR / 4) * N]).toEqual([p, true])
    }
  })

  test(`the budget: ${STEPS_PER_CHAR} steps a character, at least ${MIN_STEPS}`, () => {
    expect(budgetFor(0).left).toBe(MIN_STEPS)
    expect(budgetFor(N).left).toBe(STEPS_PER_CHAR * N)
  })
})

describe('reading rules and the allow-list', () => {
  test("a rule's name: lowercase letters, digits and _, starting with a letter, at most 40", () => {
    for (const name of ['worker_id', 'a', 'acc2', 'x'.repeat(40)]) expect([name, 'refused' in compileRule({ name, pattern: 'x' })]).toEqual([name, false])
    for (const name of ['', 'Worker', '2acc', '_x', 'worker-id', 'worker.id', 'x'.repeat(41), 'é']) expect(compileRule({ name, pattern: 'x' })).toEqual({ refused: 'the name has not the shape' })
  })

  test('a list of rules: each { name, pattern }; nothing for none; anything else unreadable', () => {
    expect(rulesOf(undefined)).toBeUndefined()
    expect(rulesOf(null)).toBeUndefined()
    expect(rulesOf([])).toEqual([])
    expect(rulesOf([{ name: 'worker_id', pattern: '\\bW\\d{6}\\b', note: 'kept out' }])).toEqual([{ name: 'worker_id', pattern: '\\bW\\d{6}\\b' }])
    for (const bad of ['W\\d{6}', { worker_id: 'W\\d{6}' }, [{ name: 'a' }], [{ name: 'a', pattern: 1 }], ['a'], Array.from({ length: 51 }, (_, i) => ({ name: `r${i}`, pattern: 'x' }))]) {
      expect(rulesOf(bad)).toBe('unreadable')
    }
  })

  test('an allow-list: each entry trimmed and lowercased; an entry of the wrong shape left out, which redacts more', () => {
    expect([...allowListOf(['Support@Acme.example', '  W000000 ', '', ' ', 7, 'x'.repeat(257), 'support@acme.example'])]).toEqual(['support@acme.example', 'w000000'])
    expect([...allowListOf('support@acme.example')]).toEqual([])
    expect(allowListOf(Array.from({ length: 300 }, (_, i) => `e${i}`)).size).toBe(200)
  })
})
