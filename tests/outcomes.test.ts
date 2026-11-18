// What a shell command did, by Mainwave's rules, against the cases Mainwave's rules pass: tests/fixtures/command-outcomes.json is a
// byte copy of Mainwave's, read through its twin (scripts/check-vendored.sh). A case changes only when Mainwave's rules do.

import { describe, expect, test } from 'claude-code/testing'

import { COMMAND_COUNTS, COMMAND_REFS, commandOutcomes, executableText } from '../hooks/derive.ts'
import fixture from './fixtures/command-outcomes.ts'

type Case = { name: string; command: string; outcomes: Record<string, number>; refs: Record<string, string> }
const { _meta: meta, cases } = fixture as unknown as { _meta: { columns: Record<string, string>; ref_names: Record<string, string> }; cases: Case[] }

/**
 * How many times longer reading the inputs `build` makes at `size` takes than at a quarter of it: about 4 where reading is linear, 16
 * where it is quadratic. A ratio, not a time, so a slower machine changes nothing; the quarter runs first, so warming up only lowers it.
 */
function growth(build: (size: number) => readonly string[], size: number): number {
  const time = (n: number) => {
    const inputs = build(n)
    const started = Date.now()
    for (const input of inputs) commandOutcomes(input)
    return Date.now() - started
  }
  const quarter = time(size / 4)
  return time(size) / Math.max(quarter, 1)
}

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

  test("a quoted string cut for its separator leaves the strings after it paired as the shell pairs them: no word of a message is a ref", () => {
    const push = (cmd: string) => expect(commandOutcomes(cmd)).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
    push('git push -o merge_request.create -o merge_request.title="Fix login & signup" -o merge_request.description="Fixes the login bug for acme" origin main')
    push('git push -o "title=A & B" -o "desc=launch plan for acme" origin main')
    push("git push -o 'ci.skip; x' -o 'merge_request.description=the secret plan here' origin main")
    push('git push -o "a | b" -o "c\nd" -o "one two three four" origin main')
    const merge = (cmd: string) => expect(commandOutcomes(cmd)).toEqual({ counts: { merges: 1 }, refs: { merge_ref: 'feat' } })
    merge('git merge --no-ff -m "Merge feat; closes #12" -m "Reviewed by alice and bob" feat')
    merge('git merge -m "multi\nline" -m "second para words here" feat')
    merge('git merge -m "Merge feat\n\nbody" -m "second para words here" feat')
    expect(commandOutcomes('git merge -m "a; b" feat && git push origin "x y z w"')).toEqual({ counts: { merges: 1, pushes: 1 }, refs: { merge_ref: 'feat' } })
    expect(commandOutcomes('git checkout -q "a; b" -b "c d e" feat')).toEqual({ counts: { branches_opened: 1 }, refs: {} })
  })

  test('a redirect, with its target attached or as the next word, is no argument, before the remote or after it', () => {
    const pushed = (cmd: string) => commandOutcomes(cmd).refs.push_ref
    for (const cmd of [
      'git push > /tmp/push.log origin main',
      'git push >log origin main',
      'git push >> log origin main',
      'git push 2>&1 origin main',
      'git push 2> err origin main',
      'git push 2>err origin main',
      'git push &>/dev/null origin main',
      'git push &> log origin main',
      'git push < /dev/null origin main',
      'git push >| log origin main',
      'git push origin > log main',
      'git push origin main 2>&1',
    ]) {
      expect(pushed(cmd)).toBe('main')
    }
    expect(commandOutcomes('git tag 2>/dev/null v1').refs).toEqual({ tag_name: 'v1' })
    expect(commandOutcomes('git merge < /dev/null feat').refs).toEqual({ merge_ref: 'feat' })
    expect(commandOutcomes('git checkout > log -b feat').refs).toEqual({ branch_opened: 'feat' })
    expect(commandOutcomes('git checkout -b > log feat').refs).toEqual({ branch_opened: 'feat' })
    // A redirect's `&` ends no command, and a background `&` still does.
    expect(commandOutcomes('git push 2>&1 | tail')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('git push origin & echo a b')).toEqual({ counts: { pushes: 1 }, refs: {} })
    // A quoted operator is a word.
    expect(pushed('git push ">" main')).toBe('main')
  })

  test('no ref is read past a heredoc the rules leave in place, or from a command with an ANSI-C string holding an escaped quote; counts stay', () => {
    expect(commandOutcomes('cat <<msg\ngit push origin hunter2\nmsg')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('git commit -F- <<end\nfix stuff\ngit tag s3cret\nend')).toEqual({ counts: { commits: 1, tags: 1 }, refs: {} })
    expect(commandOutcomes("git commit -F- <<'Msg'\nfix\ngit merge secretword\nMsg")).toEqual({ counts: { commits: 1, merges: 1 }, refs: {} })
    expect(commandOutcomes('cat <<EOF\ngit push origin main')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes("echo $'it\\'s; git push origin hunter2 '")).toEqual({ counts: { pushes: 1 }, refs: {} })
    // Before the heredoc, refs are read; a merge's is the last one's, so one in the body leaves none.
    expect(commandOutcomes('git push origin main && cat <<msg\nx\nmsg')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
    expect(commandOutcomes('git merge feat && cat <<msg\ngit merge s3cret\nmsg')).toEqual({ counts: { merges: 2 }, refs: {} })
    // A heredoc the rules cut, and an ANSI-C string with no escaped quote, take nothing away.
    expect(commandOutcomes("cat <<'EOF' > f\nx\nEOF\ngit push origin main")).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
    expect(commandOutcomes("git commit -m $'a\\nb' && git push origin main")).toEqual({ counts: { commits: 1, pushes: 1 }, refs: { push_ref: 'main' } })
  })

  test("no ref is read from a heredoc the rules end where the shell does not; counts stay as the rules read them", () => {
    // A bare upper-case line ends a non-EOF tag's body by the rules, but not the shell's.
    expect(commandOutcomes("git commit -F - <<'MSG'\nfix\nWHERE\ngit merge conflicts were painful\nMSG")).toEqual({ counts: { commits: 1, merges: 1 }, refs: {} })
    expect(commandOutcomes("git commit -F - <<'MSG'\nAdd query\n\nSELECT\n  count()\nFROM t\n\ngit push origin release-candidate\nMSG")).toEqual({ counts: { commits: 1, pushes: 1 }, refs: {} })
    expect(commandOutcomes("git commit -F - <<'MSG'\nfix\nTODO\ngit checkout -b hunter2\nMSG")).toEqual({ counts: { commits: 1, branches_opened: 1 }, refs: {} })
    expect(commandOutcomes("gh pr create --body \"$(cat <<'BODY'\n## Test\n```sql\nSELECT\n  count()\nFROM t\n```\ngit push origin secret-word\nBODY\n)\"")).toEqual({ counts: { prs_opened: 1 }, refs: {} })
    // A tag line with blanks around it ends the body by the rules; the shell takes only the tag, after tabs where `<<-` opens it.
    expect(commandOutcomes('cat <<EOF > f\n  EOF\ngit push origin secret\nEOF')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('cat <<EOF > f\nEOF \ngit tag s3cret\nEOF')).toEqual({ counts: { tags: 1 }, refs: {} })
    expect(commandOutcomes('cat <<EOF > f\n\tEOF\ngit push origin secret\nEOF')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('cat <<-EOF > f\n\tbody\n\tEOF\ngit push origin main')).toEqual({ counts: { pushes: 1 }, refs: { push_ref: 'main' } })
    expect(commandOutcomes('cat <<-EOF > f\n  EOF\ngit push origin secret\nEOF')).toEqual({ counts: { pushes: 1 }, refs: {} })
    // A quote opened on the opener's line runs the rules' line into the body.
    expect(commandOutcomes("cat <<EOF > notes.txt # it's\nline1\ngit push origin secret\nit's done\nEOF")).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes("git commit -F - <<EOF # Tyler's msg\nsubject\ngit merge secretword\ndon't\nEOF\n")).toEqual({ counts: { commits: 1, merges: 1 }, refs: {} })
    // A tag the shell reads as a longer word, or with unpaired quotes, has another terminator.
    expect(commandOutcomes('cat <<EOF-x\nEOF\ngit push origin secret\nEOF-x')).toEqual({ counts: { pushes: 1 }, refs: {} })
    expect(commandOutcomes('cat <<\'EOF"\nEOF\ngit push origin secret\nEOF')).toEqual({ counts: { pushes: 1 }, refs: {} })
    // Where the shell ends the body at the same line, refs after it are read.
    expect(commandOutcomes("git commit -m \"$(cat <<'EOF'\nfix: a\n\nWHY\nEOF\n)\" && git push -u origin feat/x")).toEqual({ counts: { commits: 1, pushes: 1 }, refs: { push_ref: 'feat/x' } })
    expect(commandOutcomes("git commit -F - <<'MSG'\nfix\nMSG\ngit push origin main")).toEqual({ counts: { commits: 1, pushes: 1 }, refs: { push_ref: 'main' } })
    expect(commandOutcomes('cat <<EOF >f; git tag v1\nbody\nEOF')).toEqual({ counts: { tags: 1 }, refs: { tag_name: 'v1' } })
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

  test('reads in time linear in the command, however it is built', { timeoutMs: 60_000 }, () => {
    const build = (k: number) => [
      `"${'a;'.repeat(200_000 * k)}`,
      `x<<SHIFT ${"'a' ".repeat(20_000 * k)}`,
      `cat <<EOF\n${'git push\n'.repeat(20_000 * k)}`,
      `"${'\\"'.repeat(100_000 * k)}`,
      `git merge --ff-only ${'> '.repeat(60 * k)}foo bar`,
      `git checkout ${'a '.repeat(50_000 * k)}`,
    ]
    expect(growth(build, 4)).toBeLessThan(8)
  })

  test('reads a megabyte of spaces, newlines, body keywords, backslashes or branch commands in time linear in it', { timeoutMs: 60_000 }, () => {
    const build = (mb: number) => [
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
    expect(growth(build, 1 << 20)).toBeLessThan(8)
  })

  test("reads a megabyte of a ref's words, however they nest, quote, escape or repeat, in time linear in it", { timeoutMs: 60_000 }, () => {
    const build = (mb: number) => [
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
      `git push ${'> '.repeat(mb / 2)}`,
      `git push ${'2>&'.repeat(mb / 3)}`,
      `git merge -m ${'"a;b" '.repeat(mb / 6)}`,
      `echo ${"$'\\".repeat(mb / 3)}`,
      `${'<<a '.repeat(mb / 4)}`,
      `git push origin ${'"a;b"'.repeat(mb / 5)}`,
      `${'x <<A '.repeat(mb / 6)}\nB\n`,
      `git push origin a ${"<<'MSG'\nWHERE\n".repeat(mb / 14)}`,
      `${"cat <<EOF # it's\n  EOF\n".repeat(mb / 22)}`,
      `cat <<${'A'.repeat(mb / 2)}\n${'A'.repeat(mb / 2 - 1)}B\n`,
    ]
    expect(growth(build, 1 << 20)).toBeLessThan(8)
  })
})
