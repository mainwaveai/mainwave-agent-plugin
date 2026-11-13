// The fetch wrapper, called directly with a `$` of the test's own: a clock whose waits the test ends, and a fetch the test answers.

import type { EngineInterface, HttpInit, HttpResponse } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_TIMEOUT_MS, endSession, fetchWithin } from '../hooks/http.ts'
import { sessionEnd } from '../hooks/register.ts'

const URL = 'https://api.example.com/v1/ping'

type Wait = { ms: number; aborted: boolean; elapse: () => void }

/** A `$` with `clock.sleep` and `http.fetch` only. `answer` decides each request; `armed: false` makes the clock throw. */
function fake(answer: (url: string, init?: HttpInit) => Promise<HttpResponse>, armed = true) {
  const waits: Wait[] = []
  const requests: { url: string; init?: HttpInit }[] = []
  const $ = {
    clock: {
      sleep: (ms: number, options?: { signal?: AbortSignal }) => {
        if (!armed) throw new Error('no clock')
        return new Promise<void>((resolve, reject) => {
          const wait: Wait = { ms, aborted: false, elapse: resolve }
          waits.push(wait)
          options?.signal?.addEventListener('abort', () => {
            wait.aborted = true
            reject(new Error('aborted'))
          })
        })
      },
    },
    http: {
      fetch: (url: string, init?: HttpInit) => {
        requests.push({ url, init })
        return answer(url, init)
      },
    },
  } as unknown as EngineInterface
  return { $, waits, requests }
}

const respond = (status: number, text = '', headers: Record<string, string> = {}) => async (): Promise<HttpResponse> => ({ status, ok: status >= 200 && status < 300, headers, text })
const hang = () => new Promise<HttpResponse>(() => undefined)
/** Lets every promise already settled run its handlers. */
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('fetchWithin', () => {
  test('a 2xx answer comes back with its status, headers and body; the limit never reaches the request', async () => {
    const f = fake(respond(200, '{"a":1}', { 'content-type': 'application/json' }))
    const init = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }
    expect(await fetchWithin(f.$, URL, { ...init, timeoutMs: 1_000 })).toEqual({ ok: true, status: 200, headers: { 'content-type': 'application/json' }, text: '{"a":1}' })
    expect(f.requests).toEqual([{ url: URL, init }])
  })

  test('a non-2xx answer is a status outcome, not a throw', async () => {
    expect(await fetchWithin(fake(respond(503, 'busy')).$, URL)).toEqual({ ok: false, reason: 'status', status: 503, text: 'busy' })
  })

  test('a rejected request is a failed outcome, not a throw', async () => {
    const f = fake(() => Promise.reject(new Error('web fetch is off for this organization')))
    expect(await fetchWithin(f.$, URL)).toEqual({ ok: false, reason: 'failed' })
  })

  test('a fetch that throws as it is called is a failed outcome, not a throw', async () => {
    const f = fake(() => { throw new Error('bad url') })
    expect(await fetchWithin(f.$, URL)).toEqual({ ok: false, reason: 'failed' })
  })

  test('no answer within the limit times out', async () => {
    const f = fake(hang)
    const pending = fetchWithin(f.$, URL, { timeoutMs: 1_000 })
    let settled = false
    void pending.then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)
    expect(f.waits.map(w => w.ms)).toEqual([1_000])
    f.waits[0]!.elapse()
    expect(await pending).toEqual({ ok: false, reason: 'timeout' })
  })

  test('the default limit applies when none is named', async () => {
    const f = fake(hang)
    const pending = fetchWithin(f.$, URL)
    await tick()
    expect(f.waits.map(w => w.ms)).toEqual([DEFAULT_TIMEOUT_MS])
    f.waits[0]!.elapse()
    expect(await pending).toEqual({ ok: false, reason: 'timeout' })
  })

  test('the end of the session answers a waiting request at once, and its timer is let go', async () => {
    const f = fake(hang)
    const pending = fetchWithin(f.$, URL, { timeoutMs: 60_000 })
    await tick()
    endSession()
    expect(await pending).toEqual({ ok: false, reason: 'stopped' })
    expect(f.waits.every(w => w.aborted)).toBe(true)
  })

  test('a request made after a session ended belongs to the next one and goes out', async () => {
    endSession()
    expect(await fetchWithin(fake(respond(204)).$, URL)).toEqual({ ok: true, status: 204, headers: {}, text: '' })
  })

  test('an answer before the limit lets the timer go', async () => {
    const f = fake(respond(200, 'ok'))
    expect((await fetchWithin(f.$, URL, { timeoutMs: 1_000 })).ok).toBe(true)
    expect(f.waits.length).toBe(1)
    expect(f.waits[0]!.aborted).toBe(true)
  })

  test('an answer after the session ended is dropped', async () => {
    let release: (r: HttpResponse) => void = () => undefined
    const f = fake(() => new Promise<HttpResponse>(resolve => { release = resolve }))
    const pending = fetchWithin(f.$, URL)
    await tick()
    endSession()
    release({ status: 200, ok: true, headers: {}, text: 'late' })
    expect(await pending).toEqual({ ok: false, reason: 'stopped' })
  })

  test('a sleep that fails early answers timeout, never an unbounded wait', async () => {
    const f = fake(hang)
    ;(f.$.clock as { sleep: unknown }).sleep = () => Promise.reject(new Error('refused by a hook'))
    expect(await fetchWithin(f.$, URL)).toEqual({ ok: false, reason: 'timeout' })
  })

  test('a clock that cannot be armed leaves the request to answer alone', async () => {
    const f = fake(respond(200, 'ok'), false)
    expect((await fetchWithin(f.$, URL)).ok).toBe(true)
  })
})

describe('session.end', () => {
  // The kit loads the plugin in an environment of its own, so a request started here is answered through the hook's body, called directly.
  test("the plugin's session.end hook ends a waiting request and passes the event on unchanged", async () => {
    const pending = fetchWithin(fake(hang).$, URL, { timeoutMs: 60_000 })
    await tick()
    const event = { reason: 'clear', sessionId: 's-1' }
    const passed: unknown[] = []
    const next = Object.assign((e: unknown) => {
      passed.push(e)
      return { sessionId: 's-1' }
    }, { budget: { ms: 2_000, remainingMs: 2_000 } })
    expect(await sessionEnd(undefined as never, event as never, next as never)).toEqual({ sessionId: 's-1' })
    expect(passed).toEqual([event])
    expect(await pending).toEqual({ ok: false, reason: 'stopped' })
  })

  test('the plugin passes session.end on to the engine', async ($, on) => {
    const ended: string[] = []
    on('session.end', (_$, e) => {
      ended.push((e as { sessionId: string }).sessionId)
      return { sessionId: (e as { sessionId: string }).sessionId } as never
    })
    await $.session.end({ reason: 'clear', sessionId: 's-1' } as never)
    expect(ended).toEqual(['s-1'])
  })
})
