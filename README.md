# Mainwave agent plugin

The Mainwave plugin for Claude Code and Cowork. It reports Claude sessions to [Mainwave](https://mainwave.com) so an organization can see what its Claude work costs and what it is for.

It is a Claude Code mod: TypeScript that runs inside Claude Code and Cowork. Nothing needs installing on the machine: no Node, Python or CLI.

## What it does today

The plugin does two things.

**It stamps Claude Code's rows.** Where an organization already sends Claude Code's OpenTelemetry to Mainwave (the managed `env` block from Mainwave's org-wide setup), the plugin adds four attributes to every log row Claude Code exports that names an organization:

| Attribute | Value |
| --- | --- |
| `mainwave.mod.name` | `mainwave` |
| `mainwave.mod.version` | the plugin's version, such as `0.1.0` |
| `mainwave.mod.entrypoint` | where the session runs, from `CLAUDE_CODE_ENTRYPOINT` (`cli`, `claude-vscode`, `remote_cowork` and so on); `other` for anything else |
| `mainwave.telemetry.route` | which path the row took: `exporter` on the row Claude Code's exporter sends, `plugin` on the plugin's own copy |

Mainwave can then tell which sessions run the plugin, which version, and where.

It also reads who the session is from those rows: the organization (`organization.id`), the account (`user.account_uuid`), the email (`user.email`) and the device (`user.id`, an ID Claude Code keeps per installation). It keeps them in memory for the session and sends them nowhere new. Later versions use them to ask Mainwave for the session's settings.

**It sends its own copy, to Mainwave's dev collector.** This is the first step toward the plugin delivering a session's telemetry by itself. Where a person has set a dev ingest key (see Settings), the plugin sends a copy of every Claude Code log row it sees to `https://collector.dev.mainwave.com/v1/logs`, and nowhere else. Claude Code's exporter goes on sending the original row wherever the organization pointed it, so nothing is counted twice, and the two can be compared row for row.

- **What a copy holds:** the exporter's row as Claude Code raised it: the same attributes (identity, `event.name`, `event.sequence`, `event.timestamp`), the same time and the same trace and span IDs, with `mainwave.telemetry.route` set to `plugin`. The resource is rebuilt as the exporter builds it (`service.name`, `service.version`, then `OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME`), as OTLP/JSON under the exporter's scope.
- **What it lacks:** the resource's `os.type`, `os.version` and `host.arch`, which only the exporter's host detectors know; the few rows Claude Code raises while it starts, before any plugin is loaded (`managed_settings_resolved`, `plugin_loaded`); and Claude Code's metrics and spans, which never pass through a plugin.
- **How it goes:** the row's hook only queues the copy. A timer sends the queue in batches of up to 200 rows every 5 seconds, and the end of a session sends one more batch. After a network failure, a timeout or a busy collector, the batch goes back in the queue and the wait before the next try doubles, up to a minute. A batch the collector refuses as malformed is dropped. A refused key stops sending until the plugin loads again.
- **What survives:** the queue is kept in the plugin's store (about 1 MB of rows at most, a few hundred to a few thousand, oldest dropped first), saved at most every 10 seconds and at session end, so rows a session could not send are sent by a later one. A process that dies loses at most the last 10 seconds or so of copies. The end of a session is short (Claude Code gives all of a session's end hooks 1.5 seconds together), so the last batch may be sent by the next session instead.

Rules it keeps:

- **It never holds anything up.** The exporter's row always goes on, whether or not the copy could be queued. If stamping fails, the row goes on as Claude Code wrote it, minus any key the plugin owns.
- **Nothing else can pose as it.** Any key under `mainwave.mod.` or `mainwave.telemetry.` already on a row is removed before the plugin adds its own, and each value it adds must fit a fixed shape.
- **Its key goes to one place.** The plugin sends the dev ingest key only to the dev collector, as a bearer token, and never writes it to a row, a file or a log. The plugin never reads the organization's collector URL or key. This holds against settings, not against other plugins: any plugin the person installs can see and rewrite every plugin's requests, this one's included, so a dev key is only as safe as the person's other plugins.
- **It adds nothing else.** No prompts, tool arguments, results or file contents beyond what Claude Code's own rows carry; no commands, panes or tools.

With no collector configured and no dev key, the plugin has no rows to stamp and sends nothing.

## What is coming

In rough order, each in a later version:

1. **Its own telemetry, without the env block.** Once Mainwave's collector accepts rows without a key, the plugin sends a session's rows itself, its own spans and metrics included, so an organization needs nothing but the plugin.
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

The plugin has one option, `devIngestKey`: an ingest key for Mainwave's dev collector. Unset (the default), the plugin sends nothing of its own. There is no switch to turn stamping off; to stop the plugin, remove it.

Set the key from a shell, so it is kept in secure storage. It is read from standard input, so it stays out of the command line and shell history:

```sh
claude plugin configure mainwave@synced --values-stdin < key.json   # key.json: {"devIngestKey": "<your dev ingest key>"}
```

Your own settings (`~/.claude/settings.json`, or `--settings`) also work, with the key in plain text:

```json
{
  "pluginConfigs": {
    "mainwave@synced": { "options": { "devIngestKey": "<your dev ingest key>" } }
  }
}
```

The name to use is the plugin's ID: `mainwave@synced` for org sync, `mainwave@mainwave` for an install from this repository, or `mainwave` (or `mainwave@inline`) for a `--plugin-dir` load.

Only the person's own settings count. If a repository's settings (`.claude/settings.json` or `.claude/settings.local.json`) name `devIngestKey` under any of the plugin's IDs, to any value, or cannot be read, the plugin sends nothing and drops what it had queued.

## Developing

The plugin sits at the repository's root: `.claude-plugin/plugin.json` (the manifest), `.claude-plugin/marketplace.json` (this repository as a marketplace), `hooks/` (the hooks module, `register.ts`, and the modules it imports), `types/index.d.ts` (what it keeps in `$.state`) and `tests/`.

```sh
claude plugin validate .        # reads the manifest, the marketplace and the hooks module the way Claude Code will
claude plugin test .            # runs tests/*.test.ts against the engine
scripts/check-version.sh        # plugin.json and hooks/version.ts agree
scripts/check-hooks.sh          # the row hook is registered with its fail-open .catch, and session.end is hooked
node tests/e2e/compare.mjs      # one real session, model mocked: the plugin's copy against the exporter's rows, field by field
claude --plugin-dir .           # a session with the plugin loaded from this folder
```

CI runs all but the last on every pull request.

The end-to-end comparison runs `claude -p` in a fresh config folder with an API key and a local mock of the Anthropic API, so no login and no organization's settings reach it, and nothing leaves the machine. Claude Code's exporter sends to a local receiver, and a test-only plugin (`tests/e2e/redirect`) sends the plugin's copy there too. The script pairs every record by session, event name and sequence, and fails on any difference but the known ones listed under What it does today. `--keep` keeps what was received. The type check runs locally: start one interactive session with `claude --plugin-dir .`, which writes Claude Code's declarations to `.claude-plugin/types/` (gitignored), then run `npx -p typescript@5.6.3 tsc -p .`.

A release bumps the version in both `.claude-plugin/plugin.json` and `hooks/version.ts`.

| Module | What it holds |
| --- | --- |
| `hooks/register.ts` | the hooks: the collector row hook and its fail-open handler, `session.start` and `session.end` |
| `hooks/stamps.ts` | the keys the plugin owns, their shape rules, and the strip of forged keys |
| `hooks/settings.ts` | where the dev ingest key may come from, and its shape |
| `hooks/identity.ts` | the organization, account, email and device read from a row |
| `hooks/sender.ts` | the copy: queue, timer, batches, retries and the outbox kept in the store |
| `hooks/otlp.ts` | the copy as OTLP/JSON, with the resource rebuilt as the exporter builds it |
| `hooks/http.ts` | `fetchWithin`: a request with a time limit that ends with its session |

## Credits

Ported from Mainwave's internal pilot plugin, written by Ryan Merlin: the mod skeleton and the row-stamping hook, fail-open stamping and the strip of forged keys, the settings order, reading the account and email from rows, the fetch wrapper with its time limit, and the CI gate on `claude plugin validate` and `claude plugin test`. The files were ported fresh; the pilot's history stays in its own repository.

## License

Not chosen yet. Until a license is added, no rights are granted to use, copy or redistribute this code.
