// The rules Claude Code applies when it fills in a span's or a metric's attributes, rebuilt from what a plugin sees: the tool's name
// and input, a request's query source, a file tool's result, a Bash command. Pure: tests call them directly.
//
// Each rule follows Claude Code's own (version 2.1.322) as closely as plain code can. Where Claude Code parses with a full shell
// grammar or a syntax highlighter's tables, the rule here is a smaller one that agrees on common input; README, What it lacks, says
// which.

/** A value Claude Code accepts as a short label on a span: letters, digits, `_`, `.`, `-`, at most 64. */
const LABEL = /^[A-Za-z0-9_.-]{1,64}$/

/** `anthropic.provider` as `gen_ai.provider.name` names it; undefined for a provider Claude Code does not map. */
export function genAiProvider(provider: unknown): string | undefined {
  switch (provider) {
    case 'bedrock':
    case 'mantle':
      return 'aws.bedrock'
    case 'vertex':
      return 'gcp.vertex_ai'
    case 'firstParty':
    case 'anthropicAws':
    case 'anthropicGoogleCloud':
    case 'foundry':
    case 'gateway':
      return 'anthropic'
    default:
      return undefined
  }
}

/** What Claude Code accepts as a failed tool run's `error_class`: a name of at most 48 letters, digits and `_`. */
const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_]{0,47}$/

/**
 * A failed tool run's `error_class`, from the error's class as the call's `tool_result` row names it (`error_type`): each character
 * other than a letter, a digit or `_` made `_`, and left off unless it then fits.
 */
export function errorClassOf(errorType: unknown): string | undefined {
  if (typeof errorType !== 'string') return undefined
  const cleaned = errorType.replace(/[^A-Za-z0-9_]/g, '_')
  return ERROR_CLASS.test(cleaned) ? cleaned : undefined
}

/** A request's query source as metrics count it: the main loop, a subagent's, or anything else. */
export function metricQuerySource(querySource: unknown): 'main' | 'subagent' | 'auxiliary' | undefined {
  if (typeof querySource !== 'string') return undefined
  if (querySource.startsWith('repl_main_thread') || querySource === 'sdk') return 'main'
  if (querySource.startsWith('agent:') || querySource === 'hook_agent') return 'subagent'
  return 'auxiliary'
}

/** A request's query source as `llm_request` spans carry it (`query_source_safe`): custom agents folded, `:` as `.`. */
export function querySourceSafe(querySource: unknown): string | undefined {
  if (typeof querySource !== 'string') return undefined
  const folded = querySource.startsWith('agent:custom:') ? 'agent:custom' : querySource
  const safe = folded.replaceAll(':', '.')
  return LABEL.test(safe) ? safe : undefined
}

/** An MCP tool's name split as Claude Code splits it: `mcp__<server>__<tool>`. */
export function mcpParts(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const [, server, ...rest] = name.split('__')
  if (!server || rest.length === 0) return undefined
  return { server, tool: rest.join('__') }
}

/** `tool_name_safe`: a built-in tool's name as it is, an MCP tool's as `mcp_other` (Playwright's browser tools excepted), else `other`. */
export function toolNameSafe(name: string): string {
  const mcp = mcpParts(name)
  if (name.startsWith('mcp__')) {
    return mcp?.server === 'playwright' && /^browser_[a-z_]{1,40}$/.test(mcp.tool) && LABEL.test(name) ? name : 'mcp_other'
  }
  return !name.includes('__') && LABEL.test(name) ? name : 'other'
}

// ── Bash ──────────────────────────────────────────────────────────────────────

/** The programs Claude Code sorts a command's first word into, by class. */
const CLASSES: Readonly<Record<string, readonly string[]>> = {
  vcs: ['git', 'hg', 'svn'],
  github_cli: ['gh'],
  network: ['curl', 'wget', 'ssh', 'scp', 'rsync', 'ping', 'nc', 'dig', 'nslookup'],
  lang_runtime: ['python', 'node', 'bun', 'deno', 'ruby', 'perl', 'php', 'java', 'Rscript', 'swift', 'tsx', 'ts-node', 'bash', 'sh', 'zsh', 'pwsh'],
  package_manager: ['npm', 'npx', 'bunx', 'pip', 'uv', 'uvx', 'poetry', 'yarn', 'pnpm', 'cargo', 'go', 'gradle', 'gradlew', 'mvn', 'nuget', 'brew', 'apt', 'apt-get', 'apk', 'conda', 'gem', 'composer', 'nix', 'nix-shell', 'nix-build', 'nix-env'],
  build_test: ['make', 'cmake', 'bazel', 'tsc', 'jest', 'vitest', 'pytest', 'eslint', 'prettier', 'ruff', 'mypy', 'vite', 'webpack', 'nx', 'turbo', 'xcodebuild', 'dotnet', 'msbuild', 'gcc', 'clang', 'rustc'],
  file_read: ['cat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'strings', 'od', 'hexdump', 'xxd', 'base64', 'sha256sum', 'sha1sum', 'md5sum', 'shasum', 'diff', 'cmp', 'comm', 'readlink', 'realpath', 'basename', 'dirname'],
  file_search: ['ls', 'find', 'fd', 'tree', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'which', 'whereis', 'locate', 'du'],
  text_transform: ['sed', 'awk', 'gawk', 'jq', 'yq', 'cut', 'tr', 'sort', 'uniq', 'paste', 'column', 'fold', 'fmt', 'rev', 'tac', 'nl', 'expand', 'unexpand', 'numfmt', 'iconv', 'xargs'],
  fs_mutation: ['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'ln', 'chmod', 'chown', 'chgrp', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'tee', 'install', 'truncate', 'patch'],
  shell_builtin: ['echo', 'printf', 'cd', 'pwd', 'export', 'source', 'true', 'false', 'test', 'sleep', 'date', 'env', 'set', 'unset', 'read', 'exit', 'wait', 'eval', 'exec', 'trap', 'alias', 'type', 'seq', 'yes', 'printenv'],
  process_system: ['ps', 'pgrep', 'pkill', 'kill', 'killall', 'lsof', 'netstat', 'ss', 'df', 'free', 'uname', 'id', 'whoami', 'hostname', 'uptime', 'nproc', 'top', 'htop', 'timeout', 'nohup', 'sudo', 'time', 'watch', 'crontab', 'systemctl', 'ulimit'],
  container_infra: ['docker', 'docker-compose', 'podman', 'kubectl', 'helm', 'terraform', 'aws', 'gcloud', 'gsutil', 'az', 'vercel', 'flyctl', 'heroku'],
  document_media: ['libreoffice', 'soffice', 'pandoc', 'ffmpeg', 'ffprobe', 'convert', 'magick', 'pdftotext', 'qpdf'],
  db_client: ['sqlite3', 'psql', 'mysql', 'mongosh', 'redis-cli', 'duckdb'],
  claude_cli: ['claude'],
}
const CLASS_OF = new Map<string, string>(Object.entries(CLASSES).flatMap(([cls, programs]) => programs.map(p => [p, cls] as const)))
const ALIASES: Readonly<Record<string, string>> = { python3: 'python', python2: 'python', pip3: 'pip', nodejs: 'node', gmake: 'make', gsed: 'sed', ggrep: 'grep', '.': 'source' }
/** Commands that run another command, and their flags that take a value. */
const WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  sudo: ['-u', '-g', '-U', '-p', '-C', '-D', '-h', '-r', '-t'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '--unset', '--chdir'],
  time: ['-f', '-o', '--format', '--output'],
  nice: ['-n', '--adjustment'],
  nohup: [],
  timeout: ['-k', '-s', '--kill-after', '--signal'],
  command: [],
  builtin: [],
  noglob: [],
  xargs: ['-n', '-I', '-P', '-d', '-L', '-s', '-a', '-E', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--replace'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  caffeinate: ['-w', '-t'],
}
const ASSIGNMENT = /^[A-Za-z_]\w*=/
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const baseName = (word: string) => word.slice(word.lastIndexOf('/') + 1)

/** The first simple command of a command line: up to the first `;`, `&`, `|` or newline outside quotes. */
export function firstCommand(command: string): string | undefined {
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '\\') i++
    else if (c === '"' || c === "'") quote = c
    else if (c === ';' || c === '&' || c === '|' || c === '\n') return command.slice(0, i)
  }
  return quote ? undefined : command
}

/** The words of a simple command past its variable assignments and up to four wrappers (`sudo`, `env`, `timeout 5` and so on). */
function programWords(text: string): string[] {
  let words = text.trim().split(/\s+/).filter(Boolean)
  while (words.length > 0 && ASSIGNMENT.test(words[0]!)) words = words.slice(1)
  for (let n = 0; n < 4; n++) {
    const wrapper = words[0] === undefined ? undefined : baseName(words[0])
    const flags = wrapper !== undefined && has(WRAPPERS, wrapper) ? WRAPPERS[wrapper]! : undefined
    if (flags === undefined || words.length < 2) break
    let i = 1
    while (i < words.length) {
      const w = words[i]!
      if (w === '--') {
        i++
        break
      }
      if (flags.includes(w)) i += 2
      else if (w.startsWith('-') || ASSIGNMENT.test(w)) i++
      else if ((wrapper === 'timeout' || wrapper === 'nice') && /^[0-9.]+[smhd]?$/.test(w)) i++
      else break
    }
    if (i >= words.length) break
    words = words.slice(i)
  }
  return words
}

/**
 * `bash_command_class` and `bash_argv0` for a Bash command: the class and name of the program its first simple command runs, both
 * `other` for a program Claude Code does not list, both `unparsed` for a command it could not read.
 */
export function bashClass(command: string): { bash_command_class: string; bash_argv0: string } {
  const first = firstCommand(command)
  if (first === undefined || command.length > 10_000) return { bash_command_class: 'unparsed', bash_argv0: 'other' }
  const word = programWords(first)[0]
  if (word === undefined) return { bash_command_class: 'other', bash_argv0: 'other' }
  const base = baseName(word)
  const name = (has(ALIASES, base) ? ALIASES[base] : undefined) ?? (/^python[0-9.]+$/.test(base) ? 'python' : /^pip[0-9.]+$/.test(base) ? 'pip' : base)
  const cls = CLASS_OF.get(name)
  return cls === undefined ? { bash_command_class: 'other', bash_argv0: 'other' } : { bash_command_class: cls, bash_argv0: name }
}

/** A git subcommand anywhere in a command line, past `-c x` and `--flag=value` options. */
const gitVerb = (verb: string) => new RegExp(String.raw`\bgit(?:\s+-[cC]\s+\S+|\s+--[^\s=]+=\S+)*\s+${verb}\b`)
const COMMIT = gitVerb('commit')
const GH_PR_CREATE = /\bgh\s+pr\s+create\b/
const GLAB_MR_CREATE = /\bglab\s+mr\s+create\b/
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g

/** Whether a command line POSTs a pull request through `gh api`. */
function ghApiCreatesPr(command: string): boolean {
  const call = (command.replace(QUOTED, ' ').split(/\bgh\s+api\b/)[1] ?? '').split(/[&|;\n]/)[0]
  if (!call || !/(?:^|\s)\/?repos\/[^\s/]+\/[^\s/]+\/pulls(?=\s|$)/.test(call)) return false
  const method = call.match(/(?:^|\s)(?:-X|--method)(?:\s+|=)([A-Za-z]+)/)?.[1]
  return method ? method.toUpperCase() === 'POST' : /(?:^|\s)(?:-f|-F|--field|--raw-field)(?:\s|=)/.test(call)
}

/** What a Bash command that succeeded adds to `commit.count` and `pull_request.count`, as Claude Code counts them. */
export function gitCounts(command: string): { commits: number; pullRequests: number } {
  const commits = COMMIT.test(command) ? 1 : 0
  let pullRequests = 0
  const gh = GH_PR_CREATE.test(command)
  const glab = GLAB_MR_CREATE.test(command)
  if (gh) pullRequests += glab ? 2 : 1
  else if (glab) pullRequests += 1
  const curl = /\bcurl\b/.test(command) && (/-X\s*POST\b/i.test(command) || /--request\s*=?\s*POST\b/i.test(command) || /\s-d\s/.test(command))
    && /https?:\/\/[^\s'"]*\/(?:pulls|pull-requests|merge[-_]requests)(?!\/\d)/i.test(command)
  if (curl || (!gh && !glab && ghApiCreatesPr(command))) pullRequests += 1
  return { commits, pullRequests }
}

/** Whether an MCP tool's own name says it creates a pull or merge request: such a call that succeeds adds one to `pull_request.count`. */
export function mcpCreatesPr(toolName: string): boolean {
  return /^create[_-]?(pull[_-]?request|merge[_-]?request)$|^(pull[_-]?request|merge[_-]?request)[_-]?create$/i.test(toolName)
}

// ── Command outcomes ──────────────────────────────────────────────────────────
//
// What Mainwave counts from a shell command: commits, pushes, pull requests and the like, and the refs a command names. Mainwave counts
// them from the command's text where it has it; where it does not (the text is content, and an organization may keep it), it counts
// what the plugin stamps on the command's span from these rules. So these are Mainwave's own rules, ported as they are: the patterns
// below are its regular expressions, and `tests/fixtures/command-outcomes.json` holds the cases both must agree on. The refs are the
// one place the port reads less than Mainwave does: a ref is a word of a counted invocation, read with the shell's word rules, past
// the flags that take a value, and sent only with a git ref's shape (see Refs, below).
//
// Mainwave evaluates them in ClickHouse, whose regular expressions are RE2's. What differs in JavaScript, and how the port keeps RE2's
// results:
// - RE2's `[[:space:]]` is the six ASCII spaces; JavaScript's `\s` is wider, so the class is written out.
// - Counting and listing matches (ClickHouse's `countMatches`, `extractAll`) start each search after the last match as a new string,
//   so `^` matches there again: `count` and `matchesOf` do the same. A replacement (`replaceRegexpAll`) searches the whole string,
//   as `String.replace` does.
// - In a replacement `.` does not match a newline unless the pattern says `(?s)`; in a match, count or extraction it does.
// - RE2 runs in time linear in the input, a backtracking engine need not. Where a pattern could backtrack without bound in JavaScript,
//   the port reads what RE2 reads another way: the heredoc pass is a scanner that finds the match RE2 finds (`cutHeredocs`), a branch
//   sync is read word by word (`isSyncMerge`), two alternatives of the quoted-string pass are rewritten to match the same text
//   without backtracking over it, and a command position takes no newline in the spaces that follow it (`CMD_POS`).

/** The outcomes Mainwave counts from a command, each sent as `mainwave.command.<column>` when above 0. */
export const COMMAND_COUNTS = ['commits', 'reverts', 'pushes', 'prs_opened', 'prs_merged', 'prs_updated', 'merges', 'tags', 'workflow_runs', 'branches_opened'] as const
export type CommandCount = (typeof COMMAND_COUNTS)[number]
/** The refs a command names, each with the count it goes beside, sent as `mainwave.command.<name>`. */
export const COMMAND_REFS = { branch_opened: 'branches_opened', push_ref: 'pushes', merge_ref: 'merges', tag_name: 'tags' } as const satisfies Record<string, CommandCount>
export type CommandRef = keyof typeof COMMAND_REFS

/** RE2's `[[:space:]]`, and its complement. */
const SP = String.raw`[\t\n\v\f\r ]`
const NSP = String.raw`[^\t\n\v\f\r ]`
/** `SP` but a newline: the spaces within one line. */
const HSP = String.raw`[\t\v\f\r ]`
/** A character of a word within one simple command: no space and no `&`, `|` or `;`. */
const WORD = String.raw`[^\t\n\v\f\r &|;]`
/** Words that may stand between a command position and the command: the `rtk` wrapper, and the shell keywords that open a body. */
const CMD_PREFIX = String.raw`(?:(?:rtk(?:${SP}+proxy)?|do|then|else|if|until|while)${HSP}+)*`
/**
 * A command position: the start, or past `&&`, `;`, `|` or a newline. Mainwave's pattern takes `SP` where this takes `HSP`; both
 * match the same commands, ending at the same place. A newline in those spaces is itself a command position, from which the rest of
 * the match is the same, and only the match's start moves, which nothing here depends on. With `SP`, each newline of a run of them
 * starts a search that reads the rest of the run, which takes time quadratic in the run.
 */
const CMD_POS = String.raw`(^|&&|;|[|]|\n)${HSP}*${CMD_PREFIX}`
const CMD_POS_NC = String.raw`(?:^|&&|;|[|]|\n)${HSP}*${CMD_PREFIX}`
const GIT = String.raw`git(${SP}+-C${SP}+${NSP}+)?${SP}+`
const GIT_NC = String.raw`git(?:${SP}+-C${SP}+${NSP}+)?${SP}+`
const SUB_END = String.raw`(${SP}|$)`
const REMOTE_REF = String.raw`(?:(?:origin|upstream)/${NSP}+|refs/remotes/${NSP}+|${NSP}*@[{](?:u|upstream)[}]|FETCH_HEAD)`

const COUNTED: Readonly<Record<Exclude<CommandCount, 'merges' | 'branches_opened'>, RegExp>> = {
  commits: new RegExp(String.raw`${CMD_POS}${GIT}(commit|cherry-pick)${SUB_END}`),
  reverts: new RegExp(String.raw`${CMD_POS}${GIT}revert${SUB_END}`),
  pushes: new RegExp(String.raw`${CMD_POS}${GIT}push${SUB_END}`),
  prs_opened: new RegExp(String.raw`${CMD_POS}(gh pr create|glab mr create)`),
  prs_merged: new RegExp(String.raw`${CMD_POS}(gh${SP}+pr|glab${SP}+mr)${SP}+merge`),
  prs_updated: new RegExp(String.raw`${CMD_POS}(gh${SP}+pr${SP}+(edit|ready|comment|review)|gh${SP}+stack${SP}+(submit|push)|glab${SP}+mr${SP}+(update|note|approve))`),
  tags: new RegExp(String.raw`${CMD_POS}${GIT}tag${SP}+(-[as]${SP}+)?[^-\t\n\v\f\r ]|${CMD_POS}(gh|glab)${SP}+release${SP}+create`),
  workflow_runs: new RegExp(String.raw`${CMD_POS}(gh${SP}+workflow${SP}+run|glab${SP}+ci${SP}+run)`),
}
/** A branch opener up to its subcommand (`opensBranch`). */
const OPENER_HEAD = new RegExp(String.raw`${CMD_POS_NC}${GIT_NC}(checkout|switch|worktree${SP}+add)`, 'g')
const SPACE = new RegExp(SP)
// ── Refs ──
//
// Mainwave reads a ref with a pattern's group: its push and tag patterns are searched anywhere, and its patterns read across newlines,
// separators, quotes and flags' values, so a word of a commit message, a push option or the next command can be read as a ref. The
// plugin sends a ref where the command's text may stay on the machine, so it reads one rule instead: a ref is a word of a counted
// invocation (a command position, `git`, the subcommand), read with the shell's own word rules (`shellWords`) from the subcommand to
// the end of its simple command; the word Mainwave's pattern names, with each flag that takes a value skipped with its value, and each
// redirect with its target; and sent only when it has a git ref's shape (`refShaped`). Where the two differ, the plugin names no ref,
// or a word of an invocation both count. Refs are read from the ref text (`refText`), whose quotes pair as the shell pairs them.

/** A counted invocation up to its subcommand, where the subcommand has words after it. */
const inLine = (sub: string) => new RegExp(String.raw`${CMD_POS_NC}${GIT_IN_LINE}${sub}(?=${HSP})`, 'g')
const GIT_IN_LINE = String.raw`git(?:${HSP}+-C${HSP}+${WORD}+)?${HSP}+`
const PUSH_HEAD = inLine('push')
const TAG_HEAD = inLine('tag')
const OPENER_HEAD_IN_LINE = inLine(String.raw`(checkout|switch|worktree${HSP}+add)`)

/** A subcommand's flags that take the next word as their value: short ones by letter, long ones by name. */
type ValueFlags = { short: string; long: readonly string[] }
const PUSH_FLAGS: ValueFlags = { short: 'o', long: ['--push-option', '--repo', '--receive-pack', '--exec', '--recurse-submodules'] }
const MERGE_FLAGS: ValueFlags = { short: 'mFsX', long: ['--message', '--file', '--strategy', '--strategy-option', '--into-name', '--cleanup'] }
/** A branch opener's: its branch flags, whose value is the branch, and the rest. */
const OPENER_FLAGS: Readonly<Record<string, ValueFlags & { branch: readonly string[] }>> = {
  checkout: { short: 'bB', long: ['--orphan', '--conflict', '--pathspec-from-file'], branch: ['-b', '-B'] },
  switch: { short: 'cC', long: ['--create', '--force-create', '--orphan', '--conflict'], branch: ['-c', '-C', '--create', '--force-create'] },
  worktree: { short: 'bB', long: ['--reason'], branch: ['-b', '-B'] },
}

/**
 * Whether a flag takes the next word as its value: a long flag of the list, or an abbreviation of one, written without `=value`; a
 * cluster of short flags whose first value-taking letter is its last, so no value is attached to it.
 */
function takesValue(word: string, flags: ValueFlags): boolean {
  if (word.startsWith('--')) return !word.includes('=') && flags.long.some(f => f === word || (word.length >= 4 && f.startsWith(word)))
  for (let i = 1; i < word.length; i++) if (flags.short.includes(word[i]!)) return i === word.length - 1
  return false
}

const isHsp = (c: string | undefined) => c === ' ' || c === '\t' || c === '\v' || c === '\f' || c === '\r'
const ENDS_COMMAND = new Set(['\n', '&', '|', ';', ')'])
/** Whether the `&` or `|` at `p`, in a word starting at `start`, is a redirect's (`>&`, `<&`, `>|`, `&>`) and no separator. */
const inRedirect = (text: string, p: number, start: number): boolean => {
  const c = text[p]
  const before = p > start && !escapedAt(text, p - 1) ? text[p - 1] : undefined
  if (c === '|') return before === '>'
  return c === '&' && (before === '>' || before === '<' || (p === start && text[p + 1] === '>'))
}

/**
 * The words of a simple command from `from`, each as written, quotes included, read lazily: unquoted spaces split them; `'…'` is
 * literal; `"…"` takes `\"` and `\\` as escapes; an unquoted backslash escapes the next character; `$(…)`, `${…}` and `` `…` `` are
 * part of the word they are in, up to their close; a quote or a substitution left open runs to the end of the text. An unquoted
 * newline, `&`, `|`, `;` or `)` ends the command, but for the `&` or `|` of a redirect (`2>&1`, `&>`, `>|`). Each character is read
 * once. `at()` is where reading stopped.
 */
function shellWords(text: string, from: number): { next: () => string | undefined; at: () => number } {
  const n = text.length
  let p = from
  /** The end of the substitution or quoted string opening at `q`, past its close; `n` when it is left open. */
  const close = (q: number): number => {
    const c = text[q]
    if (c === "'") {
      const e = text.indexOf("'", q + 1)
      return e < 0 ? n : e + 1
    }
    if (c === '`') {
      for (let i = q + 1; i < n; i++) {
        if (text[i] === '\\') i++
        else if (text[i] === '`') return i + 1
      }
      return n
    }
    if (c === '"') {
      for (let i = q + 1; i < n; ) {
        const d = text[i]
        if (d === '\\') i += 2
        else if (d === '"') return i + 1
        else if (opens(i)) i = close(i)
        else i++
      }
      return n
    }
    // `$(` or `${`: up to its matching close, read as opaque.
    const [open, shut] = text[q + 1] === '(' ? ['(', ')'] : ['{', '}']
    let depth = 0
    for (let i = q + 1; i < n; i++) {
      const d = text[i]
      if (d === '\\') i++
      else if (d === open) depth++
      else if (d === shut && --depth === 0) return i + 1
    }
    return n
  }
  const opens = (q: number) => text[q] === '`' || (text[q] === '$' && (text[q + 1] === '(' || text[q + 1] === '{'))
  const next = (): string | undefined => {
    while (p < n && (isHsp(text[p]) || (text[p] === '\\' && text[p + 1] === '\n'))) p += isHsp(text[p]) ? 1 : 2
    const start = p
    while (p < n) {
      const c = text[p]!
      if (isHsp(c) || (ENDS_COMMAND.has(c) && !inRedirect(text, p, start))) break
      if (c === '\\') p += 2
      else if (c === "'" || c === '"' || opens(p)) p = close(p)
      else p++
    }
    p = Math.min(p, n)
    return p > start ? text.slice(start, p) : undefined
  }
  return { next, at: () => p }
}

/** A redirect: an operator, with an optional descriptor before it, and its target attached or as the next word. */
const REDIRECT_WORD = /^(?:[0-9]+|&)?(?:<<<|<>|>>|>\||>&|<&|>|<)/
/** A command's arguments from `words`: each redirect skipped, with its target when that is the next word. */
function args(words: ReturnType<typeof shellWords>): () => string | undefined {
  return () => {
    for (;;) {
      const w = words.next()
      const op = w === undefined ? null : REDIRECT_WORD.exec(w)
      if (op === null) return w
      if (op[0].length === w!.length) words.next()
    }
  }
}

/** A git ref's characters: letters, digits, `.`, `_`, `-`, `/`, `@`, `+`, `:`, `,`, `=`, `%`, `#`, braces, and `$` opening a variable. */
const REF_SHAPE = /^(?:[\p{L}\p{M}\p{N}._/@+:,=%#{}-]|\$(?=[A-Za-z_{]))+$/u
/**
 * A word as a ref, or `''` when it has no git ref's shape: at most 256 characters of a ref's own, not starting with `-`, either bare or
 * wrapped whole in one pair of matching quotes (kept as written, unless `unquote`).
 */
function refShaped(word: string | undefined, unquote = false): string {
  if (word === undefined) return ''
  const quoted = word.length >= 2 && (word[0] === '"' || word[0] === "'") && word[word.length - 1] === word[0]
  const name = quoted ? word.slice(1, -1) : word
  const ref = unquote ? name : word
  return ref.length <= 256 && !name.startsWith('-') && REF_SHAPE.test(name) ? ref : ''
}

/**
 * Whether the command position at `at` is a separator a backslash escapes (`\;`, `\|`, `\&`, a backslash and a newline): a literal
 * character, often of a quoted string, where Mainwave's rules still count a command. A ref is never read from one.
 */
function escapedAt(text: string, at: number): boolean {
  let i = at
  while (i > 0 && text[i - 1] === '\\') i--
  return (at - i) % 2 === 1
}

/**
 * The ref of the first invocation `head` finds that names one, as `named` reads its words (`undefined` when it names none, so the
 * next is read). A head inside a word an earlier one read, or past an escaped separator, is skipped; each character is read once.
 */
function firstRef(head: RegExp, text: string, named: (m: RegExpExecArray, next: () => string | undefined) => string | undefined): string {
  head.lastIndex = 0
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    if (escapedAt(text, m.index)) continue
    const words = shellWords(text, m.index + m[0].length)
    const word = named(m, args(words))
    if (word !== undefined) return word
    head.lastIndex = Math.max(words.at(), m.index + m[0].length)
  }
  return ''
}

/** A push's ref, as Mainwave's pattern places it: past its flags (and their values), the word after the remote. */
const pushRef = (r: string) =>
  firstRef(PUSH_HEAD, r, (_m, next) => {
    let w = next()
    while (w?.startsWith('-')) {
      if (takesValue(w, PUSH_FLAGS)) next()
      w = next()
    }
    if (w === undefined) return undefined
    const ref = next()
    return ref === undefined || ref.startsWith('-') ? undefined : refShaped(ref)
  })

/** A tag's name, as Mainwave's pattern places it: the word after `tag`, or after `tag -a` or `tag -s`, when it is no flag. */
const tagName = (r: string) =>
  firstRef(TAG_HEAD, r, (_m, next) => {
    let w = next()
    if (w === '-a' || w === '-s') w = next()
    return w === undefined || w.startsWith('-') ? undefined : refShaped(w)
  })

/** The branch an opener names: its branch flag's value, quotes taken off, as Mainwave's pattern reads it. */
const branchOpened = (r: string) =>
  firstRef(OPENER_HEAD_IN_LINE, r, (m, next) => {
    const flags = OPENER_FLAGS[m[1]!.split(/[\t\v\f\r ]/)[0]!]!
    for (let w = next(); w !== undefined; w = next()) {
      if (flags.branch.includes(w)) {
        const name = next()
        return name === undefined || name.startsWith('-') ? undefined : refShaped(name, true)
      }
      if (w.startsWith('-') && takesValue(w, flags)) next()
    }
    return undefined
  })

/**
 * The ref a counted merge invocation names, at `at` in the ref text `r`: its first word that is not a flag or a flag's value.
 * Mainwave's pattern reads the word after any flag, so `git merge -m "fix the login" feat` gives `"fix`, a word of the message.
 */
function mergeRef(r: string, at: number, invocation: string): string {
  const head = MERGE_HEAD.exec(invocation)
  if (!head || escapedAt(r, at)) return ''
  const next = args(shellWords(r, at + head[0].length))
  for (let w = next(); w !== undefined; w = next()) {
    if (!w.startsWith('-')) return refShaped(w)
    if (takesValue(w, MERGE_FLAGS)) next()
  }
  return ''
}
/** Each `git merge` from its command position to the next separator; `merge-base` and `merge-tree` are not one. */
const MERGE_INVOCATION = new RegExp(String.raw`${CMD_POS_NC}${GIT_NC}merge(?:${SP}[^&|;\n]*|$)`)
/** A merge invocation up to its subcommand, from its start. */
const MERGE_HEAD = new RegExp(String.raw`^${CMD_POS_NC}${GIT_NC}merge`)
/** A word a branch sync may hold besides `--ff-only`: a flag, a redirect with its target in the word, or a remote-tracking ref. */
const SYNC_WORD = new RegExp(String.raw`^(?:-${NSP}*|[0-9]*>${NSP}*|${REMOTE_REF})$`)
/** A redirect whose target is the next word. */
const REDIRECT = /^[0-9]*>>?$/
const LEADING_SPACE = new RegExp(String.raw`^${SP}`)
const SPACES = new RegExp(String.raw`${SP}+`)

/**
 * Whether a `git merge` invocation is a branch sync, as Mainwave's pattern reads it:
 *
 *   ^CMD_POS GIT merge(?:SP+WORD)*SP+--ff-only(?:SP+WORD)*SP*$   where WORD is -NSP*|[0-9]*>>?(?:SP*NSP+)?|REMOTE_REF
 *
 * Read word by word, which matches the same invocations: a backtracking engine tries every way a run of bare redirects can take
 * their targets, which grows exponentially with the run.
 */
function isSyncMerge(invocation: string): boolean {
  const head = MERGE_HEAD.exec(invocation)
  if (head === null) return false
  const rest = invocation.slice(head[0].length)
  if (!LEADING_SPACE.test(rest)) return false
  const words = rest.split(SPACES).filter(w => w !== '')
  // Positions reachable before (0) and after (1) the `--ff-only` the pattern names.
  const reach = [new Uint8Array(words.length + 1), new Uint8Array(words.length + 1)]
  reach[0]![0] = 1
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    for (const phase of [0, 1] as const) {
      if (!reach[phase]![i]) continue
      if (SYNC_WORD.test(w)) reach[phase]![i + 1] = 1
      if (REDIRECT.test(w) && i + 1 < words.length) reach[phase]![i + 2] = 1
      if (phase === 0 && w === '--ff-only') reach[1]![i + 1] = 1
    }
  }
  return reach[1]![words.length] === 1
}

/**
 * Whether a command opens a branch, as Mainwave's pattern reads it:
 *
 *   CMD_POS GIT (checkout ARGS SP+-[bB] | switch ARGS SP+(-[cC]|--create|--force-create) | worktree SP+add ARGS SP+-[bB]) SP+
 *
 * where ARGS is `(?:SP+[^SP&|;]+)*?`: past the subcommand, a run of words with no `&`, `|` or `;` in them, crossing newlines, then
 * the flag as a word of its own. Read word by word from each opener: a backtracking engine reads the whole run again from each
 * opener in it, which takes time quadratic in the run. A run an opener read to its end without finding its flag holds none for an
 * opener later in it either, so each run is read once for each flag.
 */
function opensBranch(text: string): boolean {
  if (!text.includes('git')) return false
  /** Where a read for each flag found none, up to the end of its run. */
  const none = { b: -1, c: -1 }
  OPENER_HEAD.lastIndex = 0
  for (let m = OPENER_HEAD.exec(text); m !== null; m = OPENER_HEAD.exec(text)) {
    OPENER_HEAD.lastIndex = m.index + 1
    const flag = m[1] === 'switch' ? 'c' : 'b'
    let p = m.index + m[0].length
    if (p < none[flag]) continue
    for (;;) {
      if (!SPACE.test(text[p] ?? '')) break
      while (SPACE.test(text[p] ?? '')) p++
      const start = p
      while (p < text.length && !SPACE.test(text[p]!)) p++
      if (start === p) break
      const word = text.slice(start, p)
      if (p < text.length && (flag === 'b' ? word === '-b' || word === '-B' : word === '-c' || word === '-C' || word === '--create' || word === '--force-create')) return true
      if (/[&|;]/.test(word)) break
    }
    none[flag] = Math.max(none[flag], p)
  }
  return false
}

/**
 * The quoted-string pass, in RE2's order: a single-quoted string holding a separator or a newline (cut to its opening quote), one
 * without (kept), the same two double-quoted, a backslash and the character it escapes (kept), and a comment (cut, the space before
 * it kept). The first and third alternatives read up to their first separator without backtracking over it, which matches the same
 * strings as `[^']*SEP[^']*'`: a string holds a separator exactly when it holds a first one. In the third, a backslash is read only
 * with the character it escapes, as in RE2's pattern: an escaped separator is no separator, and a backslash read either way would
 * backtrack exponentially in the count of them.
 */
const QUOTED_TEXT = new RegExp(
  String.raw`(')[^';&|\n]*[;&|\n][^']*'|('[^']*')|(")(?:[^"\\;&|\n]|\\.)*[;&|\n](?:[^"\\]|\\.)*"|("(?:[^"\\]|\\.)*")|(\\.)|(^|[\t\n\v\f\r ])#[^\n]*`,
  'gs',
)

/** How many times `re` matches, each search starting after the last match as a new string (ClickHouse's `countMatches`). */
function count(re: RegExp, text: string): number {
  let n = 0
  let rest = text
  for (let m = re.exec(rest); m !== null && m[0] !== ''; m = re.exec(rest)) {
    n++
    rest = rest.slice(m.index + m[0].length)
  }
  return n
}

/**
 * Every match of `re` and where it starts, each search starting after the last match as a new string (ClickHouse's `extractAll`, for a
 * pattern with no group).
 */
function matchesOf(re: RegExp, text: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = []
  let from = 0
  for (let m = re.exec(text); m !== null && m[0] !== ''; m = re.exec(text.slice(from))) {
    out.push({ text: m[0], at: from + m.index })
    from += m.index + m[0].length
  }
  return out
}

const isTagStart = (c: string | undefined) => c !== undefined && ((c >= 'A' && c <= 'Z') || c === '_')
const isTagRest = (c: string | undefined) => isTagStart(c) || (c !== undefined && c >= '0' && c <= '9')
const isQuote = (c: string | undefined) => c === '"' || c === "'"

/**
 * One heredoc pass of Mainwave's rules: each heredoc whose opener names `EOF` (`anyTag` false) or any upper-case word (`anyTag` true)
 * replaced by the character before its `<<`, `_` and the rest of its opener's line, its body and terminator line cut. The pattern is
 *
 *   (^|[^<])<<-?[ \t]*["']?TAG["']?((?:[^A-Za-z0-9_\n"'](?:[^\n"']|'[^']*'|"(?:[^"\\]|\\.)*"|["'])*)?)(?s:\n.*?)??\n[ \t]*TAG[ \t\r]*(\n|$)
 *
 * applied as `replaceRegexpAll` applies it (`.` outside `(?s:)` does not match a newline there). Up to the rest of the opener's line,
 * each step has one way to match. The rest of the line can end at any newline its quoted strings do not hold, and RE2 takes the first
 * end, in the order a backtracking engine tries them, after which a terminator line comes; the body is then up to the first one. The
 * scanner computes, from the right, the end that order finds from each position (`tail`), so each heredoc costs constant time once
 * the tables are built, where the pattern itself could backtrack without bound.
 */
function cutHeredocs(text: string, anyTag: boolean): string {
  if (!text.includes('<<')) return text
  const n = text.length
  /** The end of a tag at `i`, or -1. */
  const tagEnd = (i: number): number => {
    if (!anyTag) return text.startsWith('EOF', i) ? i + 3 : -1
    if (!isTagStart(text[i])) return -1
    let j = i + 1
    while (isTagRest(text[j])) j++
    return j
  }
  /** Where a terminator line starting with the newline at `q` ends, past its own newline; -1 when the line is not one. */
  const terminatorEnd = (q: number): number => {
    let i = q + 1
    while (text[i] === ' ' || text[i] === '\t') i++
    i = tagEnd(i)
    if (i < 0) return -1
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '\r') i++
    return i === n ? n : text[i] === '\n' ? i + 1 : -1
  }
  // From the right: the first terminator line at or after each position; the close of a double-quoted string opened just before each
  // position (`\\.` takes no newline here); the next single quote; and where the rest of an opener's line, read from each position,
  // ends in the first end a terminator follows.
  const term = new Int32Array(n + 1).fill(-1)
  const dq = new Int32Array(n + 2).fill(-1)
  const sq = new Int32Array(n + 2).fill(-1)
  const tail = new Int32Array(n + 1).fill(-1)
  for (let i = n - 1; i >= 0; i--) {
    const c = text[i]
    term[i] = c === '\n' && terminatorEnd(i) >= 0 ? i : term[i + 1]!
    dq[i] = c === '"' ? i : c === '\\' ? (i + 1 < n && text[i + 1] !== '\n' ? dq[i + 2]! : -1) : dq[i + 1]!
    sq[i] = c === "'" ? i : sq[i + 1]!
  }
  const bodyFrom = (e: number): boolean => text[e] === '\n' && term[e]! >= 0
  for (let i = n - 1; i >= 0; i--) {
    const c = text[i]
    if (c === '\n') tail[i] = bodyFrom(i) ? i : -1
    else if (c === "'" || c === '"') {
      const close = c === "'" ? sq[i + 1]! : dq[i + 1]!
      const whole = close >= 0 ? tail[close + 1]! : -1
      tail[i] = whole >= 0 ? whole : tail[i + 1]!
    } else tail[i] = tail[i + 1]!
  }
  let out = ''
  let copied = 0
  let from = 0
  for (let a = text.indexOf('<<'); a >= 0; a = text.indexOf('<<', a + 1)) {
    const at = a === 0 && from === 0 ? 0 : a - 1
    if (at < from || (at !== a && text[at] === '<')) continue
    let p = a + 2
    if (text[p] === '-') p++
    while (text[p] === ' ' || text[p] === '\t') p++
    if (isQuote(text[p])) p++
    p = tagEnd(p)
    if (p < 0) continue
    if (isQuote(text[p])) p++
    let rest = ''
    let e = -1
    const c = text[p]
    if (c !== undefined && !/[A-Za-z0-9_\n"']/.test(c) && tail[p + 1]! >= 0) {
      e = tail[p + 1]!
      rest = text.slice(p, e)
    } else if (bodyFrom(p)) e = p
    if (e < 0) continue
    const end = terminatorEnd(term[e]!)
    out += text.slice(copied, at) + (at === a ? '' : text[at]) + '_' + rest + (text[end - 1] === '\n' ? '\n' : '')
    copied = from = end
    if (end >= n) break
    a = end - 1
  }
  return out + text.slice(copied)
}

const withoutHeredocs = (command: string) => (command.includes('<<') ? cutHeredocs(cutHeredocs(command, false), true) : command)
const groups = (g: unknown[], order: readonly number[]) => order.map(i => (typeof g[i] === 'string' ? g[i] : '')).join('')

/** A command's executable text, as Mainwave reads it: heredoc bodies, quoted strings holding a separator or a newline, and comments cut. */
export function executableText(command: string): string {
  return withoutHeredocs(command).replace(QUOTED_TEXT, (_m, ...g: unknown[]) => groups(g, [0, 1, 2, 3, 4, 5]))
}

/** An ANSI-C string (`$'…'`) holding an escaped quote, which the quoted-string pass reads as ending at that quote. */
const ANSI_C_ESCAPED_QUOTE = /\$'(?:[^'\\]|\\[^'])*\\'/
/** A heredoc operator the heredoc pass left in place: a tag with a lower-case letter, or one with no terminator line. */
const HEREDOC_LEFT = /(^|[^<])<<-?[\t ]*[^\s<>&|;()]/

/**
 * The text refs are read from: the executable text, but for each quoted string cut leaving a closed pair (`""`, `''`) where the
 * executable text leaves its opening quote alone, which the shell's word rules would pair with the next string's opening quote. The
 * separators outside quotes are the same, so it holds the same invocations, in the same order. It ends at a heredoc operator the
 * heredoc pass left in place, as what follows may be its body, and is empty for a command holding an ANSI-C string with an escaped
 * quote, where the quoted-string pass pairs quotes as the shell does not.
 */
function refText(command: string): string {
  const text = withoutHeredocs(command)
  if (ANSI_C_ESCAPED_QUOTE.test(text)) return ''
  const r = text.replace(QUOTED_TEXT, (_m, ...g: unknown[]) => groups(g, [0, 0, 1, 2, 2, 3, 4, 5]))
  const heredoc = HEREDOC_LEFT.exec(r)
  return heredoc === null ? r : r.slice(0, heredoc.index + heredoc[1]!.length)
}

/**
 * What a shell command did, by Mainwave's rules: each count above 0, and each ref the command names where its count is above 0. Only
 * a command position counts, so a commit message or an `echo` that quotes `git push` counts nothing.
 */
export function commandOutcomes(command: string): { counts: Partial<Record<CommandCount, number>>; refs: Partial<Record<CommandRef, string>> } {
  const x = executableText(command)
  const merges = matchesOf(MERGE_INVOCATION, x).filter(m => !isSyncMerge(m.text))
  const all: Record<CommandCount, number> = {
    commits: count(COUNTED.commits, x),
    reverts: count(COUNTED.reverts, x),
    pushes: count(COUNTED.pushes, x),
    prs_opened: count(COUNTED.prs_opened, x),
    prs_merged: count(COUNTED.prs_merged, x),
    prs_updated: count(COUNTED.prs_updated, x),
    merges: merges.length,
    tags: count(COUNTED.tags, x),
    workflow_runs: count(COUNTED.workflow_runs, x),
    branches_opened: opensBranch(x) ? 1 : 0,
  }
  // Refs are read from the ref text, which holds the same invocations as `x` up to where it ends. A merge's is the last one's, so where
  // the ref text holds fewer, its last is not the counted one, and none is named.
  let r: string | undefined
  const refSource = () => (r ??= refText(command))
  const named: Record<CommandRef, () => string> = {
    branch_opened: () => branchOpened(refSource()),
    push_ref: () => pushRef(refSource()),
    merge_ref: () => {
      const read = matchesOf(MERGE_INVOCATION, refSource()).filter(m => !isSyncMerge(m.text))
      const last = read[read.length - 1]
      return last && read.length === merges.length ? mergeRef(refSource(), last.at, last.text) : ''
    },
    tag_name: () => tagName(refSource()),
  }
  const counts: Partial<Record<CommandCount, number>> = {}
  for (const c of COMMAND_COUNTS) if (all[c] > 0) counts[c] = all[c]
  const refs: Partial<Record<CommandRef, string>> = {}
  for (const [ref, c] of Object.entries(COMMAND_REFS) as [CommandRef, CommandCount][]) {
    if (all[c] === 0) continue
    const value = named[ref]()
    if (value !== '') refs[ref] = value
  }
  return { counts, refs }
}

// ── File edits ────────────────────────────────────────────────────────────────

/** The file tools whose permission decisions `code_edit_tool.decision` counts. */
export const CODE_EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

const countLines = (text: string) => text.split('\n').length

/**
 * The lines a file tool's result added and removed, as `lines_of_code.count` counts them: the patch's `+` and `-` lines, or, for a
 * file written whole with no patch, every line of the new content (and of the old, as removed). Undefined for a result that is not
 * a file edit's (one with no `structuredPatch`).
 */
export function linesChanged(result: unknown): { added: number; removed: number } | undefined {
  if (result === null || typeof result !== 'object') return undefined
  const r = result as { structuredPatch?: unknown; content?: unknown; originalFile?: unknown; type?: unknown }
  if (!Array.isArray(r.structuredPatch)) return undefined
  const hunks = r.structuredPatch as { lines?: unknown }[]
  if (hunks.length === 0) {
    const added = typeof r.content === 'string' && r.content !== '' ? countLines(r.content) : 0
    const removed = typeof r.originalFile === 'string' && r.originalFile !== '' ? countLines(r.originalFile) : 0
    return { added, removed }
  }
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const line of Array.isArray(h?.lines) ? (h.lines as unknown[]) : []) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

/**
 * File extensions and the language name Claude Code gives them (its syntax highlighter's names), for the common ones. Claude Code
 * knows about 375 names and aliases; an extension missing here reads `unknown` where Claude Code may name it.
 */
const LANGUAGES: Readonly<Record<string, string>> = {
  txt: 'Plain text', text: 'Plain text', md: 'Markdown', markdown: 'Markdown',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  py: 'Python', gyp: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala',
  swift: 'Swift', c: 'C', h: 'C', cc: 'C++', cpp: 'C++', cxx: 'C++', hpp: 'C++', hh: 'C++', hxx: 'C++', cs: 'C#', mm: 'Objective-C', m: 'Mercury',
  php: 'php', pl: 'Perl', pm: 'Perl', lua: 'Lua', r: 'R', dart: 'Dart', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', hs: 'Haskell', clj: 'Clojure',
  sh: 'Bash', bash: 'Bash', zsh: 'Bash', ps1: 'PowerShell', sql: 'SQL', json: 'JSON', yml: 'YAML', yaml: 'YAML', toml: 'TOML, also INI', ini: 'TOML, also INI',
  xml: 'HTML, XML', html: 'HTML, XML', svg: 'HTML, XML', css: 'CSS', scss: 'SCSS', less: 'Less', graphql: 'GraphQL', gql: 'GraphQL',
  dockerfile: 'Dockerfile', makefile: 'Makefile', mk: 'Makefile', cmake: 'CMake', gradle: 'Gradle', groovy: 'Groovy', diff: 'Diff', patch: 'Diff',
  proto: 'Protocol Buffers', nix: 'Nix', vim: 'Vim Script', tex: 'LaTeX',
}

/** `language` for a file path, by its extension: `unknown` for no extension or one not listed. */
export function languageOf(path: unknown): string {
  if (typeof path !== 'string') return 'unknown'
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'unknown'
  const ext = name.slice(dot + 1).toLowerCase()
  return has(LANGUAGES, ext) ? LANGUAGES[ext]! : 'unknown'
}
