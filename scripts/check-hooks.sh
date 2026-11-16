#!/bin/sh
# What the engine will load, as `claude plugin validate --json` reports it: the collector row hook, and the tool call, command, prompt
# and spawn hooks, each with its fail-open `.catch`; the turn hooks the rebuilt spans need; and session.end. A hook dropped, or a `.catch`
# removed, fails here: the unit tests call the hook bodies, not the registrations.
set -eu
cd "$(dirname "$0")/.."
claude plugin validate . --json | node -e '
let s = ""
process.stdin.on("data", d => (s += d)).on("end", () => {
  const report = JSON.parse(s)
  const hooks = (report.contents ?? []).filter(c => c.type === "hooks")
  const notes = hooks.flatMap(c => c.notes ?? [])
  const gating = hooks.flatMap(c => c.gatingHooks ?? [])
  const fail = []
  if (!notes.some(n => /hooks: .*\btelemetry\.log\{to=collector\}/.test(n))) fail.push("no telemetry.log hook on the collector stream")
  for (const h of ["session.end", "turn.start", "turn.step", "turn.complete"]) {
    if (!notes.some(n => new RegExp(`hooks: .*\\b${h.replace(".", "\\.")}\\b`).test(n))) fail.push(`no ${h} hook`)
  }
  for (const h of ["telemetry.log{to=collector}", "tool.call", "command.run", "prompt.submit", "agent.spawn"]) {
    const g = gating.find(x => x.hook === h)
    if (g === undefined || g.hasCatch !== true) fail.push(`the ${h} hook has no .catch`)
  }
  if (fail.length) { console.error("check-hooks: " + fail.join("; ")); process.exit(1) }
  console.log("hooks: telemetry.log{to=collector}, tool.call, command.run, prompt.submit and agent.spawn with .catch; turn.start, turn.step, turn.complete, session.end")
})'
