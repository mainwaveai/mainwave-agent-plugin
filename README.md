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

**It sends its own copy, to Mainwave's dev collector.** This is the first step toward the plugin delivering a session's telemetry by itself. The plugin sends a copy of a session's log rows, spans and metrics to `https://collector.dev.mainwave.com` (`/v1/logs`, `/v1/traces` and `/v1/metrics`), and nowhere else: without a key by default, routed by the Claude organization and email on each record (see Keyless, below), or with a dev ingest key where the person set one (see Settings). Where the organization's `env` block is in place, Claude Code's exporter goes on sending the originals wherever the organization pointed it, so nothing is counted twice, and the two can be compared record for record. Without it, the plugin's copy is all that is sent.

- **Log rows** are copies: the exporter's row as Claude Code raised it, with the same attributes (identity, `event.name`, `event.sequence`, `event.timestamp`), the same time and the same trace and span IDs. Where Claude Code's row names no span but the plugin builds the trace (below), the copy carries the IDs of the span it ran in, as Claude Code's rows do when it traces.
- **Spans and metrics are rebuilt.** They never pass through a plugin: the one hook Claude Code gives plugins for its telemetry carries log rows alone. So the plugin puts them back together from what it does see: the rows, and Claude Code's own events for turns, model requests, tool calls and subagents. What it sends has the exporter's names, attributes, attribute order and value types, and the exporter's trace IDs; the table below says where each comes from.
- **Every record** carries `mainwave.telemetry.route` set to `plugin`. The resource is rebuilt as the exporter builds it (`service.name`, `service.version`, then `OTEL_RESOURCE_ATTRIBUTES`, then `OTEL_SERVICE_NAME`), and each signal goes as OTLP/JSON under the exporter's own scope for it.

| What Claude Code sends | What the plugin rebuilds it from |
| --- | --- |
| `claude_code.interaction`, one per turn of the main conversation, and one per slash command that asks no model (`/plugins`, `/cost`, `/exit`) | Its trace and span IDs are the `user_prompt` row's. A turn's end is the turn's end, and its start that less the turn's duration; a command's runs from the command's start to its end |
| `claude_code.llm_request`, one per model request | The request's `api_request` (or `api_error`) row: model, tokens, request ID, time to first token, effort, query source. The request's own stream gives its start and stop reason. Its parent is the row's span |
| `claude_code.tool`, one per tool call | The tool call itself: its name, its input (the command, file, skill or agent type, where `OTEL_LOG_TOOL_DETAILS` asks for them) and its time. Its parent is its `tool_result` row's span |
| `claude_code.tool.blocked_on_user`, the call's permission decision | The `tool_decision` row: its trace and span IDs, the decision and its source |
| `claude_code.tool.execution`, the call's run | The call's time and its `tool_result` row's outcome, error and error class. An Agent call's takes its span ID from its subagent's rows |
| `claude_code.cost.usage`, `claude_code.token.usage` | Each `api_request` row's cost and tokens |
| `claude_code.lines_of_code.count` | Each Edit and Write call's result: its patch, or the whole file written |
| `claude_code.commit.count`, `claude_code.pull_request.count` | Each Bash command that succeeded, read by Claude Code's own rules (`git commit`, `gh pr create`, `glab mr create` and so on), and each MCP tool named for creating a pull request |
| `claude_code.code_edit_tool.decision` | Each `tool_decision` row of an Edit, Write or NotebookEdit call |
| `claude_code.active_time.total` (`type` `cli`) | Each interaction's duration, a turn's or a command's |
| `claude_code.session.count` | The session's start |

**With and without the env block.** Claude Code ties its rows to its spans only when it traces, which Mainwave's `env` block turns on (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, with a traces exporter). Without it, Claude Code still hands the plugin every row and every event, but no row names a span, and there are no exporter spans to mirror. So the plugin decides once per load, from that variable (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, else `ENABLE_ENHANCED_TELEMETRY_BETA`, as Claude Code reads it):

- **On: it mirrors the exporter**, ids and all, as the table above says, for every turn whose prompt row names its span.
- **On, but a turn's prompt row names no span: it rebuilds that turn.** This is the first turn of a session a host drives through its SDK (such as T3 Code) where the env block arrives with the organization's managed settings: the turn begins before Claude Code traces, so it sends no interaction, and each of the turn's requests and tool calls as a trace of its own. The plugin sends the turn as one trace instead, the same shape as below: its own interaction as the root, the requests and calls under it. The span IDs the rows do name (each permission decision's, a subagent's) are kept, and the trace Claude Code started for each call is moved onto the interaction's, with everything in it (the call's decision and run, its subagent, a skill it loaded). The turns after it are traced, and mirrored.
- **Off, and no row has named a span: it builds the trace itself.** Each interaction is the root of a trace of its own, started as the turn (or the slash command) starts. The turn's model requests and tool calls are its children, each call's `blocked_on_user` and `execution` spans the call's, and a subagent's requests and calls are children of its Agent call's `execution` span, nested subagents included. Every id is the plugin's own. A request outside the main loop and its subagents (a session title, a summary) is a root, as the exporter sends it. If a row ever names a span after all, the plugin goes back to mirroring from then on.

Every span and data point starts with the attributes Claude Code puts first on all its records (the session's identity, the organization's resource attributes, the repository): the plugin takes them from the latest row, everything before its `event.name`. Metrics are monotonic sums with delta temporality, as Claude Code sends them: summed between collections, collected every `OTEL_METRIC_EXPORT_INTERVAL` milliseconds (a minute unless set) and once more as the session ends.

**What the copy lacks**, and why:

| Missing or different | Why |
| --- | --- |
| The resource's `os.type`, `os.version` and `host.arch` | Only the exporter's host detectors know them |
| The row Claude Code raises as it starts (`managed_settings_resolved`), and before Claude Code 2.1.326 its `plugin_loaded` rows | They come before any plugin is loaded. Since 2.1.326 Claude Code hands the plugins its `plugin_loaded` rows once they are loaded, and the copy has them, naming no span, as the exporter's do |
| The span IDs of `llm_request`, `tool` and `tool.execution` (but an Agent call's `tool.execution`) | No row carries them, so the plugin makes its own. Trace IDs, the other span IDs and every parent are the exporter's; a `blocked_on_user` or `tool.execution` span's parent is the plugin's `tool` span |
| Span times and the `duration_ms` attributes | The plugin times a span from the events around it: a few milliseconds from the exporter's |
| In a turn Claude Code did not trace (the first turn under an SDK host, above): its shape, and its trace IDs | By design: the exporter sends no interaction and a trace per request and per call; the plugin sends one trace under its own interaction. The span IDs the rows name are the exporter's; their trace IDs, and the copied rows', are the plugin's |
| A slash command's interaction times | The plugin times the command from its hook; under `claude -p`, Claude Code starts the interaction when the process starts |
| `first_content_ms` on `llm_request` | The plugin has the request's time to first token (`ttft_ms`) and sends that |
| `stop_reason` on requests outside a conversation (a session title, a summary) | The plugin sees the stream of the main conversation's requests and its subagents', not those |
| The model requests of Claude Code's classifiers: auto mode's permission classifier (`query_source_safe` `auto_mode`), and the one that sorts background sessions by state (`agent_classifier`) | Claude Code logs no `api_request` or `api_error` row for them, and no event a plugin may hook shows them: they are not steps of a turn, and the analytics rows that name them are for the plugins built into Claude Code. The exporter sends each as an `llm_request` span with its tokens. Since Claude Code 2.1.326 it also counts auto mode's classifier requests in `cost.usage` and `token.usage` (`query_source` `auxiliary`) where the session is billed for them (a session through a gateway, for one), and the copy lacks that share of those series. No plugin can rebuild it: `tool.judge` shows that the classifier is asked, not what its requests used; `$.session.usage()` has the session's total cost alone, and `$.agent.list()` a subagent's tokens all together. The other classifier is still counted in neither. In a week of sessions Mainwave received in November 2026, they were about 3% of `llm_request` spans, and under 0.2% of the tokens and the cost |
| `attempt` on a request that succeeded after retries, and the attempts' span events | Its row does not say which attempt it was; the plugin sends 1 |
| `bash_command_class` and `bash_argv0` for a command with subshells, here-documents and the like | Claude Code reads commands with a full shell parser; the plugin applies the same table to the first command it can split off |
| `language` on `code_edit_tool.decision` for less common file types | Claude Code knows a syntax highlighter's whole list; the plugin knows the common extensions and reads the rest as `unknown` |
| `active_time.total` of `type` `user` | It counts the person's typing, which a plugin does not see |
| `start_type` other than `fresh` on `session.count` | A plugin cannot tell a resumed or continued session from a new one |
| The start of `session.count`'s point | Claude Code counts the session as its telemetry starts, before any plugin loads; the plugin counts it when it starts, a few hundred milliseconds later |
| On a tool run the person interrupted: `error.type`, `error` and `error_class` | Claude Code logs no `tool_result` row for an interrupted run, so the plugin has no error or class for it and sends the run as an ordinary failure (`error.type` `tool_error`) |
| Line counts for NotebookEdit calls | Their results carry no patch |
| Metric points' start and end times | The plugin collects on its own clock, from when it loads; each series' sum is the exporter's |
| Spans in flight when the plugin reloads; the interaction count across a reload | They live in the plugin's memory |
| Spans Claude Code sends only in other modes: hook spans (detailed beta tracing), and the content Claude Code adds when `OTEL_LOG_TOOL_CONTENT` or `OTEL_LOG_RAW_API_BODIES` is set | Not rebuilt |
| `parent.source` `event` and `queued_sends` above 0 on `interaction`, and the span's links | Claude Code sets them only for a prompt that carries a trace from another session (in its own hosted environments); the plugin sends `env` or `none`, and 0 |
| `mainwave.telemetry.route` on spans and metrics | Added by design; the exporter's spans and metrics carry no route, as the plugin cannot stamp them |
| Without the env block: every trace and span id, on spans and on log rows | Claude Code makes none; the plugin makes its own, and puts on each copied row the IDs of the span it ran in |
| Without the env block: a parent from `TRACEPARENT` | Each interaction is the root of its trace, whatever trace the host started |

- **Keyless:** with no key, the plugin sends no `Authorization` header (one would send the request down the key path, where it is refused). The dev collector routes each request by the `organization.id` and `user.email` on every record, span and data point in it (never the resource's), one pair per request. So the plugin queues only records that carry both, each of the right shape: a session on an API key or a cloud provider names no organization or email, and its records are held back: never queued or sent, and dropped from an outbox an earlier session left when this one takes it over. Each batch holds one pair's records alone, so a batch the collector refuses holds back or drops no one else's. A refusal of the pair (403, reason `unclaimed`: no Mainwave workspace has claimed the Claude organization; `email_domain`: the email's domain is not one the workspace accepts) stops sending that pair's records until the plugin loads again: those already queued are kept for a later load, and no more are queued this load; other pairs, from outboxes earlier sessions left, go on. Any other refusal stops sending for the load, as a refused key does. Keyless sending is for the dev collector alone.
- **How it goes:** the hooks only queue. A timer sends the queue in batches of up to 200 records of one signal every 5 seconds, and the end of a session sends one more batch of each signal at once. After a network failure, a timeout or a busy collector, the batch goes back in the queue and the wait before that signal's next try doubles, up to a minute; the other signals go on. A path the collector does not have (404) is not tried again until the plugin loads again, and its records are kept. A batch the collector refuses as malformed, or that cannot be written as a request, is dropped. A refused key stops sending until the plugin loads again. A span waits up to 2 seconds for the event it pairs with, then goes with what it has.
- **Sent once:** each batch carries an `idempotency-key` header, made when the batch is first formed and kept through every retry. A retry carries the same records under the same key. Past the queue's caps, only the oldest records the caps need are dropped; if one was in a batch, the rest of that batch goes again under a new key, which may store it twice but never loses it. The collector stores a batch whose key it has already taken only once, so a batch that may have landed (a timeout, a request cut off as the session ended) is sent again, metrics included. A batch formed keyless has a hash of its organization and email in its key, so it goes under the same header either way. A batch formed with a key and sent keyless by a later load goes as one batch per person, each with that person's hash after the key, so it may be stored twice, but is never lost.
- **What survives:** the queue, all three signals together, is kept in the plugin's store (about 1 MB at most, a few hundred to a few thousand records, oldest dropped first), saved at most every 10 seconds and at session end, so records a session could not send are sent by a later one, in the same batches under the same keys. Past the caps, a batch is never sent in part under its key: what is left of it goes under a new key, which may store it twice, never lose it. A process that dies loses at most the last 10 seconds or so of copies, and the metrics since their last collection. The end of a session is short (Claude Code gives all of a session's end hooks 1.5 seconds together), so the last batches may be sent by the next session instead.

Rules it keeps:

- **It never holds anything up.** The exporter's row always goes on, whether or not the copy could be queued. If stamping fails, the row goes on as Claude Code wrote it, minus any key the plugin owns. The hooks on turns, model requests, tool calls, slash commands and subagents only watch: each passes its event and its result on unchanged, and a fault in one is caught.
- **Nothing else can pose as it.** Any key under `mainwave.mod.` or `mainwave.telemetry.` already on a row is removed before the plugin adds its own, and each value it adds must fit a fixed shape.
- **Its key goes to one place.** The plugin sends the dev ingest key only to the dev collector, as a bearer token, and never writes it to a row, a file or a log. Keyless, it sends no key at all. The plugin never reads the organization's collector URL or key. This holds against settings, not against other plugins: any plugin the person installs can see and rewrite every plugin's requests, this one's included, so a dev key is only as safe as the person's other plugins.
- **It adds nothing else.** No prompts, tool arguments, results or file contents beyond what Claude Code's own rows and spans carry, under the same settings (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`); no commands, panes or tools.

With no collector configured, the plugin has no rows to stamp, but it still sends its keyless copy. A session whose rows name no organization and email (an API key, a cloud provider) sends nothing.

## What is coming

In rough order, each in a later version:

1. **Its own telemetry, to production.** The plugin already sends a session's rows, spans and metrics without the env block or a key, to the dev collector. Next it sends them to Mainwave's production collector, so an organization needs nothing but the plugin.
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

The plugin has one option, `devIngestKey`: an ingest key for Mainwave's dev collector. Unset (the default), the plugin sends its copy without a key, routed by the Claude organization and email on each record (see Keyless, above); the collector takes it only where it routes that organization and email domain to a Mainwave workspace, and refuses the rest. Set, the copy goes with the key as a bearer token instead. A key of the wrong shape sends nothing (the session's debug log says so, never with the value). There is no switch to turn stamping or the copy off; to stop the plugin, remove it. An earlier version's `devKeyless` option is gone: a value left in settings is ignored, whatever it is.

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
scripts/check-layout.sh         # one plugin, at the root: org sync refuses a .claude-plugin/ or plugin.json anywhere else
scripts/check-hooks.sh          # the row, tool call, command and spawn hooks keep their fail-open .catch; the turn hooks and session.end are hooked
node tests/e2e/compare.mjs      # real sessions, model mocked: the plugin's copy against the exporter's; without the env block, keyless and coherent
claude --plugin-dir .           # a session with the plugin loaded from this folder
```

CI runs all but the last on every pull request, against the Claude Code version in `.github/claude-code/package.json`. Dependabot opens a pull request for each new release, so a release that breaks the comparison fails that pull request alone.

The end-to-end comparison runs `claude -p` in a fresh config folder and a scratch git repository, with an API key and a local mock of the Anthropic API, so no login and no organization's settings reach it, and nothing leaves the machine. The mock model scripts a turn that runs Bash, writes and edits a file, commits, has a command fail, is refused a command and starts a background subagent; it answers each request after a different delay, and refuses one request once as overloaded, so Claude Code retries it. The session runs three times: with the env block, once with prompts and tool details logged and once with neither, and then without it. With it, Claude Code's exporter sends all three signals to a local receiver, and a test-only plugin, built in a temporary folder from `tests/e2e/redirect.ts`, sends the plugin's copy there too. The script pairs every log row by session, event name and sequence; every span by what identifies it (its ID where the rows name it, else its request ID or tool call ID); and every metric series by its name and attributes, summing its points. It compares each pair field by field, attribute keys in order and value types included, and fails on any difference but the known ones in the table above, which it lists with their counts. The first runs in auto mode: the mock answers auto mode's classifier, blocking the refused command and allowing the rest, and it counts the exporter's spans of the classifier's requests, and its share of `cost.usage` and `token.usage` where it counts one (each token type's exactly the tokens on those spans), as the known gap above, and fails unless the classifier was asked about that command and refused it. Without the env block, the exporter sends nothing and the plugin sends keyless; the receiver applies keyless ingest's rules (no `Authorization` header; an `idempotency-key` header of the collector's shape, which the plugin sends on every request; one `organization.id` and one `user.email` on every item, the same pair across a request) and the script fails on any request it refuses, on any span out of its place in the interaction's trace, and on any row that names a kind of span other than the exporter's rows of the same event named with the env block. As the session runs on an API key, its rows carry an organization and an email there only through `OTEL_RESOURCE_ATTRIBUTES`, standing in for what a login puts on them. `--keep` keeps what was received. The type check runs locally: start one interactive session with `claude --plugin-dir .`, which writes Claude Code's declarations to `.claude-plugin/types/` (gitignored), then run `npx -p typescript@5.6.3 tsc -p .`.

A release bumps the version in both `.claude-plugin/plugin.json` and `hooks/version.ts`.

| Module | What it holds |
| --- | --- |
| `hooks/register.ts` | the hooks: the collector row hook and its fail-open handler, the turn, model request, tool call, command and spawn hooks, `session.start` and `session.end` |
| `hooks/stamps.ts` | the keys the plugin owns, their shape rules, and the strip of forged keys |
| `hooks/settings.ts` | where the dev ingest key may come from, and its shape |
| `hooks/identity.ts` | the organization, account, email and device read from a row, and the pair a record is routed by without a key |
| `hooks/rebuild.ts` | Claude Code's spans, and the measures behind its metrics, rebuilt from rows and events; without the env block, the trace built by the plugin |
| `hooks/derive.ts` | the rules Claude Code fills attributes by: tool names, query sources, Bash commands, line counts, languages |
| `hooks/meter.ts` | the counters behind the metrics, collected as delta points |
| `hooks/sender.ts` | the copy: one queue for all three signals, timer, batches (keyless, one organization and email each) and their idempotency keys, retries and the outbox kept in the store |
| `hooks/otlp.ts` | the copy as OTLP/JSON (log records, spans, metric points), with the resource rebuilt as the exporter builds it |
| `hooks/http.ts` | `fetchWithin`: a request with a time limit that ends with its session |

## Credits

Ported from Mainwave's internal pilot plugin, written by Ryan Merlin: the mod skeleton and the row-stamping hook, fail-open stamping and the strip of forged keys, the settings order, reading the account and email from rows, the fetch wrapper with its time limit, and the CI gate on `claude plugin validate` and `claude plugin test`. The files were ported fresh; the pilot's history stays in its own repository.

## License

Not chosen yet. Until a license is added, no rights are granted to use, copy or redistribute this code.
