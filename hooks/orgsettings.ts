// The organization's data collection settings, from Mainwave: which data points it turned on or off, and which redaction packs it
// runs. The plugin asks for them once the session's rows name its organization and email, applies them to the gate (gate.ts), keeps
// them in its store for later sessions, and asks again every few minutes, so a change an admin makes reaches open sessions within the
// five minutes Mainwave's settings page promises.
//
// The request carries the organization ID and the email the session's rows name, and nothing else: no key, no account or device ID,
// no record. It goes in a POST body, so no request log keeps the address. Mainwave answers only for an organization and email its
// keyless ingest would route, and refuses the rest as keyless ingest does (403 `unclaimed` or `email_domain`).
//
// The answer goes to the gate: `data_points` as the explicit settings that win over everything else (`setOverrides`), and
// `redaction_packs` as the organization's packs, with those of its managed settings and the person's added (`setOrgPacks`). It is kept
// in the store under one key, `dataCollectionSettings`, as it came and with the organization it is for, written whole in one write, so
// a store is never left holding one organization's data points beside another's packs or name.
//
// What applies, in order:
//   - this load's answer, for the session's organization;
//   - else what the store keeps for that organization (the last answer an earlier session had);
//   - else nothing: the gate's defaults, required and metadata data points only, and the packs of managed settings or the default.
// Until a row names the organization, no answer kept for one applies. Settings written by hand under `dataPoints` and `redactionPacks`
// (as the tests and the end-to-end comparison do) apply to any session while the store keeps no answer: the store is a file the person
// can edit, so a convenience, not a control. A store that can't be read applies nothing of the organization's, and holds identifier
// and content values back, as the packs chosen are not known.
//
// Fail open: a request that fails, times out or is refused leaves the settings in force as they were, and the plugin asks again
// later. Nothing here holds a row, a turn or a tool call: the request goes from a timer, never from a hook.

import type { EngineInterface, Timer } from 'claude-code'

import { OVERRIDES_KEY, overridesOf, PACKS_KEY, packsOf, setOrgPacks, setOverrides, type Overrides, type PackChoice } from './gate.ts'
import { fetchWithin, type FetchOutcome } from './http.ts'
import { isOrgId } from './identity.ts'
import { collectorIn, namesOption, type Layer } from './settings.ts'

/** The plugin's read of its organization's settings, on Mainwave's API. */
export const SETTINGS_PATH = '/api/plugin/data-collection-settings'

/** Mainwave's API beside each of its collectors: the settings come from the Mainwave the copy goes to. */
const API_OF: Readonly<Record<string, string>> = {
  'https://collector.dev.mainwave.com': 'https://api.dev.mainwave.com',
  'https://collector.mainwave.com': 'https://api.mainwave.com',
}

/** Where the settings are read for a collector: its Mainwave's API, or, for any other collector (a local receiver), the collector itself. */
export function settingsUrlOf(collector: string): string {
  const base = collector.replace(/\/+$/, '')
  return `${API_OF[base] ?? base}${SETTINGS_PATH}`
}

/** Where the store keeps the last answer: `{ organizationId, revision, dataPoints, redactionPacks }`, the last two as they came. */
export const SETTINGS_KEY = 'dataCollectionSettings'
/** The longest wait a `Retry-After` may ask for. */
const MAX_RETRY_AFTER_MS = 60 * 60_000

/** How often the settings are asked for again while a session runs: within the five minutes the settings page promises. */
export const REFRESH_MS = 4 * 60_000
/** After a failure that can pass (no network, a timeout, the API busy), the first wait before asking again; it doubles up to `REFRESH_MS`. */
export const RETRY_MS = 30_000
/** How long one request may take. */
export const FETCH_TIMEOUT_MS = 5_000
/** An answer longer than this is not the settings. */
const MAX_ANSWER = 64 * 1024

/** The settings as Mainwave answers them: the parts the plugin keeps. */
export type OrgSettings = { revision: number; dataPoints: Readonly<Record<string, unknown>>; redactionPacks: readonly string[] }

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * The settings in an answer's body, or null when it is not an answer of the right shape: `revision` a whole number, `data_points` an
 * object of `on` and `off` (any other value, or an ID this version does not know, is kept as it came and ignored by the gate), and
 * `redaction_packs` a list of names. The other fields (`in_force`, the defaults) are not kept.
 */
export function settingsOf(text: string): OrgSettings | null {
  if (text.length > MAX_ANSWER) return null
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(body)) return null
  const { revision, data_points: dataPoints, redaction_packs: packs } = body
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null
  if (!isObject(dataPoints) || !Object.values(dataPoints).every(v => typeof v === 'string')) return null
  if (!Array.isArray(packs) || !packs.every(p => typeof p === 'string')) return null
  return { revision, dataPoints, redactionPacks: packs as string[] }
}

/** What one request came to, for the next try and the debug line: never the email. */
export type Outcome = 'ok' | 'invalid' | 'timeout' | 'failed' | 'stopped' | `${number}` | `403 ${string}`

/** How long a 429 asks the caller to wait (`Retry-After`, in seconds), at most an hour; 0 when it names no number of seconds. */
export function retryAfterOf(r: FetchOutcome): number {
  if (r.ok || r.reason !== 'status' || r.status !== 429) return 0
  const raw = Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]
  const seconds = raw !== undefined && /^\s*\d+\s*$/.test(raw) ? Number(raw) : 0
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
}

function outcomeOf(r: FetchOutcome): Outcome {
  if (r.ok) return 'ok'
  if (r.reason !== 'status') return r.reason
  if (r.status === 403) {
    try {
      const reason = (JSON.parse(r.text) as { reason?: unknown } | null)?.reason
      if (reason === 'unclaimed' || reason === 'email_domain') return `403 ${reason}`
    } catch {
      // A 403 that names no reason.
    }
  }
  return `${r.status}`
}

/**
 * How long to wait before asking again after an outcome: the refresh interval after an answer, and after a refusal that says no more
 * time will change this load (403, 404, 422, any other 4xx; a 429 too, as the organization's budget is shared by all its sessions, or
 * longer where its `Retry-After` says so); after one that can pass (no network, a timeout, a 5xx, an answer of the wrong shape),
 * `RETRY_MS`, doubling up to the interval.
 */
export function nextWait(outcome: Outcome, lastWait: number, retryAfterMs = 0): number {
  if (outcome === '429') return Math.max(REFRESH_MS, retryAfterMs)
  if (outcome === 'ok' || outcome.startsWith('4')) return REFRESH_MS
  if (outcome === 'stopped') return RETRY_MS
  return Math.min(Math.max(lastWait * 2, RETRY_MS), REFRESH_MS)
}

// Per load of the module; `resetOrgSettings` starts them over.
/** The session's organization and email, as its rows name them. */
let org: string | undefined
let email: string | undefined
/** This load's last answer, and whose it is. */
let fetched: (OrgSettings & { org: string }) | undefined
let last: Outcome | undefined
let retryAfterMs = 0
let wait = 0
let timer: Timer | null = null
let inflight = false
/** A timer's read of where to ask, and the request it makes, are under way: another timer that fires meanwhile asks nothing. */
let reading = false
/** The settings found the copy goes nowhere this load (a repository names the option, or the person's is malformed). */
let stoppedAsking = false
/** Whether the plugin sends a copy at all: it asks only while it does. */
let copying: () => boolean = () => true

/** Starts over for a load of the module: nothing known, nothing asked. */
export function resetOrgSettings(): void {
  timer?.cancel()
  timer = null
  org = undefined
  email = undefined
  fetched = undefined
  last = undefined
  retryAfterMs = 0
  wait = 0
  inflight = false
  reading = false
  stoppedAsking = false
  copying = () => true
}

/**
 * The organization's settings in force for the session, from this load's answer or the store, applied to the gate: the explicit
 * settings per data point, and the organization's packs. Read once per load, again before each send and at session end, so an answer
 * another session wrote reaches this one too. Each call sets both, so nothing an earlier organization's settings put in force outlives
 * a call. A store that can't be read applies none of the organization's data points, and holds identifier and content values back, as
 * the packs chosen are not known.
 */
export async function applyStoredSettings($: EngineInterface): Promise<void> {
  const read = (key: string) => $.store.get(key).then(v => ({ ok: true as const, v }), () => ({ ok: false as const }))
  const [kept, points, packs] = await Promise.all([read(SETTINGS_KEY), read(OVERRIDES_KEY), read(PACKS_KEY)])
  // Decided after the reads, against the organization as it is then: a row that named it while they ran counts.
  const answer = fetched !== undefined && fetched.org === org ? fetched : undefined
  let overrides: Overrides = {}
  let choice: PackChoice = undefined
  if (answer !== undefined) {
    overrides = overridesOf(answer.dataPoints)
    choice = packsOf(answer.redactionPacks)
  } else if (!kept.ok) {
    choice = 'unreadable'
  } else if (kept.v !== undefined && kept.v !== null) {
    // An answer kept for an organization: for its sessions alone. One of the wrong shape: for none.
    const k = isObject(kept.v) ? kept.v : {}
    if (isOrgId(k['organizationId']) && k['organizationId'] === org) {
      overrides = overridesOf(k['dataPoints'])
      choice = packsOf(k['redactionPacks'])
    }
  } else {
    // No answer kept: settings written by hand, for any session.
    overrides = points.ok ? overridesOf(points.v) : {}
    choice = packs.ok ? packsOf(packs.v) : 'unreadable'
  }
  setOverrides(overrides)
  setOrgPacks('settings', choice)
}

/** Keeps an answer, whole, in one write. A write that fails leaves the store as it was; the answer still applies this load. */
async function keep($: EngineInterface, forOrg: string, s: OrgSettings): Promise<void> {
  try {
    await $.store.set(SETTINGS_KEY, { organizationId: forOrg, revision: s.revision, dataPoints: s.dataPoints, redactionPacks: s.redactionPacks })
  } catch {
    // The next answer is kept instead.
  }
}

const same = (a: OrgSettings, b: OrgSettings) =>
  a.revision === b.revision && JSON.stringify(a.dataPoints) === JSON.stringify(b.dataPoints) && JSON.stringify(a.redactionPacks) === JSON.stringify(b.redactionPacks)

/** Asks once for the session's organization and email, applies and keeps the answer, and answers how it went. Never throws. */
export async function fetchNow($: EngineInterface, collector: string): Promise<Outcome | undefined> {
  if (inflight || org === undefined || email === undefined) return undefined
  inflight = true
  const forOrg = org
  const forEmail = email
  try {
    const r = await fetchWithin($, settingsUrlOf(collector), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claude_org_id: forOrg, email: forEmail }),
      timeoutMs: FETCH_TIMEOUT_MS,
    })
    let outcome = outcomeOf(r)
    retryAfterMs = retryAfterOf(r)
    const settings = r.ok ? settingsOf(r.text) : null
    if (r.ok && settings === null) outcome = 'invalid'
    // An answer for an organization the session no longer names is let go: the next try asks for the one it names.
    if (settings !== null && forOrg === org) {
      const changed = fetched === undefined || fetched.org !== forOrg || !same(fetched, settings)
      fetched = { ...settings, org: forOrg }
      setOverrides(overridesOf(settings.dataPoints))
      setOrgPacks('settings', packsOf(settings.redactionPacks))
      if (changed) await keep($, forOrg, settings)
    }
    last = outcome
    return outcome
  } catch {
    last = 'failed'
    return 'failed'
  } finally {
    inflight = false
  }
}

async function readLayer($: EngineInterface, source: 'user' | 'project' | 'local'): Promise<Layer> {
  try {
    return await $.settings.read({ source })
  } catch {
    return 'unreadable'
  }
}

/**
 * Where the copy goes as the settings say now, read afresh as each request leaves, so the settings come from the Mainwave the person's
 * user settings name. `held` while those can't be read (they may name another): ask again later. `stop` where they name no collector of
 * the right shape, or a repository names the option (or can't be read), as the copy then goes nowhere: ask nothing more this load.
 */
async function collectorNow($: EngineInterface): Promise<string | 'held' | 'stop'> {
  const [user, project, local] = await Promise.all([readLayer($, 'user'), readLayer($, 'project'), readLayer($, 'local')])
  if (namesOption(project) || namesOption(local)) return 'stop'
  const where = collectorIn(user)
  return where === 'unreadable' ? 'held' : where === 'malformed' ? 'stop' : where
}

/** Asks after `ms`, then again on the outcome's wait, for as long as the load runs; one timer at a time. */
function schedule($: EngineInterface, ms: number): void {
  timer?.cancel()
  try {
    timer = $.clock.after(Math.max(1, ms), () => {
      timer = null
      // The copy turned off (a repository named the collector option, or the person's is malformed): nothing is sent, so nothing is
      // asked, until the plugin loads again.
      if (!copying() || stoppedAsking) return
      // A read already under way: its request schedules the next.
      if (reading) return
      const asked = `${org} ${email}`
      reading = true
      void collectorNow($)
        .then(
          where => (where === 'held' || where === 'stop' ? where : fetchNow($, where)),
          () => 'held' as const,
        )
        .finally(() => (reading = false))
        .then(outcome => {
          // Not asked (a request already out, or nothing to ask with): the request out schedules the next.
          if (outcome === undefined) return
          // The copy goes nowhere this load: nothing more is asked.
          if (outcome === 'stop') {
            stoppedAsking = true
            timer?.cancel()
            timer = null
            return
          }
          // The person's settings can't be read: ask again later.
          if (outcome === 'held') {
            if (timer === null && copying()) schedule($, RETRY_MS)
            return
          }
          wait = nextWait(outcome, wait, retryAfterMs)
          // The session named another organization or email while it asked: ask again for those at once.
          if (timer === null) schedule($, asked === `${org} ${email}` ? wait : 0)
        }, () => undefined)
    })
  } catch {
    timer = null
  }
}

/**
 * What a row said about who the session is. A new organization brings its own settings, from the store until Mainwave answers; with
 * its email known, the plugin asks at once, and every `REFRESH_MS` after, while `sending` says it sends a copy at all.
 */
export async function noteSessionIdentity($: EngineInterface, who: { organizationId?: string; email?: string }, sending: () => boolean): Promise<void> {
  copying = sending
  const orgChanged = who.organizationId !== undefined && who.organizationId !== org
  const emailChanged = who.email !== undefined && who.email !== email
  if (!orgChanged && !emailChanged) return
  if (orgChanged) org = who.organizationId
  if (emailChanged) email = who.email
  if (orgChanged) await applyStoredSettings($)
  if (copying() && org !== undefined && email !== undefined) {
    wait = 0
    schedule($, 0)
  }
}

/** As a session starts: asks again at once, if the organization and email are known and no request is out. */
export function ensureFetching($: EngineInterface): void {
  if (!inflight && !reading && org !== undefined && email !== undefined) schedule($, 0)
}

/** Where the settings in force came from, for the end-of-session debug line: never the email. */
export function settingsSummary(): string {
  const tried = last === undefined ? '' : `; last request: ${last}`
  if (org === undefined || email === undefined) return 'not asked: no organization and email named yet'
  if (fetched !== undefined && fetched.org === org) return `from Mainwave, revision ${fetched.revision}${tried}`
  return `not answered yet, the store's or the defaults apply${tried}`
}

/**
 * Whether the organization's settings were asked for and can't be had: no answer this load, and the last request timed out, failed,
 * was answered with something not settings, or refused for now (429, a 5xx). The defaults, or the store's, apply. A 403 (the
 * organization not claimed) and a 404 (the route off) say what Mainwave already knows, and a request not made yet says nothing.
 */
export function settingsUnavailable(): boolean {
  if (org === undefined || email === undefined || (fetched !== undefined && fetched.org === org) || last === undefined) return false
  return last === 'timeout' || last === 'failed' || last === 'invalid' || last === '429' || /^5\d\d$/.test(last)
}

/** For tests: what this load holds. */
export const orgSettingsState = () => ({ org, fetched, last, wait, scheduled: timer !== null })
