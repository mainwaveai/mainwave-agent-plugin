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
    expect(commandOutcomes('echo git push origin x')).toEqual({ counts: {}, refs: {} })
  })

  test('a separator a backslash escapes in a double-quoted string is none: the string is kept, as Mainwave keeps it', () => {
    // Kept whole, the string's `;` and `|` are command positions to Mainwave's rules, so they count; no ref is read past one.
    expect(commandOutcomes('echo "a\\; git push origin main"')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('grep "x\\|git commit -m" log')).toEqual({ counts: { commits: 1 }, refs: {} })
    expect(commandOutcomes('git commit -m "x\\; git merge secret word"')).toEqual({ counts: { commits: 1, merges: 1 }, refs: {} })
    expect(commandOutcomes('git commit -m "x\\; git push origin secret word"')).toEqual({ counts: { commits: 1, pushes: 1 }, refs: {} })
    expect(commandOutcomes('git commit -m "x\\; git tag secret"')).toEqual({ counts: { commits: 1, tags: 1 }, refs: {} })
    expect(commandOutcomes('echo a\\; git checkout -b secret')).toEqual({ counts: { branches_opened: 1 }, refs: {} })
    // An escaped backslash escapes no separator.
    expect(commandOutcomes('echo a\\\\; git push origin main')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
  })

  test('a ref is a word of the counted invocation alone: never of a quoted message, or of the next command or line', () => {
    expect(commandOutcomes('git commit -m "note git push origin hunter2" && git push')).toEqual({ counts: { commits: 1, pushes: 1 }, refs: {} })
    expect(commandOutcomes('git commit -m "see git tag s3cret-word" && git tag v1')).toEqual({ counts: { commits: 1, tags: 1 }, refs: { tag_name: 'v1' } })
    expect(commandOutcomes('git push && curl https://example.com')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('git push -f;echo a b')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('git push\norigin x')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('git tag\nv1')).toEqual({ counts: { tags: 1 }, refs: {} })
    expect(commandOutcomes('git checkout a\nfoo -b secret')).toEqual({ counts: { branches_opened: 1 }, refs: {} })
    // A later push's ref, where the first names none, is still a counted push's.
    expect(commandOutcomes('git push && git push origin v1')).toEqual({ counts: { pushes: 2 }, refs: { push_ref: 'v1' } })
  })

  test("a merge's ref is never its message: a value-taking flag's value is skipped, quoted words and all", () => {
    expect(commandOutcomes('git merge -m "fix the login" feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes("git merge --no-ff -m 'x y' feat/b")).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat/b' } })
    expect(commandOutcomes('git merge -F notes.txt feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes('git merge --strategy ours feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes('git merge -m "only a message"')).toEqual({ counts: { merges: 1 }, refs: {} })
  })

  test("a push's ref is past its flags and their values: never a word of a push option", () => {
    expect(commandOutcomes('git push -o merge_request.title="Fix the login" origin main')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
    expect(commandOutcomes('git push -o "ci.skip reason" origin main')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
    expect(commandOutcomes('git push --push-option "x y z" origin main')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
    expect(commandOutcomes('git push --push-opt "x y z" origin main')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
    expect(commandOutcomes('git push -uo "a b" origin main')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
    expect(commandOutcomes('git push --repo up --receive-pack rp --exec ex --recurse-submodules check origin main').refs).toEqual({ push_ref: 'main' })
    // A value attached to its flag takes no word.
    expect(commandOutcomes('git push -oci.skip --push-option=x origin main')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
    expect(commandOutcomes('git push -o "a b" origin')).toEqual({ counts: { pushes: 1 }, refs: {} })
  })

  test('a ref never starts at a separator, so no word of the next command is one', () => {
    expect(commandOutcomes('git push origin |grep password')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('git push origin ;curl secret-host')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('git tag |sort')).toEqual({ counts: { tags: 1 }, refs: {} })
    expect(commandOutcomes('git tag | grep v1')).toEqual({ counts: { tags: 1 }, refs: {} })
    expect(commandOutcomes('(cd api; git push origin main)')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
  })

  test("a merge's words are the shell's: an escaped space or quote, or a substitution, is part of its word", () => {
    expect(commandOutcomes('git merge -m message\\ with\\ spaces feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes('git merge -m "a \\" b c" feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes('git merge -m $(echo a b) feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes('git merge -m `echo a b` feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes('git merge -m "$(echo "a b")" feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    // A cluster whose last letter takes a value takes the next word; one with the value attached takes none.
    expect(commandOutcomes('git merge -vm "Merge the thing" feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes('git merge -em fix feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes('git merge -mfix feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes('git merge --cleanup strip --mess "x y" feat')).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    // An unterminated quote runs to the end of the text.
    expect(commandOutcomes('git merge -m "a b feat')).toEqual({ counts: { merges: 1 }, refs: {} })
  })

  test("a branch opener's ref is its branch flag's value, past the other flags' values", () => {
    expect(commandOutcomes('git worktree add --reason "why not" ../wt -b feat/w')).toEqual({ counts: { branches_opened: 1 }, refs: { branch_opened: 'feat/w' } })
    expect(commandOutcomes('git checkout "x -b y"')).toEqual({ counts: { branches_opened: 1 }, refs: {} })
    expect(commandOutcomes('git switch -c "two words"')).toEqual({ counts: { branches_opened: 1 }, refs: {} })
  })

  test("a ref is sent only with a git ref's shape, bare or wrapped whole in one pair of quotes", () => {
    const pushed = (ref: string) => commandOutcomes(`git push origin ${ref}`).refs.push_ref
    for (const ref of ['main', 'HEAD:refs/heads/feat/y', '+feat/x', 'v1.2.0', 'feat/café', '$b', '${BR}', '"main"', "'main'", 'a'.repeat(256)]) {
      expect(pushed(ref)).toBe(ref)
    }
    for (const ref of ['$(git rev-parse HEAD)', '`whoami`', 'main\\ x', 'main"', '"main', 'a"b"', '"a b"', 'HEAD~1', 'HEAD^', 'a*', 'a>b', 'a<b', '$$', 'a'.repeat(257)]) {
      expect(pushed(ref)).toBeUndefined()
    }
    // Each with its count still.
    expect(commandOutcomes('git push origin $(git rev-parse HEAD)').counts).toEqual({ pushes: 1 })
  })

  test('a newline or a body keyword before a command, as Mainwave reads it, whatever the spaces around them', () => {
    expect(commandOutcomes('\n\n  \n do  \n then git commit').counts).toEqual({ commits: 1 })
    expect(commandOutcomes('do\ngit push origin a')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'a' } })
    expect(commandOutcomes('rtk\nproxy git push origin a')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'a' } })
    expect(commandOutcomes('git checkout a\ngit status\nx -b y').counts).toEqual({ branches_opened: 1 })
    expect(commandOutcomes('git switch a\ngit checkout b && x -b y').counts).toEqual({})
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

  test('reads a megabyte of spaces, newlines, body keywords, backslashes or branch commands in time linear in it', () => {
    const mb = 1 << 20
    const inputs = [
      '\n'.repeat(mb),
      ' \n\t\r\n'.repeat(mb / 5),
      '\ndo'.repeat(mb / 3),
      '\nrtk'.repeat(mb / 4),
      '\\'.repeat(mb),
      `"${'\\'.repeat(mb)}`,
      `printf "${'x\\n'.repeat(mb / 3)}" > f`,
      'git checkout a\n'.repeat(mb / 15),
      'git switch a\n'.repeat(mb / 13),
    ]
    const started = Date.now()
    for (const input of inputs) commandOutcomes(input)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("reads a megabyte of a ref's words, however they nest, quote, escape or repeat, in time linear in it", () => {
    const mb = 1 << 20
    const inputs = [
      `git push ${'$(;git push '.repeat(mb / 11)}`,
      `git tag ${'`;git tag '.repeat(mb / 9)}`,
      `git push -o ${'"\\;git push -o '.repeat(mb / 15)}`,
      `git merge -m ${'"a\\" '.repeat(mb / 6)}`,
      `git merge ${'-m '.repeat(mb / 3)}`,
      `git push ${'-uo '.repeat(mb / 4)}`,
      'git push -f;'.repeat(mb / 12),
      'git push a\\;'.repeat(mb / 12),
      `${'\\'.repeat(mb)};git push origin main`,
      `git checkout ${'--orphan x '.repeat(mb / 11)}`,
      'git switch -c "a\\; '.repeat(mb / 18),
      `git push origin ${'${'.repeat(mb / 2)}`,
      `git push origin "${'$('.repeat(mb / 2)}`,
      'git tag v\\|'.repeat(mb / 10),
      'git checkout -q '.repeat(mb / 16),
      'git worktree add -b\n'.repeat(mb / 20),
    ]
    const started = Date.now()
    for (const input of inputs) commandOutcomes(input)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
