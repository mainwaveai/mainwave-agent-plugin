# Mainwave agent plugin

A Claude Code mod at the repository root: `.claude-plugin/plugin.json` (manifest), `.claude-plugin/marketplace.json` (this repo as a marketplace), `hooks/` (the hooks module `register.ts` and what it imports), `types/index.d.ts` (the `$.state` contract) and `tests/`. `README.md` says what it does and how it is installed; keep it true when behavior changes.

## Commands

```sh
claude plugin validate .        # manifest, marketplace and hooks module, read the way Claude Code will
claude plugin test .            # tests/*.test.ts against the engine
scripts/check-version.sh        # plugin.json and hooks/version.ts agree; the Claude Code floor is the same in CI's pin, plugin.json and the README
scripts/check-layout.sh         # one plugin, at the root: org sync refuses a .claude-plugin/ or plugin.json anywhere else
scripts/check-hooks.sh          # the row, tool call, command and spawn hooks keep their fail-open .catch; the turn hooks and session.end are hooked
scripts/check-vendored.sh       # the copies of Mainwave's catalog and command cases (JSON) and the twins the tests import agree; --write rewrites the twins
node tests/e2e/compare.mjs      # real sessions, model mocked: the plugin's copy against the exporter's; without the env block, keyless and coherent
```

CI runs all seven on every pull request, on the latest Claude Code and on the floor (README, Developing). The type check is local only.

## Rules

- **This repository goes public.** No internal references in any file, commit message or PR: no ticket IDs, internal docs or specs, review records, Claude organization IDs, internal email addresses or local paths. Tests use example IDs and `example.com` addresses.
- **No AI attribution** on commits or PRs (`.claude/settings.json` turns the footers off; don't add them by hand).
- Commits: `<type>(<scope>): <imperative, lowercase>`. Types: feat fix chore refactor docs test perf ci.
- Never commit to `main`: branch, open a PR, and have a fresh sub-agent that didn't write the change review it before marking it ready. Don't merge without the owner's approval.
- Hooks fail open: a fault never holds a row, a tool call or the session.
- A new stamp key needs a shape rule in `hooks/stamps.ts`, an owned prefix if it starts a new one, and an entry in the test contract in `tests/rig.ts`, which is written independently of `hooks/`.
- Mainwave's catalog of data points is the source of `hooks/catalog.ts`: `hooks/data-points.json` is a copy of it, which `tests/catalog.test.ts` compares field by field (all but the defaults). Its command rules are the source of `commandOutcomes` in `hooks/derive.ts`: `tests/fixtures/command-outcomes.json` is a copy of their cases, which `tests/outcomes.test.ts` runs. Neither copy is edited here: replace it with Mainwave's, then run `scripts/check-vendored.sh --write`.
- A release bumps the version in `.claude-plugin/plugin.json` and `hooks/version.ts` together.
- Raising the Claude Code floor is a pull request of its own: `.github/claude-code-floor/package.json`, `engines` in `.claude-plugin/plugin.json`, the README's Install section and the note at its top change together. Dependabot's version updates don't watch it.
- The repository holds one plugin, at its root. A test that needs another plugin builds it in a temporary folder (as `tests/e2e/compare.mjs` does); org sync refuses a repository with a second manifest.
