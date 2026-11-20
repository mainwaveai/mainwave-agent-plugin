// The client a remote Cowork prompt was sent from: the desktop app, a browser, a phone. Pure: register.ts reads the transcript and
// stamps what this finds, tests drive it.
//
// Cowork's host writes it on the prompt's row in the session's transcript (`clientPlatform`, beside `message`), and nowhere else: no
// hook event carries it, nor the environment. A conversation can move between clients, so it is read per prompt, from the row of the
// prompt the turn's rows carry the id of (`promptId`, which Claude Code writes on each user row of a prompt).

import { CLIENT_PLATFORM } from './stamps.ts'

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Whether a user row's message is a tool's results, or the mark an interrupted request leaves, rather than a prompt. */
function notPrompt(message: unknown): boolean {
  const content = isObject(message) ? message['content'] : undefined
  const blocks = Array.isArray(content) ? content : [content]
  return blocks.some(b => (isObject(b) && b['type'] === 'tool_result') || (typeof b === 'string' && b.startsWith('[Request interrupted by user')) ||
    (isObject(b) && b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].startsWith('[Request interrupted by user')))
}

/**
 * What a stretch of transcript lines (JSON, one row a line; its end) says of the client the prompt `promptId` was sent from:
 *
 * - the `clientPlatform` of that prompt's own row: the first user row of the prompt that is not a tool's results, the mark an
 *   interrupted request leaves, or a row Claude Code added (`isMeta`, a compaction's summary, a row kept for the transcript alone);
 * - undefined where that row names none, or one not of the stamp's shape (a prompt carried over from chat at a handover names none);
 * - `null` where that row is not in the text and may be further back: the text holds rows of that prompt, or none of another's;
 * - `false` where the text holds another prompt's rows and none of this one's: the newest prompt's row comes after every earlier
 *   one's, so it is not written (yet), or the prompt has none.
 *
 * A line cut where the read began is skipped.
 */
export function clientPlatformIn(text: string, promptId: string): string | undefined | null | false {
  if (promptId === '') return false
  let ours = false
  let others = false
  for (const line of text.split('\n')) {
    if (!line.includes('"promptId"')) continue
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(row) || row['type'] !== 'user' || typeof row['promptId'] !== 'string') continue
    if (row['promptId'] !== promptId) {
      others = true
      continue
    }
    ours = true
    if (row['isMeta'] === true || row['isCompactSummary'] === true || row['isVisibleInTranscriptOnly'] === true || notPrompt(row['message'])) continue
    const client = row['clientPlatform']
    return typeof client === 'string' && CLIENT_PLATFORM.test(client) ? client : undefined
  }
  return others && !ours ? false : null
}
