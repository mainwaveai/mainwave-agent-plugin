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
