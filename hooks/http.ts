// The one way the plugin makes a request: `$.http.fetch` with a time limit, cancelled when the session it was made for ends.
//
// `$.http.fetch` has no timeout and no abort of its own, so a request that hangs would hold whatever awaits it. Here a request is
// raced against the engine's clock and against the end of its session; whichever comes first answers. The request itself may still
// finish on the host, but nothing waits for it and its answer is dropped. It never throws: every outcome is a value.
//
// The sender (sender.ts) and the request for the organization's settings (orgsettings.ts) make every request through it. The wait is billed to the calling hook's own time budget (`$.clock.sleep`
// counts there), so a caller makes its requests from `session.start`, `session.end` or a timer, not from a row's hook, and names a
// limit that fits.

import type { EngineInterface, HttpInit } from 'claude-code'

/** How long a request may take when the caller names no limit. */
export const DEFAULT_TIMEOUT_MS = 5_000

export type FetchOutcome =
  | { ok: true; status: number; headers: Record<string, string>; text: string }
  /** The host answered with a status outside 2xx. */
  | { ok: false; reason: 'status'; status: number; text: string }
  /** No answer within the limit. */
  | { ok: false; reason: 'timeout' }
  /** The session the request was made for ended first, or had already ended. */
  | { ok: false; reason: 'stopped' }
  /** The host refused or failed the request (an organization's web-fetch policy, no network, a bad URL). */
  | { ok: false; reason: 'failed' }

// The session's lifetime. `endSession` aborts it, which answers `stopped` to every request still waiting, and starts the next one:
// after a /clear, Claude Code goes on under a new session id without a new `session.start`.
let lifetime = new AbortController()

/** Ends the current session's lifetime: every request still waiting answers `stopped`. Called from the `session.end` hook. */
export function endSession(): void {
  const ended = lifetime
  lifetime = new AbortController()
  ended.abort()
}

const NEVER = new Promise<never>(() => undefined)

/** `$.http.fetch(url, init)`, answered within `timeoutMs` or when the session ends, whichever is first. */
export async function fetchWithin($: EngineInterface, url: string, init: HttpInit & { timeoutMs?: number } = {}): Promise<FetchOutcome> {
  const session = lifetime.signal
  if (session.aborted) return { ok: false, reason: 'stopped' }
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...request } = init
  const timer = new AbortController()
  let onEnd = () => undefined as void
  const ended = new Promise<FetchOutcome>(resolve => {
    onEnd = () => resolve({ ok: false, reason: 'stopped' })
    session.addEventListener('abort', onEnd, { once: true })
  })
  // The sleep is aborted once the race is settled, and its rejection then answers nothing. A sleep that fails before that (refused by
  // a hook, or its dispatch abandoned) answers `timeout` at once: the request never waits without a limit. Only a clock that cannot be
  // armed at all leaves the request to answer alone, as it would without this wrapper.
  const TIMEOUT: FetchOutcome = { ok: false, reason: 'timeout' }
  let limit: Promise<FetchOutcome>
  try {
    limit = $.clock.sleep(timeoutMs, { signal: timer.signal }).then(
      () => TIMEOUT,
      () => (timer.signal.aborted ? NEVER : TIMEOUT),
    )
  } catch {
    limit = NEVER
  }
  let sent: Promise<FetchOutcome>
  try {
    sent = $.http.fetch(url, request).then(
      (res): FetchOutcome =>
        res.ok ? { ok: true, status: res.status, headers: res.headers, text: res.text } : { ok: false, reason: 'status', status: res.status, text: res.text },
      (): FetchOutcome => ({ ok: false, reason: 'failed' }),
    )
  } catch {
    sent = Promise.resolve({ ok: false, reason: 'failed' })
  }
  try {
    return await Promise.race([sent, limit, ended])
  } finally {
    timer.abort()
    session.removeEventListener('abort', onEnd)
  }
}
