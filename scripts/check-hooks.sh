#!/bin/sh
# What the engine will load, as `claude plugin validate --json` reports it: the collector row hook with its fail-open `.catch`, and
# session.end. A hook dropped, or a `.catch` removed, fails here: the tests call the hook bodies, not the registrations.
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
  if (!notes.some(n => /hooks: .*\bsession\.end\b/.test(n))) fail.push("no session.end hook")
  const row = gating.find(g => g.hook === "telemetry.log{to=collector}")
  if (row === undefined || row.hasCatch !== true) fail.push("the telemetry.log hook has no .catch")
  if (fail.length) { console.error("check-hooks: " + fail.join("; ")); process.exit(1) }
  console.log("hooks: telemetry.log{to=collector} with .catch, session.end")
})'
