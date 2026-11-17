// What a shell command did, by Mainwave's rules, against the cases Mainwave's rules pass: tests/fixtures/command-outcomes.json is a
// byte copy of Mainwave's, read through its twin (scripts/check-vendored.sh). A case changes only when Mainwave's rules do.

import { describe, expect, test } from 'claude-code/testing'

import { COMMAND_COUNTS, COMMAND_REFS, commandOutcomes, executableText } from '../hooks/derive.ts'
import fixture from './fixtures/command-outcomes.ts'

type Case = { name: string; command: string; outcomes: Record<string, number>; refs: Record<string, string> }
const { _meta: meta, cases } = fixture as unknown as { _meta: { columns: Record<string, string>; ref_names: Record<string, string> }; cases: Case[] }

describe("Mainwave's cases", () => {
  test('name the same counts and refs the plugin computes, and each case once', () => {
    expect(Object.keys(meta.columns)).toEqual([...COMMAND_COUNTS])
    expect(Object.keys(meta.ref_names)).toEqual(Object.keys(COMMAND_REFS))
    expect(new Set(cases.map(c => c.name)).size).toBe(cases.length)
    expect(cases.length).toBeGreaterThan(50)
  })

  for (const c of cases) {
    test(c.name, () => {
      expect(commandOutcomes(c.command)).toEqual({ counts: c.outcomes, refs: c.refs })
    })
  }
})

describe('commandOutcomes, beyond the cases', () => {
  test('a search after a match starts as a new string: a bare commit ending a line leaves the next line a command', () => {
    // The first match takes the newline; Mainwave's count starts the next search as a new string, where `^` matches again.
    expect(commandOutcomes('git commit\ngit commit\ngit commit').counts).toEqual({ commits: 3 })
  })

  test('a heredoc of any upper-case tag is data, ending at the first bare upper-case line', () => {
    expect(executableText("cat <<'SQL' > q.sql\ngit push\nSQL\ngit push")).toBe('cat _ > q.sql\ngit push')
    expect(commandOutcomes('cat <<END\ngit push\nEND\ngit commit -m x').counts).toEqual({ commits: 1 })
    // A heredoc with no terminator line is left as it is, and a here-string is no heredoc.
    expect(executableText('cat <<EOF\ngit push')).toBe('cat <<EOF\ngit push')
    expect(executableText('cat <<<EOF\nx\nEOF')).toBe('cat <<<EOF\nx\nEOF')
  })

  test("a heredoc opener's line runs past a newline inside its quoted strings, and the body starts after it", () => {
    // The heredoc pass keeps `"a\nb"` on the opener's line; the quoted-string pass then cuts it, as it holds a newline.
    expect(executableText('cat <<EOF > "a\nb" && git push\nbody\nEOF\ngit tag v1')).toBe('cat _ > " && git push\ngit tag v1')
  })

  test('a fast-forward of remote-tracking refs is a sync, whatever its redirects; anything else is a merge', () => {
    expect(commandOutcomes('git merge --ff-only @{u} 2>&1').counts).toEqual({})
    expect(commandOutcomes('git merge --ff-only > /dev/null origin/main').counts).toEqual({})
    expect(commandOutcomes('git merge --ff-only').counts).toEqual({})
    expect(commandOutcomes('git merge origin/main').counts).toEqual({ merges: 1 })
    expect(commandOutcomes('git merge --ff-only origin/main feat/a')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'origin/main' } })
  })

  test('the ref named is the last merge that is not a sync', () => {
    expect(commandOutcomes('git merge feat/a && git merge --ff-only origin/main && git merge feat/b').refs).toEqual({ merge_ref: 'feat/b' })
  })

  test('a ref goes only beside its count', () => {
    // The push ref pattern reads past an echo, but the echo is no push: with no push counted, no ref.
    expect(commandOutcomes('echo git push origin x')).toEqual({ counts: {}, refs: {} })
  })

  test('reads in time linear in the command, however it is built', () => {
    const inputs = [
      `"${'a;'.repeat(200_000)}`,
      `x<<SHIFT ${"'a' ".repeat(20_000)}`,
      `cat <<EOF\n${'git push\n'.repeat(20_000)}`,
      `"${'\\"'.repeat(100_000)}`,
      `git merge --ff-only ${'> '.repeat(60)}foo bar`,
      `git checkout ${'a '.repeat(50_000)}`,
    ]
    const started = Date.now()
    for (const input of inputs) commandOutcomes(input)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})
