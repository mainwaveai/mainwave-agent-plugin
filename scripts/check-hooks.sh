#!/bin/sh
# What the engine will load, as `claude plugin validate --json` reports it: the collector row hook, and the tool call, tool run,
# command, prompt and spawn hooks (the markers come from the tool call and prompt hooks), and the hook on the response rows a
# conversation keeps (the rows built without Claude Code's take their request ID by them), each with its fail-open `.catch`; the turn
# hooks the rebuilt spans and the turn failure marker need; the permission check and the classifier's answer the rows built without
# Claude Code's say a call was settled by (the tool run hook says when), and the session's measures their cost outside a request goes
# with; the skill prompt hook; and session.end. A hook dropped, or a `.catch`
# removed, fails here: the unit tests call the hook bodies, not the registrations. So does any `classic.*` hook: Claude Code's security
# default (seated for Team and Enterprise organizations, wherever managed settings are, and in remote Cowork) skips every classic hook
# of a plugin a person installs or an organization syncs, so nothing the plugin does may hang on one.
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
  for (const h of ["session.end", "turn.start", "turn.step", "turn.complete", "tool.check", "tool.judge", "session.measure", "skill.prompt"]) {
    if (!notes.some(n => new RegExp(`hooks: .*\\b${h.replace(".", "\\.")}\\b`).test(n))) fail.push(`no ${h} hook`)
  }
  for (const h of ["telemetry.log{to=collector}", "tool.call", "tool.run", "command.run", "prompt.submit", "agent.spawn", "session.append{door=response}"]) {
    const g = gating.find(x => x.hook === h)
    if (g === undefined || g.hasCatch !== true) fail.push(`the ${h} hook has no .catch`)
  }
  const classic = [...new Set([
    ...notes.flatMap(n => (/ hooks: (.*)$/.exec(n)?.[1] ?? "").split(", ")),
    ...gating.map(g => g.hook),
  ].filter(h => /^classic\./.test(h)))]
  if (classic.length) fail.push(`classic hooks, which the security default skips: ${classic.join(", ")}`)
  if (fail.length) { console.error("check-hooks: " + fail.join("; ")); process.exit(1) }
  console.log("hooks: telemetry.log{to=collector}, tool.call, tool.run, command.run, prompt.submit, agent.spawn and session.append{door=response} with .catch; turn.start, turn.step, turn.complete, tool.check, tool.judge, session.measure, skill.prompt, session.end; no classic hook")
})'
