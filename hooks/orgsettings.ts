// The organization's data collection settings, from Mainwave: which data points it turned on or off, and which redaction packs it
// runs. The plugin asks for them once the session's rows name its organization and email, applies them to the gate (gate.ts), keeps
// them in its store for later sessions, and asks again every few minutes, so a change an admin makes reaches open sessions within the
// five minutes Mainwave's settings page promises.
//
// The request carries the organization ID and the email the session's rows name, and nothing else: no key, no account or device ID,
// no record. It goes in a POST body, so no request log keeps the address. Mainwave answers only for an organization and email its
// keyless ingest would route, and refuses the rest as keyless ingest does (403 `unclaimed` or `email_domain`).
//
// The answer goes into the store as it came: `data_points` under `dataPoints` (gate.ts, `OVERRIDES_KEY`), the explicit settings that
// win over everything else; `redaction_packs` under `redactionPacks` (`PACKS_KEY`), the organization's packs, with those of its
// managed settings and the person's added. Beside them, `dataCollectionSettings` says whose they are, so they apply to that
// organization's sessions alone.
//
// What applies, in order:
//   - this load's answer, for the session's organization;
//   - else what the store keeps for that organization (the last answer an earlier session had);
//   - else nothing: the gate's defaults, required and metadata data points only, and the packs of managed settings or the default.
// Until a row names the organization, no answer kept for one applies. Settings in the store that name no organization (written by
// hand, as the tests and the end-to-end comparison do) apply to any session until an answer replaces them: the store is a file the
// person can edit, so a convenience, not a control.
//
// Fail open: a request that fails, times out or is refused leaves the settings in force as they were, and the plugin asks again
// later. Nothing here holds a row, a turn or a tool call: the request goes from a timer, never from a hook.

import type { EngineInterface, Timer } from 'claude-code'

import { OVERRIDES_KEY, overridesOf, PACKS_KEY, packsOf, setOrgPacks, setOverrides, type Overrides, type PackChoice } from './gate.ts'
import { fetchWithin, type FetchOutcome } from './http.ts'
import { isOrgId } from './identity.ts'

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

/** Where the store says whose the settings under `dataPoints` and `redactionPacks` are: `{ organizationId, revision }`. */
export const META_KEY = 'dataCollectionSettings'

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
 * time will change this load (403, 404, 422, any other 4xx; a 429 too, as the organization's budget is shared by all its sessions);
 * after one that can pass (no network, a timeout, a 5xx, an answer of the wrong shape), `RETRY_MS`, doubling up to the interval.
 */
export function nextWait(outcome: Outcome, lastWait: number): number {
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
let wait = 0
let timer: Timer | null = null
let inflight = false
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
  wait = 0
  inflight = false
  copying = () => true
}

/**
 * The organization's settings in force for the session, from this load's answer or the store, applied to the gate: the explicit
 * settings per data point, and the organization's packs. Read once per load, again before each send and at session end, so an answer
 * another session wrote reaches this one too. A store that can't be read leaves the explicit settings held, and holds identifier and
 * content values back, as the packs chosen are not known.
 */
export async function applyStoredSettings($: EngineInterface): Promise<void> {
  const read = (key: string) => $.store.get(key).then(v => ({ ok: true as const, v }), () => ({ ok: false as const }))
  const [points, packs, meta] = await Promise.all([read(OVERRIDES_KEY), read(PACKS_KEY), read(META_KEY)])
  // Decided after the reads, against the organization as it is then: a row that named it while they ran counts.
  const answer = fetched !== undefined && fetched.org === org ? fetched : undefined
  if (answer !== undefined) {
    setOverrides(overridesOf(answer.dataPoints))
    setOrgPacks('settings', packsOf(answer.redactionPacks))
    return
  }
  if (!meta.ok) {
    setOrgPacks('settings', 'unreadable')
    return
  }
  const owner = isObject(meta.v) ? meta.v['organizationId'] : undefined
  // Kept for an organization: for its sessions alone. Kept for none (by hand): for any.
  const applies = meta.v === undefined || meta.v === null || (isOrgId(owner) && owner === org)
  const overrides: Overrides = applies && points.ok ? overridesOf(points.v) : {}
  if (points.ok || !applies) setOverrides(overrides)
  const choice: PackChoice = !applies ? undefined : packs.ok ? packsOf(packs.v) : 'unreadable'
  setOrgPacks('settings', choice)
}

/**
 * Keeps an answer: the store's three keys rewritten, whose first, removed while the others change, so a store left half written
 * names no organization's settings it does not hold. A write that fails removes what it can; the answer still applies this load.
 */
async function keep($: EngineInterface, forOrg: string, s: OrgSettings): Promise<void> {
  try {
    await $.store.delete(META_KEY)
    await $.store.set(OVERRIDES_KEY, s.dataPoints)
    await $.store.set(PACKS_KEY, s.redactionPacks)
    await $.store.set(META_KEY, { organizationId: forOrg, revision: s.revision })
  } catch {
    await Promise.all([OVERRIDES_KEY, PACKS_KEY, META_KEY].map(k => $.store.delete(k).catch(() => undefined)))
  }
}

const same = (a: OrgSettings, b: OrgSettings) =>
  a.revision === b.revision && JSON.stringify(a.dataPoints) === JSON.stringify(b.dataPoints) && JSON.stringify(a.redactionPacks) === JSON.stringify(b.redactionPacks)

/** Asks once for the session's organization and email, applies and keeps the answer, and answers how it went. Never throws. */
export async function fetchNow($: EngineInterface, collector: string): Promise<Outcome | undefined> {
  if (inflight || org === undefined || email === undefined) return undefined
  inflight = true
  const forOrg = org
  try {
    const r = await fetchWithin($, settingsUrlOf(collector), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claude_org_id: forOrg, email }),
      timeoutMs: FETCH_TIMEOUT_MS,
    })
    let outcome = outcomeOf(r)
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

/** Asks after `ms`, then again on the outcome's wait, for as long as the load runs; one timer at a time. */
function schedule($: EngineInterface, collector: string, ms: number): void {
  timer?.cancel()
  try {
    timer = $.clock.after(Math.max(1, ms), () => {
      timer = null
      // The copy turned off (a repository named the key option): nothing is sent, so nothing is asked, until the plugin loads again.
      if (!copying()) return
      const asked = org
      void fetchNow($, collector).then(outcome => {
        // Not asked (a request already out, or nothing to ask with): the request out schedules the next.
        if (outcome === undefined) return
        wait = nextWait(outcome, wait)
        // The session named another organization while it asked: ask again for that one at once.
        if (timer === null) schedule($, collector, asked === org ? wait : 0)
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
export async function noteSessionIdentity($: EngineInterface, collector: string, who: { organizationId?: string; email?: string }, sending: () => boolean): Promise<void> {
  copying = sending
  const orgChanged = who.organizationId !== undefined && who.organizationId !== org
  const emailChanged = who.email !== undefined && who.email !== email
  if (!orgChanged && !emailChanged) return
  if (orgChanged) org = who.organizationId
  if (emailChanged) email = who.email
  if (orgChanged) await applyStoredSettings($)
  if (copying() && org !== undefined && email !== undefined) {
    wait = 0
    schedule($, collector, 0)
  }
}

/** As a session starts: asks again at once, if the organization and email are known and no request is out. */
export function ensureFetching($: EngineInterface, collector: string): void {
  if (!inflight && org !== undefined && email !== undefined) schedule($, collector, 0)
}

/** Where the settings in force came from, for the end-of-session debug line: never the email. */
export function settingsSummary(): string {
  const tried = last === undefined ? '' : `; last request: ${last}`
  if (org === undefined || email === undefined) return 'not asked: no organization and email named yet'
  if (fetched !== undefined && fetched.org === org) return `from Mainwave, revision ${fetched.revision}${tried}`
  return `not answered yet, the store's or the defaults apply${tried}`
}

/** For tests: what this load holds. */
export const orgSettingsState = () => ({ org, fetched, last, wait, scheduled: timer !== null })
