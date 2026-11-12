# Mainwave agent plugin

The Mainwave plugin for Claude Code and Cowork. It reports Claude sessions to [Mainwave](https://mainwave.com) so an organization can see what its Claude work costs and what it is for.

It is a Claude Code mod: TypeScript that runs inside Claude Code and Cowork. Nothing needs installing on the machine: no Node, Python or CLI.

## What it does today

Version 0.1.0 is report-only. Where an organization already sends Claude Code's OpenTelemetry to Mainwave (the managed `env` block from Mainwave's org-wide setup), the plugin adds four attributes to every row Claude Code exports:

| Attribute | Value |
| --- | --- |
| `mainwave.mod.name` | `mainwave` |
| `mainwave.mod.version` | the plugin's version, such as `0.1.0` |
| `mainwave.mod.entrypoint` | where the session runs, from `CLAUDE_CODE_ENTRYPOINT` (`cli`, `claude-vscode`, `remote_cowork` and so on); `other` for anything else |
| `mainwave.telemetry.source` | what turned reporting on: `policy` (the organization), `user` (the person) or `default` |

Mainwave can then tell which sessions run the plugin, which version, and where.

It also reads who the session is from those rows: the organization (`organization.id`), the account (`user.account_uuid`), the email (`user.email`) and the device (`user.id`, an ID Claude Code keeps per installation). It keeps them in memory for the session and sends them nowhere new. Later versions use them to ask Mainwave for the session's settings.

Rules it keeps:

- **It never holds anything up.** If stamping fails, the row goes on as Claude Code wrote it, minus any key the plugin owns.
- **Nothing else can pose as it.** Any key under `mainwave.mod.` or `mainwave.telemetry.` already on a row is removed before the plugin adds its own, and each value it adds must fit a fixed shape.
- **It adds nothing else.** No prompts, tool arguments, results or file contents; no network calls of its own; no commands, panes or tools.

With no collector configured, the plugin has no rows to stamp and does nothing.

## What is coming

In rough order, each in a later version:

1. **Its own telemetry.** The plugin sends session rows itself, so an organization no longer needs the managed `env` block.
2. **Settings from Mainwave.** At session start the plugin asks Mainwave for the organization's settings and the session's state, by the organization, account, email and device it read.
3. **Attributes.** The organization's attribute list in the session: Claude or the person sets a value (such as the project) with `/mainwave:attribute`, or proposes a new one for an admin to accept.
4. **Anthropic's plugin directory.** A public listing, so updates reach every organization that sets the plugin to Required, and personal Pro and Max accounts can install it.

## Install

Needs Claude Code 2.1.287 or later.

### For a whole organization (org sync)

An owner or admin of the Claude organization, on claude.ai:

1. **Organization settings › Plugins & skills › Sync from GitHub**, then add `mainwaveai/mainwave-agent-plugin` with **Sync automatically** on. While the repository is private, Anthropic's GitHub app must be able to read it.
2. **Inventory › mainwave › Default access › Required**, so every member's Claude Code and Cowork sessions run it with no install step.
3. If an older Mainwave plugin is in the inventory, set it to **Not available**, so only one copy stamps rows.

Each re-sync picks up the repository's `main` branch. For the stamps to reach Mainwave, the organization also needs Mainwave's managed `env` block (from Mainwave's org-wide setup); without it the plugin loads and stamps nothing.

To check it works: run a session, then look for rows with `mainwave.mod.name = mainwave` in Mainwave.

### For yourself

At the prompt of a Claude Code session in a terminal:

```text
/plugin install mainwave --marketplace mainwaveai/mainwave-agent-plugin
```

Answer `y` to add the marketplace, then pick a scope. From a shell: `claude plugin install mainwave --marketplace mainwaveai/mainwave-agent-plugin`. While the repository is private, your machine needs a git credential for github.com that can read it.

## Settings

Reporting has one switch, `reporting`. The first of these that says anything decides:

1. **The organization**, in managed settings. An off under any of the plugin's IDs wins.
2. **The person**, in their own settings (`--settings`, then their user settings; the `/config` menu writes it there). A repository's `.claude/settings.json` is never read for it.
3. **The default**: on, once a row names an organization.

A layer that cannot be read, or holds a value that is not `true` or `false`, turns reporting off.

To turn it off for a whole organization, in managed settings:

```json
{
  "pluginConfigs": {
    "mainwave@synced": { "options": { "reporting": false } }
  }
}
```

The key is the plugin's ID: `mainwave@synced` for org sync, `mainwave@mainwave` for an install from this repository, or `mainwave` (or `mainwave@inline`) for a `--plugin-dir` load.

## Developing

The plugin sits at the repository's root: `.claude-plugin/plugin.json` (the manifest), `.claude-plugin/marketplace.json` (this repository as a marketplace), `hooks/` (the hooks module, `register.ts`, and the modules it imports), `types/index.d.ts` (what it keeps in `$.state`) and `tests/`.

```sh
claude plugin validate .        # reads the manifest, the marketplace and the hooks module the way Claude Code will
claude plugin test .            # runs tests/*.test.ts against the engine
scripts/check-version.sh        # plugin.json and hooks/version.ts agree
scripts/check-hooks.sh          # the row hook is registered with its fail-open .catch, and session.end is hooked
claude --plugin-dir .           # a session with the plugin loaded from this folder
```

CI runs all but the last on every pull request. The type check runs locally: start one interactive session with `claude --plugin-dir .`, which writes Claude Code's declarations to `.claude-plugin/types/` (gitignored), then run `npx -p typescript@5.6.3 tsc -p .`.

A release bumps the version in both `.claude-plugin/plugin.json` and `hooks/version.ts`.

| Module | What it holds |
| --- | --- |
| `hooks/register.ts` | the hooks: the collector row hook and its fail-open handler, and `session.end` |
| `hooks/stamps.ts` | the keys the plugin owns, their shape rules, and the strip of forged keys |
| `hooks/settings.ts` | the reporting switch: organization, then person, then default |
| `hooks/identity.ts` | the organization, account, email and device read from a row |
| `hooks/http.ts` | `fetchWithin`: a request with a time limit that ends with its session (unused until the plugin makes requests) |

## Credits

Ported from Mainwave's internal pilot plugin, written by Ryan Merlin: the mod skeleton and the row-stamping hook, fail-open stamping and the strip of forged keys, the settings order, reading the account and email from rows, the fetch wrapper with its time limit, and the CI gate on `claude plugin validate` and `claude plugin test`. The files were ported fresh; the pilot's history stays in its own repository.

## License

Not chosen yet. Until a license is added, no rights are granted to use, copy or redistribute this code.
