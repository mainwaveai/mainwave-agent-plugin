// Test only: the hooks module of a throwaway plugin tests/e2e/compare.mjs builds in a temporary folder and loads ahead of the plugin in
// its handoff pass. It writes what Claude Code gives a plugin as the session's turn begins, as JSON lines to the file MW_E2E_OBSERVE
// names: each prompt submitted, the text each main-loop turn began with, and the transcript's newest messages at the turn's start and
// at its first model request. So the pass can check the session began its turn as Cowork's handoff does: with no text, the person's
// message already in the transcript, behind the chat's calls. It changes nothing, and a fault of its own goes unrecorded.
//
// It is not a plugin in this repository: a second `.claude-plugin/plugin.json` anywhere in it fails org sync's validation, which takes
// the repository root as the one plugin (scripts/check-layout.sh).

import type { EngineInterface, Register } from 'claude-code'

type Message = { role?: unknown; text?: unknown; toolUses?: readonly unknown[]; toolResults?: readonly unknown[] }
type Messages = { session: { messages: (args: { last: number }) => Promise<readonly Message[] | { deny: string }> } }

const lines: string[] = []
let writing: Promise<unknown> = Promise.resolve()
/** The main-loop turns whose first model request has been recorded. */
const stepped = new Set<string>()

function record($: EngineInterface, line: Record<string, unknown>): void {
  lines.push(JSON.stringify(line))
  writing = writing
    .then(async () => {
      const file = await $.env.get('MW_E2E_OBSERVE')
      if (file) await $.fs.write(file, `${lines.join('\n')}\n`)
    })
    .catch(() => undefined)
}

/** The transcript's newest messages, each as its role, its text and how many tool calls and results it holds. */
async function newest($: EngineInterface): Promise<unknown> {
  try {
    const list = await ($ as unknown as Messages).session.messages({ last: 20 })
    if (!Array.isArray(list)) return list
    return list.map(m => ({ role: m.role, text: typeof m.text === 'string' ? m.text : null, toolUses: m.toolUses?.length ?? 0, toolResults: m.toolResults?.length ?? 0 }))
  } catch (err) {
    return { error: String(err) }
  }
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    record($, { event: 'prompt.submit', text: e.text, isMeta: e.isMeta === true })
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) record($, { event: 'turn.start', text: e.text, messages: await newest($) })
    return next(e)
  })
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && !stepped.has(e.turnId)) {
      stepped.add(e.turnId)
      record($, { event: 'turn.step', messages: await newest($) })
    }
    return yield* next(e)
  })
}
