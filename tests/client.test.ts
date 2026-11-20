// The client a remote Cowork prompt was sent from, read from the transcript's lines: called directly.

import { describe, expect, test } from 'claude-code/testing'

import { clientPlatformIn } from '../hooks/client.ts'

const line = (row: Record<string, unknown>) => `${JSON.stringify({ sessionId: 's-1', timestamp: '2026-11-19T21:50:00.000Z', ...row })}\n`
const prompt = (promptId: string, fields: Record<string, unknown> = {}) =>
  line({ type: 'user', promptId, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }, origin: { kind: 'human' }, ...fields })
const result = (promptId: string, fields: Record<string, unknown> = {}) =>
  line({ type: 'user', promptId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }, ...fields })

describe('clientPlatformIn', () => {
  test("the client on the prompt's own row, by its prompt id: not a later prompt's, nor an earlier one's", () => {
    const text = `${prompt('p-1', { clientPlatform: 'desktop_app' })}${result('p-1')}${prompt('p-2', { clientPlatform: 'ios' })}`
    expect(clientPlatformIn(text, 'p-1')).toBe('desktop_app')
    expect(clientPlatformIn(text, 'p-2')).toBe('ios')
  })

  test("passes the host's word through: a client of the stamp's shape not seen before goes as it is", () => {
    expect(clientPlatformIn(prompt('p-1', { clientPlatform: 'android' }), 'p-1')).toBe('android')
    expect(clientPlatformIn(prompt('p-1', { clientPlatform: 'web_claude_ai' }), 'p-1')).toBe('web_claude_ai')
  })

  test("a tool's results and a row Claude Code added are not the prompt's row, whatever client they name", () => {
    const text = `${result('p-1', { clientPlatform: 'ios' })}${prompt('p-1', { isMeta: true, clientPlatform: 'claude_code_cli' })}${prompt('p-1', { clientPlatform: 'desktop_app' })}`
    expect(clientPlatformIn(text, 'p-1')).toBe('desktop_app')
    expect(clientPlatformIn(`${result('p-1', { clientPlatform: 'ios' })}`, 'p-1')).toBeNull()
  })

  test('the first row of the prompt decides: one that names no client, or one not of its shape, gives none', () => {
    expect(clientPlatformIn(`${prompt('p-1')}${prompt('p-1', { clientPlatform: 'ios' })}`, 'p-1')).toBeUndefined()
    for (const bad of ['', 'Desktop', 'desktop app', 'desktop-app', 'a'.repeat(33), 7, null, ['ios'], { kind: 'ios' }]) {
      expect(clientPlatformIn(prompt('p-1', { clientPlatform: bad }), 'p-1')).toBeUndefined()
    }
  })

  test('no row of the prompt: null; a line cut where the read began, a row of another kind, or text that is not JSON, are skipped', () => {
    expect(clientPlatformIn('', 'p-1')).toBeNull()
    expect(clientPlatformIn(prompt('p-1', { clientPlatform: 'ios' }), 'p-2')).toBeNull()
    expect(clientPlatformIn(prompt('p-1', { clientPlatform: 'ios' }), '')).toBeNull()
    const cut = prompt('p-1', { clientPlatform: 'ios' }).slice(10)
    expect(clientPlatformIn(cut, 'p-1')).toBeNull()
    expect(clientPlatformIn(`${line({ type: 'assistant', promptId: 'p-1', clientPlatform: 'ios' })}not json p-1\n`, 'p-1')).toBeNull()
    expect(clientPlatformIn(`${cut}${prompt('p-1', { clientPlatform: 'desktop_app' })}`, 'p-1')).toBe('desktop_app')
  })

  test("a prompt carried over from chat at a handover, which names no prompt of the session's and no client: none", () => {
    const text = `${line({ type: 'user', handedOff: true, origin: { kind: 'human' }, message: { role: 'user', content: 'hello' } })}${line({ type: 'system', subtype: 'upgrade_relay_marker', content: '{}' })}`
    expect(clientPlatformIn(text, 'p-1')).toBeNull()
  })
})
