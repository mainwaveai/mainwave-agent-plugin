// The client a remote Cowork prompt was sent from: the desktop app, a browser, a phone. Pure: register.ts reads the transcript and
// stamps what this finds, tests drive it.
//
// Cowork's host writes it on the prompt's row in the session's transcript (`clientPlatform`, beside `message`), and nowhere else: no
// hook event carries it, nor the environment. A conversation can move between clients, so it is read per prompt, from the row of the
// prompt the turn's rows carry the id of (`promptId`, which Claude Code writes on each user row of a prompt).

import { CLIENT_PLATFORM } from './stamps.ts'

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Whether a user row's message is a tool's results rather than a prompt. */
function toolResults(message: unknown): boolean {
  const content = isObject(message) ? message['content'] : undefined
  return Array.isArray(content) && content.some(b => isObject(b) && b['type'] === 'tool_result')
}

/**
 * The client the prompt `promptId` was sent from, from a stretch of transcript lines (JSON, one row a line; its end at least): the
 * `clientPlatform` of that prompt's own row, the first user row of the prompt that is neither a tool's results nor one Claude Code
 * added (`isMeta`). Undefined where that row names none, or one not of the stamp's shape (a prompt carried over from chat at a handover
 * names none); `null` where no row of that prompt is in the text (not written yet, or before where the read began). A line cut where
 * the read began is skipped.
 */
export function clientPlatformIn(text: string, promptId: string): string | undefined | null {
  if (promptId === '') return null
  for (const line of text.split('\n')) {
    if (!line.includes(promptId)) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(row) || row['type'] !== 'user' || row['promptId'] !== promptId || row['isMeta'] === true || toolResults(row['message'])) continue
    const client = row['clientPlatform']
    return typeof client === 'string' && CLIENT_PLATFORM.test(client) ? client : undefined
  }
  return null
}
