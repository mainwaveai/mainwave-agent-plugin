// The GitLab merge-request marker's reading: whether a shell command opened a merge request with glab, which one its output names,
// and the lookup for its project's ID. Pure: the hooks module runs the lookup (register.ts). Its span is `vcs.change.opened`, as a
// GitHub pull request's (markers.ts), under source `hook.gitlab`.
//
// Two commands open a merge request: `glab mr create` (alias `new`), which prints `Creating merge request for <source> into <target>
// in <group/project>` and then the request's address on a line of its own; and a POST of `glab api` to a project's `merge_requests`,
// which prints the request as JSON. The address is taken only where the output proves it is the one just opened. The project's ID
// comes from that JSON, else from `glab mr view <iid> -R <project> -F json`, run only for a host glab is set up for (glab sends the
// person's token to the host it is given), and believed only when it describes the same address.

import type { TelemetryAttribute } from 'claude-code'

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * A shell command split into simple commands, each a list of words, quotes and backslashes honored, so a separator inside a quoted
 * string does not split. Not a shell: enough to read a command's first words and flags.
 */
export function shellSegments(command: unknown): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote = ''
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (words.length) segments.push(words)
    words = []
  }
  const s = typeof command === 'string' ? command : ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && i + 1 < s.length) word += s[++i]
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < s.length) {
      word += s[++i]
      inWord = true
    } else if (c === '&' || c === '|' || c === ';' || c === '\n' || c === '(' || c === ')') {
      endSegment()
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
    } else {
      word += c
      inWord = true
    }
  }
  endSegment()
  return segments
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Words that run the command after them, each with the flags of theirs that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  sudo: new Set(['-u', '-g', '-U', '-C', '-D', '-R', '-p', '-h', '-T']),
  time: new Set(['-f', '-o']),
  command: new Set(), nohup: new Set(), exec: new Set(['-a']), '{': new Set(), '!': new Set(),
  if: new Set(), then: new Set(), else: new Set(), elif: new Set(), do: new Set(), while: new Set(), until: new Set(),
}

/** A simple command's words from its program on, past leading assignments and wrapper words (`env`, `sudo`, `then`, `do`, `!` ...). */
export function commandWords(segment: readonly string[]): string[] {
  let i = 0
  for (;;) {
    const w = segment[i]
    if (w === undefined) return []
    if (ASSIGNMENT.test(w)) {
      i++
      continue
    }
    const valueFlags = Object.prototype.hasOwnProperty.call(WRAPPERS, w) ? WRAPPERS[w] : undefined
    if (!valueFlags) break
    i++
    while (segment[i]?.startsWith('-')) i += valueFlags.has(segment[i]!) ? 2 : 1
  }
  return segment.slice(i)
}

/** The words after glab in a simple command, past leading assignments and wrappers; undefined when the command is not glab. */
function glabWords(segment: readonly string[]): string[] | undefined {
  const words = commandWords(segment)
  return words[0] !== undefined && /(^|\/)glab(\.exe)?$/.test(words[0]) ? words.slice(1) : undefined
}

const API_VALUE_FLAGS = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '--form', '--input', '-H', '--header', '--hostname', '--output'])
const API_BODY_FLAGS = new Set(['-f', '--raw-field', '-F', '--field', '--form', '--input'])

/** A `glab api` call's endpoint (its first positional argument) and the method glab uses: as given, else POST with a body, else GET. */
export function parseApiCall(words: readonly string[]): { endpoint?: string; method: string } {
  let endpoint: string | undefined
  let explicit: string | undefined
  let body = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!w.startsWith('-') || w === '-') {
      endpoint ??= w
      continue
    }
    let flag = w
    let value: string | undefined
    const eq = w.indexOf('=')
    if (w.startsWith('--') && eq !== -1) {
      flag = w.slice(0, eq)
      value = w.slice(eq + 1)
    } else if (/^-[XfFH]./.test(w)) {
      flag = w.slice(0, 2)
      value = w.slice(2)
    }
    if (API_VALUE_FLAGS.has(flag)) {
      value ??= words[++i]
      if (flag === '-X' || flag === '--method') explicit = (value ?? '').toUpperCase()
      if (API_BODY_FLAGS.has(flag)) body = true
    }
  }
  return { ...(endpoint !== undefined ? { endpoint } : {}), method: explicit ?? (body ? 'POST' : 'GET') }
}

const API_CREATE_ENDPOINT = /^\/?(?:api\/v4\/)?projects\/[^/?#]+\/merge_requests\/?(?:[?#].*)?$/

/** The `--title` / `-t` of `glab mr create`. */
function mrTitleOf(words: readonly string[]): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--title' || w === '-t') return words[i + 1]
    if (w.startsWith('--title=')) return w.slice('--title='.length)
    if (/^-t.+/.test(w) && !w.startsWith('--')) return w.slice(2)
  }
  return undefined
}

/** The `title=` field of a `glab api` call. */
function apiTitleOf(words: readonly string[]): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const value = /^(-f|-F|--field|--raw-field)$/.test(w) ? words[i + 1] : /^--(?:raw-)?field=/.test(w) ? w.slice(w.indexOf('=') + 1) : undefined
    if (value?.startsWith('title=')) return value.slice('title='.length)
  }
  return undefined
}

/**
 * What a shell command asks glab to do: `create` for `glab mr create` (or `new`), `api` for a POST of `glab api` to a project's
 * `merge_requests`, each with the title it gave; undefined for anything else (a GET, `glab mr view`, the words inside a quoted string).
 */
export function classifyGlab(command: unknown): { kind: 'create' | 'api'; title?: string } | undefined {
  for (const segment of shellSegments(command)) {
    const words = glabWords(segment)
    if (!words || words.includes('--help') || words.includes('-h')) continue
    if (words[0] === 'mr' && (words[1] === 'create' || words[1] === 'new')) {
      const title = mrTitleOf(words.slice(2))
      return { kind: 'create', ...(title !== undefined ? { title } : {}) }
    }
    if (words[0] === 'api') {
      const { endpoint, method } = parseApiCall(words.slice(1))
      if (method === 'POST' && endpoint && API_CREATE_ENDPOINT.test(endpoint)) {
        const title = apiTitleOf(words.slice(1))
        return { kind: 'api', ...(title !== undefined ? { title } : {}) }
      }
    }
  }
  return undefined
}

const MR_URL = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[\w.~%+-]+)+?\/(?:-\/)?merge_requests\/(\d+)(?![\w/])/
const MR_URL_LINE = new RegExp(`^${MR_URL.source}$`)
const ANCHOR = /^\s*Creating merge request for \S+ into \S+ in \S+\s*$/
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

export type MrRef = { url: string; iid: string; projectUrl: string }

function parseMrUrl(m: RegExpMatchArray): MrRef {
  let url = m[0]
  try {
    url = new URL(url).href
  } catch {
    // As printed.
  }
  return { url, iid: m[1]!, projectUrl: url.replace(/\/(?:-\/)?merge_requests\/\d+$/, '') }
}

const projectPathOf = (url: string): string | undefined => {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/\/(?:-\/)?merge_requests\/\d+$/, '').replace(/^\//, '')).toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * The merge request glab created, from what it printed. With glab's `Creating merge request ... in <group/project>` line, the first
 * address alone on its line after it whose project is that one (two such lines naming different requests: none). Without it, an
 * address only where it is the one distinct merge request address in the output. `remote:` lines (git push's) are never read.
 */
export function mrUrlOf(text: unknown): MrRef | undefined {
  const lines = String(text ?? '').replace(ANSI, '').split(/\r?\n/).filter(l => !/^\s*remote:/i.test(l))
  const urlOn = (line: string) => {
    const m = line.trim().match(MR_URL_LINE)
    return m ? parseMrUrl(m) : undefined
  }
  const anchors: number[] = []
  lines.forEach((l, i) => {
    if (ANCHOR.test(l)) anchors.push(i)
  })
  if (anchors.length > 0) {
    const pairs = new Map<string, MrRef>()
    anchors.forEach((at, n) => {
      const path = lines[at]!.trim().split(/\s+/).pop()!.toLowerCase()
      for (const line of lines.slice(at + 1, anchors[n + 1] ?? lines.length)) {
        const u = urlOn(line)
        if (u && projectPathOf(u.url) === path) {
          pairs.set(u.url, u)
          break
        }
      }
    })
    return pairs.size === 1 ? [...pairs.values()][0] : undefined
  }
  const all = lines.map(urlOn).filter((u): u is MrRef => u !== undefined)
  return new Set(all.map(u => u.url)).size === 1 ? all[0] : undefined
}

/**
 * The texts to read a shell result for, in order: with both streams, glab's `Creating ...` line (stderr) with stdout's last line, then
 * each alone; else the one there is.
 */
export function glabTexts(result: unknown): string[] {
  if (typeof result === 'string') return result ? [result] : []
  if (!isObject(result)) return []
  const out = typeof result['stdout'] === 'string' ? result['stdout'] : ''
  const err = typeof result['stderr'] === 'string' ? result['stderr'] : ''
  const last = out.trimEnd().split('\n').pop() ?? ''
  return out && err ? [`${err}\n${last}`, out, err] : [out || err].filter(Boolean)
}

export type MrDetails = { iid?: number; projectId?: number; title?: string; webUrl?: string; filesChanged?: number }

/** The fields read from a merge request as JSON (`glab mr view -F json`, or a `glab api` answer); `changes_count` only as a plain integer. */
export function parseMrJson(text: unknown): MrDetails {
  let json: unknown
  try {
    json = typeof text === 'string' ? JSON.parse(text) : undefined
  } catch {
    return {}
  }
  if (!isObject(json)) return {}
  const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined)
  const out: MrDetails = {}
  const [iid, projectId, filesChanged] = [int(json['iid']), int(json['project_id']), int(json['changes_count'])]
  if (iid !== undefined) out.iid = iid
  if (projectId !== undefined) out.projectId = projectId
  if (typeof json['title'] === 'string') out.title = json['title']
  if (typeof json['web_url'] === 'string') out.webUrl = json['web_url']
  if (filesChanged !== undefined) out.filesChanged = filesChanged
  return out
}

/** A `glab api` answer as the request it created: the whole text, else from its first `{` to its last `}`; `{}` without an address. */
export function mrFromApi(text: string): MrDetails {
  const direct = parseMrJson(text)
  if (direct.webUrl) return direct
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start !== -1 && end > start ? parseMrJson(text.slice(start, end + 1)) : {}
}

/** Two addresses that name the same page. */
export function sameUrl(a: string | undefined, b: string): boolean {
  try {
    return a !== undefined && new URL(a).href.replace(/\/$/, '') === new URL(b).href.replace(/\/$/, '')
  } catch {
    return false
  }
}

/** The folder glab reads its config from: `~/.config/glab-cli` where its `config.yml` exists, else the platform's own. */
export function glabConfigDir(home: string, platform: string | undefined, legacyExists: boolean): string {
  const legacy = `${home}/.config/glab-cli`
  if (legacyExists) return legacy
  if (platform === 'macos') return `${home}/Library/Application Support/glab-cli`
  if (platform === 'windows') return `${home}/AppData/Roaming/glab-cli`
  return legacy
}

/** The hosts glab is set up for: gitlab.com, and the keys under `hosts:` in its config (read as keys only, never a token). */
export function glabHosts(configText: string | undefined): Set<string> {
  const hosts = new Set(['gitlab.com'])
  let inHosts = false
  let indent: number | undefined
  for (const line of (configText ?? '').split(/\r?\n/)) {
    if (/^hosts:\s*(#.*)?$/.test(line)) {
      inHosts = true
      continue
    }
    if (!inHosts) continue
    if (/^\S/.test(line)) {
      inHosts = false
      continue
    }
    const m = line.match(/^( +)(["']?)([^\s"':]+(?::\d+)?)\2:\s*(#.*)?$/)
    if (!m) continue
    indent ??= m[1]!.length
    if (m[1]!.length === indent) hosts.add(m[3]!.toLowerCase())
  }
  return hosts
}

/** An address's host as GitLab's instance: lowercased, the scheme's default port dropped, any other kept. */
export function instanceOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase() || undefined
  } catch {
    return undefined
  }
}

/** `<instance>:<project id>`, where the project ID is a positive integer. */
export function repositoryIdOf(url: string, projectId: number | undefined): string | undefined {
  const instance = instanceOf(url)
  return instance && projectId !== undefined && Number.isInteger(projectId) && projectId > 0 ? `${instance}:${projectId}` : undefined
}

/** A title without GitLab's draft marker (`Draft:`, `[Draft]`, `(Draft)`), which the connector's title never has. */
export function stripDraft(title: string | undefined): string | undefined {
  if (typeof title !== 'string') return undefined
  const stripped = title.replace(/^\s*(?:(?:\[draft\]|\(draft\)|draft:)\s*)+/i, '').trim()
  return stripped || undefined
}

/** The arguments of the lookup for a merge request's project. */
export const mrLookup = (mr: MrRef): string[] => ['glab', 'mr', 'view', mr.iid, '-R', mr.projectUrl, '-F', 'json']

/** A merge request's span attributes. */
export function mrAttributes(mr: MrRef, repositoryId: string | undefined, title: string | undefined, filesChanged: number | undefined): Record<string, TelemetryAttribute> {
  return {
    'vcs.repository.url.full': mr.url,
    'vcs.change.id': mr.iid,
    'vcs.provider.name': 'gitlab',
    ...(repositoryId !== undefined ? { 'vcs.repository.id': repositoryId } : {}),
    ...(title !== undefined ? { 'vcs.change.title': title } : {}),
    ...(filesChanged !== undefined ? { 'vcs.change.files_changed': filesChanged } : {}),
  }
}
