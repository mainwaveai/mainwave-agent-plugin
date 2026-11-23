// Custom redaction rules: a name and a regular expression an organization (or a person, for their own sessions) adds beside the packs.
// Each rule runs as the pack `custom.<name>`, after the built-in packs (packs.ts). Pure: tests call it directly.
//
// A pattern is not run with JavaScript's `RegExp`. Its engine backtracks, so a pattern such as `\w+\w+x` can take time that grows with
// the cube of a value's length, and nothing can interrupt it. A rule is parsed here instead, by a parser that takes only the syntax
// Python's `re`, JavaScript's `RegExp` with the `u` flag and RE2 read alike, compiled to a small program, and run by a Pike VM: every
// thread of the match advances one character at a time, in lockstep, and two threads at the same instruction are one. So a scan does
// at most (the program's length) steps per character, whatever the pattern and the text. On top of that, a scan has a budget of steps
// per character (`STEPS_PER_CHAR`): a scan that spends it throws, and the value it was scanning is held back (gate.ts, `protectText`).
// A match is the one `RegExp` finds: the leftmost, and of those the one the pattern's order prefers (greedy or lazy quantifiers, the
// first alternative that matches).
//
// A rule the plugin can't use (a name of the wrong shape, a pattern that doesn't parse here or doesn't compile as a `RegExp` with the
// `u` flag, one that can match the empty string, one too long or whose program is too large) is reported as unusable, never skipped:
// the gate then holds identifier and content values back (gate.ts, `resolveRedaction`).

/** What a rule must look like: a name of lowercase letters, digits and `_`, starting with a letter, and a pattern. */
export const RULE_NAME = /^[a-z][a-z0-9_]{0,39}$/
/** The longest pattern a rule may have, in characters. */
export const MAX_PATTERN = 300
/** The most rules one source may give. */
export const MAX_RULES = 50
/** The largest count a quantifier may give (`{n}`, `{n,}`, `{n,m}`). */
export const MAX_COUNT = 1000
/**
 * The most instructions a rule's program may have, once its counted repeats are written out: enough for any pattern of 300 characters
 * whose nested counts multiply to at most 1,000 (`a{1,1000}` 33 times over is 66,000), as Mainwave's check allows. A scan's cost is
 * bounded by its budget whatever the program's size.
 */
export const MAX_PROGRAM = 70_000
/**
 * The steps the custom rules may take between them to scan one value, per character of it, and the steps they may take however short
 * the value. About 160 million steps run in a second, so a value of 61,440 characters costs the rules 50 ms at most.
 */
export const STEPS_PER_CHAR = 128
export const MIN_STEPS = 100_000
/** The most entries an allow-list may hold, and the longest entry. */
export const MAX_ALLOWED = 200
export const MAX_ALLOWED_LENGTH = 256

/** A rule as a source gives it. */
export type RuleSpec = { name: string; pattern: string }
/** A rule ready to run. */
export type Rule = { name: string; pattern: string; program: Program }
/** Thrown by a scan that spends its budget. */
export class BudgetSpent extends Error {}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Ranges of code points, sorted and not overlapping, as pairs `[lo, hi]`, both included. */
type Ranges = number[]
type Assertion = 'bol' | 'eol' | 'word' | 'nonword'
type Node =
  | { kind: 'set'; ranges: Ranges }
  | { kind: 'assert'; at: Assertion }
  | { kind: 'concat'; items: Node[] }
  | { kind: 'alt'; items: Node[] }
  | { kind: 'repeat'; item: Node; min: number; max: number; lazy: boolean }

const MAX_CP = 0x10ffff
const DIGIT: Ranges = [0x30, 0x39]
const WORD: Ranges = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a]
const SPACE: Ranges = [0x09, 0x0d, 0x20, 0x20, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff]
/** `.` with the `u` flag and without `s`: any code point but a line terminator. */
const DOT: Ranges = [0x00, 0x09, 0x0b, 0x0c, 0x0e, 0x2027, 0x202a, MAX_CP]
/** The characters a pattern must escape to mean them, outside a class. */
const SYNTAX = '^$\\.*+?()[]{}|/'

function normalize(r: Ranges): Ranges {
  const pairs: [number, number][] = []
  for (let i = 0; i < r.length; i += 2) pairs.push([r[i]!, r[i + 1]!])
  pairs.sort((a, b) => a[0] - b[0])
  const out: Ranges = []
  for (const [lo, hi] of pairs) {
    const n = out.length
    if (n > 0 && lo <= out[n - 1]! + 1) out[n - 1] = Math.max(out[n - 1]!, hi)
    else out.push(lo, hi)
  }
  return out
}

function negate(r: Ranges): Ranges {
  const n = normalize(r)
  const out: Ranges = []
  let next = 0
  for (let i = 0; i < n.length; i += 2) {
    if (n[i]! > next) out.push(next, n[i]! - 1)
    next = n[i + 1]! + 1
  }
  if (next <= MAX_CP) out.push(next, MAX_CP)
  return out
}

class Refused extends Error {}
const refuse = (why: string): never => {
  throw new Refused(why)
}

/** A pattern as a tree, or `Refused` with why: only the syntax the three engines read alike. */
function parse(pattern: string): Node {
  let i = 0
  const n = pattern.length
  const peek = () => pattern[i]
  const cp = (): number => {
    const c = pattern.codePointAt(i)!
    i += c > 0xffff ? 2 : 1
    return c
  }

  const hex2 = (): number => {
    const h = pattern.slice(i, i + 2)
    if (!/^[0-9A-Fa-f]{2}$/.test(h)) refuse('\\x needs two hex digits')
    i += 2
    return parseInt(h, 16)
  }

  /** An escape after `\`: a set of code points, an assertion (outside a class), or refused. */
  const escape = (inClass: boolean): Ranges | Assertion => {
    if (i >= n) refuse('a pattern may not end with \\')
    const c = pattern[i++]!
    switch (c) {
      case 'd': return DIGIT
      case 'D': return negate(DIGIT)
      case 'w': return WORD
      case 'W': return negate(WORD)
      case 's': return SPACE
      case 'S': return negate(SPACE)
      case 't': return [9, 9]
      case 'n': return [10, 10]
      case 'r': return [13, 13]
      case 'f': return [12, 12]
      case 'v': return [11, 11]
      case 'x': {
        const v = hex2()
        return [v, v]
      }
      case 'b':
        if (inClass) refuse('\\b in a class')
        return 'word'
      case 'B':
        if (inClass) refuse('\\B in a class')
        return 'nonword'
    }
    if (SYNTAX.includes(c) || (inClass && c === '-')) {
      const v = c.charCodeAt(0)
      return [v, v]
    }
    return refuse(`\\${c} is not allowed`)
  }

  const classAtom = (): { ranges: Ranges; single: number | undefined } => {
    if (pattern[i] === '\\') {
      i++
      const e = escape(true) as Ranges
      return { ranges: e, single: e.length === 2 && e[0] === e[1] ? e[0] : undefined }
    }
    const c = cp()
    if (c === 0x5b) refuse('[ in a class must be escaped')
    return { ranges: [c, c], single: c }
  }

  const klass = (): Node => {
    // After `[`.
    let negated = false
    if (peek() === '^') {
      negated = true
      i++
    }
    const ranges: Ranges = []
    let first = true
    for (;;) {
      if (i >= n) refuse('a class is not closed')
      if (peek() === ']' && !first) {
        i++
        break
      }
      if (peek() === ']') refuse('an empty class')
      first = false
      const a = classAtom()
      if (peek() === '-' && pattern[i + 1] !== ']' && i + 1 < n) {
        i++
        const b = classAtom()
        if (a.single === undefined || b.single === undefined) refuse('a range needs a character at each end')
        if (a.single! > b.single!) refuse('a range out of order')
        ranges.push(a.single!, b.single!)
      } else ranges.push(...a.ranges)
    }
    const r = normalize(ranges)
    return { kind: 'set', ranges: negated ? negate(r) : r }
  }

  const count = (): number => {
    const m = /^\d+/.exec(pattern.slice(i))
    if (m === null) return refuse('a count needs a number')
    i += m[0].length
    const v = Number(m[0])
    if (v > MAX_COUNT) refuse(`a count above ${MAX_COUNT}`)
    return v
  }

  const atom = (): Node => {
    const c = peek()!
    if (c === '(') {
      i++
      if (peek() === '?') {
        if (pattern[i + 1] !== ':') refuse('only (?: groups are allowed')
        i += 2
      }
      const inner = alternation()
      if (peek() !== ')') refuse('a group is not closed')
      i++
      return inner
    }
    if (c === '[') {
      i++
      return klass()
    }
    if (c === '.') {
      i++
      return { kind: 'set', ranges: DOT }
    }
    if (c === '^') {
      i++
      return { kind: 'assert', at: 'bol' }
    }
    if (c === '$') {
      i++
      return { kind: 'assert', at: 'eol' }
    }
    if (c === '\\') {
      i++
      const e = escape(false)
      return typeof e === 'string' ? { kind: 'assert', at: e } : { kind: 'set', ranges: e }
    }
    if (')]{}|*+?'.includes(c)) refuse(`${c} must be escaped here`)
    const v = cp()
    return { kind: 'set', ranges: [v, v] }
  }

  const repeat = (): Node => {
    const item = atom()
    const q = peek()
    let min: number
    let max: number
    if (q === '*') [min, max] = [0, Infinity]
    else if (q === '+') [min, max] = [1, Infinity]
    else if (q === '?') [min, max] = [0, 1]
    else if (q === '{') {
      i++
      min = count()
      max = min
      if (peek() === ',') {
        i++
        max = peek() === '}' ? Infinity : count()
      }
      if (peek() !== '}') refuse('a count is not closed')
      if (max < min) refuse('a count out of order')
    } else return item
    // Past the `*`, `+`, `?` or `}`.
    i++
    if (item.kind === 'assert') refuse('an assertion may not be repeated')
    // `RegExp` drops a pass of a loop that matched nothing, which a Pike VM can't do alike: a body that can match nothing may not vary
    // in how many times it repeats.
    if (max > min && nullable(item)) refuse('a repeat of what can match the empty string')
    let lazy = false
    if (peek() === '?') {
      lazy = true
      i++
    }
    const after = peek()
    if (after !== undefined && '*+?{'.includes(after)) refuse('a quantifier may not follow a quantifier')
    return { kind: 'repeat', item, min, max, lazy }
  }

  const sequence = (): Node => {
    const items: Node[] = []
    while (i < n && peek() !== '|' && peek() !== ')') items.push(repeat())
    return { kind: 'concat', items }
  }

  function alternation(): Node {
    const items = [sequence()]
    while (peek() === '|') {
      i++
      items.push(sequence())
    }
    return items.length === 1 ? items[0]! : { kind: 'alt', items }
  }

  const tree = alternation()
  if (i < n) refuse(`${peek()} must be escaped here`)
  return tree
}

/** Whether a tree can match the empty string. */
function nullable(node: Node): boolean {
  switch (node.kind) {
    case 'set': return false
    case 'assert': return true
    case 'concat': return node.items.every(nullable)
    case 'alt': return node.items.some(nullable)
    case 'repeat': return node.min === 0 || nullable(node.item)
  }
}

// ── Compiling ────────────────────────────────────────────────────────────────

const Op = { Set: 0, Split: 1, Jump: 2, Assert: 3, Match: 4 } as const
type Op = (typeof Op)[keyof typeof Op]
/**
 * A rule's program. Each instruction `k` has an op; a `Set` its ranges (`sets[k]`), an `Assert` its kind, a `Split` two targets, the
 * first preferred, a `Jump` one. `first` holds the code points a match can begin with, and `ascii` the same below 128, for skipping
 * ahead.
 */
export type Program = {
  ops: Uint8Array
  x: Int32Array
  y: Int32Array
  sets: (Ranges | undefined)[]
  /** Each `Set`'s code points below 128, one byte each. */
  setAscii: (Uint8Array | undefined)[]
  asserts: (Assertion | undefined)[]
  first: Ranges
  ascii: Uint8Array
  /** The threads' lists, kept between scans: a scan runs to its end before another begins. */
  scratch?: Scratch
}

type Scratch = { cpc: Int32Array; cstart: Int32Array; npc: Int32Array; nstart: Int32Array; mark: Uint32Array; gen: number; stack: Int32Array }

type Inst = { op: Op; x?: number; y?: number; set?: Ranges; at?: Assertion }

function emit(node: Node, out: Inst[]): void {
  if (out.length > MAX_PROGRAM) refuse('the pattern is too large')
  switch (node.kind) {
    case 'set':
      out.push({ op: Op.Set, set: node.ranges })
      return
    case 'assert':
      out.push({ op: Op.Assert, at: node.at })
      return
    case 'concat':
      for (const item of node.items) emit(item, out)
      return
    case 'alt': {
      // split L1, next; L1: a; jump end; next: split L2, ...; last: z; end:
      const jumps: Inst[] = []
      node.items.forEach((item, k) => {
        if (k < node.items.length - 1) {
          const split: Inst = { op: Op.Split, x: out.length + 1 }
          out.push(split)
          emit(item, out)
          const jump: Inst = { op: Op.Jump }
          out.push(jump)
          jumps.push(jump)
          split.y = out.length
        } else emit(item, out)
      })
      for (const j of jumps) j.x = out.length
      return
    }
    case 'repeat': {
      const { item, min, max, lazy } = node
      for (let k = 0; k < min; k++) emit(item, out)
      if (max === Infinity) {
        // L: split body, end; body; jump L; end:
        const at = out.length
        const split: Inst = { op: Op.Split }
        out.push(split)
        emit(item, out)
        out.push({ op: Op.Jump, x: at })
        const body = at + 1
        const end = out.length
        Object.assign(split, lazy ? { x: end, y: body } : { x: body, y: end })
        return
      }
      // Each optional copy: split body, end, where `end` is after every copy, so x{0,2} is (x(x)?)?.
      const splits: Inst[] = []
      for (let k = min; k < max; k++) {
        const split: Inst = { op: Op.Split, x: out.length + 1 }
        out.push(split)
        splits.push(split)
        emit(item, out)
      }
      const end = out.length
      for (const s of splits) {
        const body = s.x!
        Object.assign(s, lazy ? { x: end, y: body } : { x: body, y: end })
      }
      return
    }
  }
}

function assemble(insts: Inst[]): Program {
  const len = insts.length
  const ops = new Uint8Array(len)
  const x = new Int32Array(len)
  const y = new Int32Array(len)
  const sets: (Ranges | undefined)[] = new Array(len)
  const setAscii: (Uint8Array | undefined)[] = new Array(len)
  const asserts: (Assertion | undefined)[] = new Array(len)
  // A set repeated by a count is one array, written out once per copy: its table is made once.
  const tables = new Map<Ranges, Uint8Array>()
  insts.forEach((inst, k) => {
    ops[k] = inst.op
    x[k] = inst.x ?? 0
    y[k] = inst.y ?? 0
    sets[k] = inst.set
    if (inst.set !== undefined) {
      let table = tables.get(inst.set)
      if (table === undefined) tables.set(inst.set, (table = asciiOf(inst.set)))
      setAscii[k] = table
    }
    asserts[k] = inst.at
  })
  // What a match can begin with: every set reachable from the start without consuming, assertions passed over.
  const first: Ranges = []
  const seen = new Uint8Array(len)
  const stack = [0]
  while (stack.length > 0) {
    const pc = stack.pop()!
    if (seen[pc]) continue
    seen[pc] = 1
    const op = ops[pc]
    if (op === Op.Set) first.push(...sets[pc]!)
    else if (op === Op.Split) stack.push(x[pc]!, y[pc]!)
    else if (op === Op.Jump) stack.push(x[pc]!)
    else if (op === Op.Assert) stack.push(pc + 1)
    else refuse('the pattern can match the empty string')
  }
  const firstSet = normalize(first)
  return { ops, x, y, sets, setAscii, asserts, first: firstSet, ascii: asciiOf(firstSet) }
}

function asciiOf(r: Ranges): Uint8Array {
  const out = new Uint8Array(128)
  for (let c = 0; c < 128; c++) out[c] = inRanges(r, c) ? 1 : 0
  return out
}

function inRanges(r: Ranges, c: number): boolean {
  let lo = 0
  let hi = (r.length >> 1) - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (c < r[mid * 2]!) hi = mid - 1
    else if (c > r[mid * 2 + 1]!) lo = mid + 1
    else return true
  }
  return false
}

/** A pattern's program, or why it can't be one. */
export function compilePattern(pattern: string): Program | { refused: string } {
  if (typeof pattern !== 'string' || pattern.length === 0) return { refused: 'the pattern is empty' }
  if (pattern.length > MAX_PATTERN) return { refused: `the pattern is longer than ${MAX_PATTERN} characters` }
  try {
    // Anything `RegExp` would refuse is refused, whatever the parser below would make of it.
    new RegExp(pattern, 'u')
  } catch {
    return { refused: "the pattern doesn't compile" }
  }
  try {
    const tree = parse(pattern)
    if (nullable(tree)) return { refused: 'the pattern can match the empty string' }
    const insts: Inst[] = []
    emit(tree, insts)
    insts.push({ op: Op.Match })
    if (insts.length > MAX_PROGRAM) return { refused: 'the pattern is too large' }
    return assemble(insts)
  } catch (e) {
    if (e instanceof Refused) return { refused: e.message }
    return { refused: "the pattern can't be read" }
  }
}

const compiled = new Map<string, Program | { refused: string }>()

/** A rule ready to run, or why it can't be used. Compiled programs are kept by pattern, so a rule read again is not compiled again. */
export function compileRule(spec: RuleSpec): Rule | { refused: string } {
  if (typeof spec.name !== 'string' || !RULE_NAME.test(spec.name)) return { refused: 'the name has not the shape' }
  let program = compiled.get(spec.pattern)
  if (program === undefined) {
    program = compilePattern(spec.pattern)
    if (compiled.size >= 1000) compiled.clear()
    compiled.set(spec.pattern, program)
  }
  return 'refused' in program ? program : { name: spec.name, pattern: spec.pattern, program }
}

// ── Reading rules and the allow-list ─────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The rules a value of the rules option, or of an answer's `custom_rules`, gives: a list of `{ name, pattern }`. Unset (or `null`)
 * gives none; any other value, a list longer than `MAX_RULES`, or an item of another shape is `unreadable`. Each rule is checked in
 * `compileRule`, not here.
 */
export function rulesOf(raw: unknown): readonly RuleSpec[] | 'unreadable' | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) || raw.length > MAX_RULES) return 'unreadable'
  const out: RuleSpec[] = []
  for (const item of raw) {
    if (!isObject(item) || typeof item['name'] !== 'string' || typeof item['pattern'] !== 'string') return 'unreadable'
    out.push({ name: item['name'], pattern: item['pattern'] })
  }
  return out
}

/**
 * The entries of an allow-list (an answer's `allow_list`), each trimmed and lowercased, for comparing without case. An entry that is
 * not a string of 1 to `MAX_ALLOWED_LENGTH` characters, once trimmed, is left out, and so is every entry past `MAX_ALLOWED`; a value
 * that is not a list gives none. Leaving an entry out redacts more, never less.
 */
export function allowListOf(raw: unknown): ReadonlySet<string> {
  const out = new Set<string>()
  if (!Array.isArray(raw)) return out
  for (const item of raw.slice(0, MAX_ALLOWED)) {
    if (typeof item !== 'string') continue
    const v = item.trim()
    if (v.length >= 1 && v.length <= MAX_ALLOWED_LENGTH) out.add(v.toLowerCase())
  }
  return out
}

// ── Running ──────────────────────────────────────────────────────────────────

const isWord = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || (c >= 0x61 && c <= 0x7a)

/** A scan's budget of steps, shared by the rules that scan one text: spending it throws `BudgetSpent`. */
export type Budget = { left: number }
export const budgetFor = (length: number): Budget => ({ left: Math.max(MIN_STEPS, STEPS_PER_CHAR * length) })

/**
 * The first match of `program` in `text` at or after `from`, as `[start, end)`, or undefined: the leftmost, and the one the pattern
 * prefers there. No match takes a character `blocked` marks (a marker another rule wrote). Each thread step spends one of `budget`.
 */
export function matchAt(program: Program, text: string, from: number, budget: Budget, blocked?: Uint8Array): [number, number] | undefined {
  const { ops, x, y, sets, setAscii, asserts, ascii, first } = program
  const size = ops.length
  const len = text.length
  // The threads at the current position and the next: their instructions and where each match began, in order of preference.
  const s = (program.scratch ??= {
    cpc: new Int32Array(size),
    cstart: new Int32Array(size),
    npc: new Int32Array(size),
    nstart: new Int32Array(size),
    mark: new Uint32Array(size),
    gen: 0,
    stack: new Int32Array(size + 1),
  })
  let { cpc, cstart, npc, nstart } = s
  const { mark, stack } = s
  let ccount = 0
  let ncount = 0
  // The generation an instruction was last added in, one per position, kept between scans so none clears the marks.
  if (s.gen + len + 2 > 0xffffffff) {
    mark.fill(0)
    s.gen = 0
  }
  let gen = ++s.gen
  let found: [number, number] | undefined

  // Adds the thread at `pc` and what it reaches without consuming, in order of preference, to the list for position `pos`.
  const add = (toNext: boolean, pc0: number, start: number, pos: number) => {
    let sp = 0
    stack[sp++] = pc0
    while (sp > 0) {
      const pc = stack[--sp]!
      if (mark[pc] === gen) continue
      mark[pc] = gen
      budget.left--
      const op = ops[pc]
      if (op === Op.Jump) stack[sp++] = x[pc]!
      else if (op === Op.Split) {
        stack[sp++] = y[pc]!
        stack[sp++] = x[pc]!
      } else if (op === Op.Assert) {
        const prev = pos > 0 ? text.charCodeAt(pos - 1) : -1
        const next = pos < len ? text.charCodeAt(pos) : -1
        const at = asserts[pc]
        const ok =
          at === 'bol' ? pos === 0 : at === 'eol' ? pos === len : (isWord(prev) !== isWord(next)) === (at === 'word')
        if (ok) stack[sp++] = pc + 1
      } else if (toNext) {
        npc[ncount] = pc
        nstart[ncount++] = start
      } else {
        cpc[ccount] = pc
        cstart[ccount++] = start
      }
    }
  }

  let pos = from
  for (;;) {
    if (budget.left < 0) {
      s.gen = gen
      throw new BudgetSpent()
    }
    if (found === undefined) {
      if (ccount === 0) {
        // No match under way: skip to where one can begin.
        for (;;) {
          if (pos >= len) return ((s.gen = gen), undefined)
          const c = text.codePointAt(pos)!
          if (!(blocked?.[pos]) && (c < 128 ? ascii[c] === 1 : inRanges(first, c))) break
          pos += c > 0xffff ? 2 : 1
        }
      }
      // A match that begins here is preferred least.
      add(false, 0, pos, pos)
    }
    if (ccount === 0) {
      if (found !== undefined || pos >= len) return ((s.gen = gen), found)
      // An assertion failed where the match would begin: try the next position.
      pos += text.codePointAt(pos)! > 0xffff ? 2 : 1
      gen++
      continue
    }
    gen++
    ncount = 0
    const c = pos < len ? text.codePointAt(pos)! : -1
    const width = c > 0xffff ? 2 : 1
    const free = c >= 0 && !(blocked?.[pos])
    for (let k = 0; k < ccount; k++) {
      const pc = cpc[k]!
      budget.left--
      if (ops[pc] === Op.Match) {
        found = [cstart[k]!, pos]
        // Every thread after this one is preferred less.
        break
      }
      if (free && (c < 128 ? setAscii[pc]![c] === 1 : inRanges(sets[pc]!, c))) add(true, pc + 1, cstart[k]!, pos + width)
    }
    ;[cpc, npc] = [npc, cpc]
    ;[cstart, nstart] = [nstart, cstart]
    ccount = ncount
    if (c < 0) return ((s.gen = gen), found)
    pos += width
  }
}
