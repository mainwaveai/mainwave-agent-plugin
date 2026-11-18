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
// one place the port reads less than Mainwave does: a ref is read only from a counted invocation at a command position, up to the
// end of its simple command, so no word of a commit message, an echo or the next command is ever sent as one (see `PUSH_REF`).
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
const REF = String.raw`([^-\t\n\v\f\r ][^\t\n\v\f\r &|;]*)`

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
/**
 * The ref a branch opener, a push, a merge invocation or a tag names: the pattern's first group, as written. Mainwave's push and tag
 * patterns are searched anywhere, and its branch, push and tag patterns read across newlines and separators, so a word of a commit
 * message, or of the next command, can be read as the ref. The plugin sends a ref where the command's text may stay on the machine,
 * so here each starts at a command position, as its count does, and reads only words of its own simple command: no newline, `&`,
 * `|` or `;` within it. Where the two differ, the plugin's ref is a word of an invocation both count, or there is none.
 */
const GIT_IN_LINE = String.raw`git(?:${HSP}+-C${HSP}+${WORD}+)?${HSP}+`
const OPEN_ARGS_IN_LINE = String.raw`(?:${HSP}+${WORD}+)*?`
const BRANCH_OPENER_IN_LINE = String.raw`${GIT_IN_LINE}(?:checkout${OPEN_ARGS_IN_LINE}${HSP}+-[bB]|switch${OPEN_ARGS_IN_LINE}${HSP}+(?:-[cC]|--create|--force-create)|worktree${HSP}+add${OPEN_ARGS_IN_LINE}${HSP}+-[bB])${HSP}+`
const BRANCH_NAME = new RegExp(String.raw`${CMD_POS_NC}${BRANCH_OPENER_IN_LINE}["']?([^-\t\n\v\f\r &|;"'${'`'}][^\t\n\v\f\r &|;"'${'`'}]*)`)
const PUSH_REF = new RegExp(String.raw`${CMD_POS_NC}${GIT_IN_LINE}push(?:${HSP}+-${WORD}+)*${HSP}+[^-\t\n\v\f\r &|;]${WORD}*${HSP}+${REF}`)
/** Read from the counted merge invocation itself, which ends at its simple command's end. */
const MERGE_REF = new RegExp(String.raw`${GIT_NC}merge(?:${SP}+-${NSP}+)*${SP}+${REF}`)
const TAG_NAME = new RegExp(String.raw`${CMD_POS_NC}${GIT_IN_LINE}tag${HSP}+(?:-[as]${HSP}+)?${REF}`)
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

/** Every match of `re`, each search starting after the last match as a new string (ClickHouse's `extractAll`, for a pattern with no group). */
function matchesOf(re: RegExp, text: string): string[] {
  const out: string[] = []
  let rest = text
  for (let m = re.exec(rest); m !== null && m[0] !== ''; m = re.exec(rest)) {
    out.push(m[0])
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

/** The first group of `re`'s first match, or `''` (ClickHouse's `extract`). */
const extract = (re: RegExp, text: string): string => re.exec(text)?.[1] ?? ''

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

/** A command's executable text, as Mainwave reads it: heredoc bodies, quoted strings holding a separator or a newline, and comments cut. */
export function executableText(command: string): string {
  const text = command.includes('<<') ? cutHeredocs(cutHeredocs(command, false), true) : command
  return text.replace(QUOTED_TEXT, (_m, ...g: unknown[]) => g.slice(0, 6).map(v => (typeof v === 'string' ? v : '')).join(''))
}

/**
 * What a shell command did, by Mainwave's rules: each count above 0, and each ref the command names where its count is above 0. Only
 * a command position counts, so a commit message or an `echo` that quotes `git push` counts nothing.
 */
export function commandOutcomes(command: string): { counts: Partial<Record<CommandCount, number>>; refs: Partial<Record<CommandRef, string>> } {
  const x = executableText(command)
  const merges = matchesOf(MERGE_INVOCATION, x).filter(m => !isSyncMerge(m))
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
  const named: Record<CommandRef, () => string> = {
    branch_opened: () => extract(BRANCH_NAME, x),
    push_ref: () => extract(PUSH_REF, x),
    merge_ref: () => extract(MERGE_REF, merges[merges.length - 1] ?? ''),
    tag_name: () => extract(TAG_NAME, x),
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
