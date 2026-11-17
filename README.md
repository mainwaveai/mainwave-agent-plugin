# Mainwave agent plugin

The Mainwave plugin for Claude Code and Cowork. It reports Claude sessions to [Mainwave](https://mainwave.com) so an organization can see what its Claude work costs and what it is for.

It is a Claude Code mod: TypeScript that runs inside Claude Code and Cowork. Nothing needs installing on the machine: no Node, Python or CLI.

> [!IMPORTANT]
> Requires Claude Code 2.1.317 or later, in every place a session runs: a remote machine, a script, an IDE extension or the desktop app can run an older copy than the terminal does. `claude --version` shows the version; `claude update` updates a native install, and a Homebrew, WinGet or Linux package install updates through its package manager. Older versions send less or nothing; see [Install](#install).

## What it does today

The plugin does two things.

**It stamps Claude Code's rows.** Where an organization already sends Claude Code's OpenTelemetry to Mainwave (the managed `env` block from Mainwave's org-wide setup), the plugin adds four attributes to every log row Claude Code exports that names an organization:

| Attribute | Value |
| --- | --- |
| `mainwave.plugin.name` | `mainwave` |
| `mainwave.plugin.version` | the plugin's version, such as `0.1.0` |
| `mainwave.plugin.entrypoint` | where the session runs, from `CLAUDE_CODE_ENTRYPOINT` (`cli`, `claude-vscode`, `remote_cowork` and so on); `other` for anything else |
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
| `claude_code.tool`, one per tool call | The tool call itself: its name, its input (the command, file, skill or agent type, where the data they belong to is on: see What it sends), what it answered (the `tool.output` event) and its time. Its parent is its `tool_result` row's span |
| `claude_code.tool.blocked_on_user`, the call's permission decision | The `tool_decision` row: its trace and span IDs, the decision and its source |
| `claude_code.tool.execution`, the call's run | The call's time and its `tool_result` row's outcome, error and error class. An Agent call's takes its span ID from its subagent's rows |
| `claude_code.cost.usage`, `claude_code.token.usage` | Each `api_request` row's cost and tokens |
| `claude_code.lines_of_code.count` | Each Edit and Write call's result: its patch, or the whole file written |
| `claude_code.commit.count`, `claude_code.pull_request.count` | Each Bash command that succeeded, read by Claude Code's own rules (`git commit`, `gh pr create`, `glab mr create` and so on), and each MCP tool named for creating a pull request. A command run through an MCP shell tool (Cowork's `device_bash`) counts as a Bash command |
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
| The model requests of Claude Code's classifiers: auto mode's permission classifier (`query_source_safe` `auto_mode`), and the one that sorts background sessions by state (`agent_classifier`) | Claude Code logs no `api_request` or `api_error` row for them, and no event a plugin may hook shows them: they are not steps of a turn, and the analytics rows that name them are for the plugins built into Claude Code. The exporter sends each as an `llm_request` span with its tokens. Since Claude Code 2.1.326 it also counts auto mode's classifier requests in `cost.usage` and `token.usage` (`query_source` `auxiliary`) where the account is billed for them, and the copy lacks that share of those series. No plugin can rebuild it: no event names the model the classifier ran on, which need not be the session's; `tool.judge` shows that the classifier is asked, not what its requests used; `$.session.usage()` has the session's total cost alone; and `$.agent.list()` counts a subagent's classifier requests in with its other requests, model by model, and lists no main loop. The other classifier is still counted in neither. In a week of sessions Mainwave received in November 2026, they were about 3% of `llm_request` spans, and under 0.2% of the tokens and the cost |
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
| Spans Claude Code sends only in other modes: hook spans (detailed beta tracing), and the content Claude Code adds when `OTEL_LOG_RAW_API_BODIES` is set | Not rebuilt |
| `tool.output` events of tools other than Read, Edit, Write, Bash and MCP tools | Not rebuilt |
| More on some tool spans: `url.full` and `url.domain` on WebFetch calls; `full_command`, `bash_command_class` and `bash_argv0` on calls to an MCP shell tool (Cowork's `device_bash`); `response.thinking` on requests, where it is turned on | The plugin's own: Claude Code's spans carry none of them |
| Without the env block: `git_commit_id` and `git_branch` in a Bash call's `tool_parameters`, and the text of a failed call's `error` on its `tool_result` row | Claude Code reads the first from the command's output and logs the row before the call's result reaches a plugin. The run's span carries the error the call answered |
| `parent.source` `event` and `queued_sends` above 0 on `interaction`, and the span's links | Claude Code sets them only for a prompt that carries a trace from another session (in its own hosted environments); the plugin sends `env` or `none`, and 0 |
| `mainwave.telemetry.route` on spans and metrics | Added by design; the exporter's spans and metrics carry no route, as the plugin cannot stamp them |
| Without the env block: every trace and span id, on spans and on log rows | Claude Code makes none; the plugin makes its own, and puts on each copied row the IDs of the span it ran in |
| Without the env block: a parent from `TRACEPARENT` | Each interaction is the root of its trace, whatever trace the host started |

- **Keyless:** with no key, the plugin sends no `Authorization` header (one would send the request down the key path, where it is refused). The dev collector routes each request by the `organization.id` and `user.email` on every record, span and data point in it (never the resource's), one pair per request. So the plugin queues only records that carry both, each of the right shape: a session on an API key or a cloud provider names no organization or email, and its records are held back: never queued or sent, and dropped from an outbox an earlier session left when this one takes it over. Each batch holds one pair's records alone, so a batch the collector refuses holds back or drops no one else's. A refusal of the pair (403, reason `unclaimed`: no Mainwave workspace has claimed the Claude organization; `email_domain`: the email's domain is not one the workspace accepts) stops sending that pair's records until the plugin loads again: those already queued are kept for a later load, and no more are queued this load; other pairs, from outboxes earlier sessions left, go on. Any other refusal stops sending for the load, as a refused key does. Keyless sending is for the dev collector alone.
- **How it goes:** the hooks only queue. A timer sends the queue in batches of up to 200 records of one signal every 5 seconds, and the end of a session sends one more batch of each signal at once. After a network failure, a timeout or a busy collector, the batch goes back in the queue and the wait before that signal's next try doubles, up to a minute; the other signals go on. A path the collector does not have (404) is not tried again until the plugin loads again, and its records are kept. A batch the collector refuses as malformed, or that cannot be written as a request, is dropped. A refused key stops sending until the plugin loads again. A span waits up to 2 seconds for the event it pairs with, then goes with what it has.
- **Sent once:** each batch carries an `idempotency-key` header, made when the batch is first formed and kept through every retry. A retry carries the same records under the same key. Past the queue's caps, only the oldest records the caps need are dropped; if one was in a batch, the rest of that batch goes again under a new key, which may store it twice but never loses it. The collector stores a batch whose key it has already taken only once, so a batch that may have landed (a timeout, a request cut off as the session ended) is sent again, metrics included. A batch formed keyless has a hash of its organization and email in its key, so it goes under the same header either way. A batch formed with a key and sent keyless by a later load goes as one batch per person, each with that person's hash after the key, so it may be stored twice, but is never lost.
- **What survives:** the queue, all three signals together, is kept in the plugin's store (about 1 MB at most, a few hundred to a few thousand records, oldest dropped first), saved at most every 10 seconds and at session end, so records a session could not send are sent by a later one, in the same batches under the same keys. Past the caps, a batch is never sent in part under its key: what is left of it goes under a new key, which may store it twice, never lose it. A process that dies loses at most the last 10 seconds or so of copies, and the metrics since their last collection. The end of a session is short (Claude Code gives all of a session's end hooks 1.5 seconds together), so the last batches may be sent by the next session instead.

Rules it keeps:

- **It never holds anything up.** The exporter's row always goes on, whether or not the copy could be queued. If stamping fails, the row goes on as Claude Code wrote it, minus any key the plugin owns. The hooks on turns, model requests, tool calls, slash commands, subagents and skill prompts only watch: each passes its event and its result on unchanged, and a fault in one is caught.
- **Nothing else can pose as it.** Any key under `mainwave.plugin.`, `mainwave.telemetry.` or `mainwave.redaction.` already on a row is removed before the plugin adds its own. So is any key under `mainwave.mod.`, where earlier Mainwave plugins put their stamps. Each value it adds must fit a fixed shape.
- **Its key goes to one place.** The plugin sends the dev ingest key only to the dev collector, as a bearer token, and never writes it to a row, a file or a log. Keyless, it sends no key at all. The plugin never reads the organization's collector URL or key. This holds against settings, not against other plugins: any plugin the person installs can see and rewrite every plugin's requests, this one's included, so a dev key is only as safe as the person's other plugins.
- **It sends what its data points allow, and nothing else.** What each data point is, and when it goes, is in What it sends, below. It adds no commands, panes or tools.

With no collector configured, the plugin has no rows to stamp, but it still sends its keyless copy. A session whose rows name no organization and email (an API key, a cloud provider) sends nothing.

## What it sends

Everything the plugin sends belongs to one data point, named by an ID. Four are required: Mainwave can't route a record, join records or count spend without them, so they have no setting. Each of the others is on, off, or as Claude Code sends it:

- **On:** the plugin sends it, adding what it read in its own hooks where Claude Code's row or span leaves it out.
- **Off:** the plugin sends it in none of its records, its copies of Claude Code's rows included (prompts and responses read `<REDACTED>`, as Claude Code writes withheld text).
- **As Claude Code sends it:** the plugin sends it exactly where Claude Code's own telemetry does under the session's settings, and nowhere more.

These settings govern what the plugin sends. Where an organization's env block is in place, Claude Code's own exporter goes on sending its rows, spans and metrics under Claude Code's switches; the plugin only stamps the exporter's rows and cannot change what that exporter sends. A setting named in the Default column is the Claude Code switch that governs the data point (see Defaults, below).

| ID | Class | What it is | Where it goes (Claude Code's names) | Default |
| --- | --- | --- | --- | --- |
| `session.identity` | Identifiers | Who sent the record: Claude organization, account, email, and the ID Claude Code keeps per installation | `organization.id`, `user.account_uuid`, `user.email`, `user.id` on every record | Required |
| `session.links` | Metadata | IDs that tie records together: session, prompt, request, tool call, trace and span | `session.id`, `prompt.id`, `request_id`, `tool_use_id` and the like | Required |
| `session.client` | Metadata | What ran the session (version, entry point, Cowork surface, terminal, plan, provider, the plugin's version), and Claude Code's own event rows | The resource, `terminal.type`, `cowork.surface`, the plugin's stamps | Required |
| `usage` | Metadata | Model, tokens, cost, request time, time to first token, effort, stop reason, query source; prompt, response, tool input and result sizes | `api_request` rows, `llm_request` spans, the cost and token metrics | Required |
| `tool.call` | Metadata | Each tool call: its name, duration, success and error class, the permission decision and what made it | `tool_name`, `decision`, `source`, `success`, `error_class` | On |
| `tool.mcp` | Metadata | The MCP server and tool of each MCP call, and where the server was set up: user, project, managed, a plugin, or a claude.ai connector | `mcp_server_name`, `mcp_tool_name` in `tool_parameters`; `anthropic.mcp.server.name`; `mcp_server.name`, `mcp_tool.name`; `mcp_server_scope`; `server_name`, `server_scope` on `mcp_server_connection` | On (`OTEL_LOG_TOOL_DETAILS`) |
| `skill.name` | Metadata | The skill used | `skill_name`, `skill.name` | On (`OTEL_LOG_TOOL_DETAILS`) |
| `agent.type` | Metadata | The type of each subagent started | `subagent_type`, `agent.name` | On (`OTEL_LOG_TOOL_DETAILS`) |
| `command.name` | Metadata | The slash command run, not its arguments | `command_name` | On |
| `bash.class` | Metadata | The kind and program of each shell command, in Bash or an MCP shell tool such as Cowork's `device_bash` | `bash_command_class`, `bash_argv0` | On |
| `bash.outcome` | Metadata | Commits and pull requests made by shell commands that succeeded, Cowork's `device_bash` included | the `commit.count` and `pull_request.count` metrics | On |
| `file.kind` | Metadata | The language of each file edited or written | `language` on `code_edit_tool.decision` | On |
| `web.domain` | Metadata | The site of each page fetched | `url.domain` on WebFetch calls | On (`OTEL_LOG_TOOL_DETAILS`) |
| `repo` | Identifiers | The Git remote's address, owner and name, the branch and the commit | `vcs.*`; `git_commit_id`, `git_branch` in `tool_parameters` | On (`OTEL_METRICS_INCLUDE_REPOSITORY`) |
| `file.path` | Identifiers | The path of each file read, edited or written | `file_path` | On (`OTEL_LOG_TOOL_DETAILS`) |
| `web.url` | Identifiers | The full address of each page fetched | `url.full` on WebFetch calls | On (`OTEL_LOG_TOOL_DETAILS`) |
| `mcp.url` | Identifiers | The MCP servers set up for the session, called or not: each one's name, where it was set up and its address. A remote server's address keeps scheme, host, port and path, and drops any user name, password, query and fragment; a local server's is its command and arguments. Goes only where `tool.mcp` does | The plugin's own `mcp_server_configured` row, one per server: `server_name`, `server_scope`, `transport_type`, `server_url` | Off |
| `bash.command` | Content | The full text of each shell command, in Bash or an MCP shell tool | `full_command`, `bash_command` | On (`OTEL_LOG_TOOL_DETAILS`) |
| `tool.input` | Content | Each tool call's input: what an edit writes, search patterns, MCP arguments, subagent task prompts. Holds commands, file paths and web addresses, so it goes only where they all do | `tool_input`; `timeout`, `description` in `tool_parameters` | On (`OTEL_LOG_TOOL_DETAILS`) |
| `tool.result` | Content | What each tool answered: command output, file contents read, MCP results, a failed call's error | the `tool.output` event; `error` on a call's row and run | On (`OTEL_LOG_TOOL_CONTENT`) |
| `skill.text` | Content | The instructions of each skill run, as Claude Code expands them for the model, arguments filled in: typed as a slash command, run by the Skill tool or preloaded into a subagent. Goes only where `skill.name` does; a text with arguments only where `prompt.text` does too | The plugin's own `skill_prompt` row, one per run: `skill.name`, `skill.source`, `skill.has_arguments`, `skill.text_id`, and `skill.text` the first time the session sees that text; `skill.text_held_back` where it was held back | Off |
| `prompt.text` | Content | What the person typed, pastes expanded | `prompt`, `prompt_text`; `user_prompt` on `interaction` | On (`OTEL_LOG_USER_PROMPTS`) |
| `response.text` | Content | The model's visible answers | `response` on `assistant_response` rows | On (`OTEL_LOG_ASSISTANT_RESPONSES`, else `OTEL_LOG_USER_PROMPTS`) |
| `response.thinking` | Content | The model's thinking text, where the API returns it | `response.thinking` on `llm_request` | Off |

Never sent, whatever the settings: images and other attachments, the system prompt, `CLAUDE.md` and memory files, and raw API request and response bodies. The plugin reads no files beyond its own settings and store, except the MCP server entries above while `mcp.url` is on.

**Defaults.** With no settings for a data point, the plugin sends it as Claude Code's own telemetry does with Mainwave's org-wide setup captures on (`OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_USER_PROMPTS`, `OTEL_METRICS_INCLUDE_REPOSITORY`), in Claude Code and Cowork alike, whether or not those switches are set. Where Claude Code's row leaves a value out (Cowork's export carries no tool details, content or prompts), the plugin adds what it read in its own hooks: the call's parameters and input, the prompt, the response. A data point Claude Code doesn't send even with all four on (thinking, MCP server addresses, skill text) is off. A switch the session's environment sets to `0` (or `false`, `no`, `off`) turns what it governs to as Claude Code sends it, which with that switch off is little or nothing: Mainwave's org-wide setup writes `0` for a capture an admin turns off, and the plugin keeps that choice. An explicit setting for a data point wins over both; the plugin reads explicit settings from its store, where a later version keeps the organization's settings from Mainwave.

**The plugin's own rows.** `mcp.url` and `skill.text` are on no row of Claude Code's, so the plugin sends rows of its own for them, with the session's identity and stamps, once a row of Claude Code's has said who the session is. After a `/clear` or a resume, the session that follows gets its own: its servers and skill texts are sent again under its ID.

- For `mcp.url`, at session start, the plugin reads the MCP server entries Claude keeps:
  - `mcpServers` in Claude Code's global config (`.claude.json` in `CLAUDE_CONFIG_DIR`, else the home folder), for the user and for the project;
  - `.mcp.json` in the project folder and each folder above it, the servers Claude Code would load alone (approved, and not refused, as the settings and the project's entry in the global config say);
  - the managed `managed-mcp.json`, in the managed settings folder of the session's OS; where present, it is the only file read, as only its servers load;
  - the `.mcp.json` and manifest of each plugin installed and enabled;
  - outside the CLI, Claude Desktop's `claude_desktop_config.json`.

  It takes each server's name, transport and address, and never its headers, environment or anything else in those files. A server the organization's `deniedMcpServers` names is not sent, nor, where its `allowedMcpServers` lists servers by name, one it doesn't list. In a local server's command, the value after a flag that names a secret (`--api-key`, `--authorization`, `--cookie`), a header (`-H`) or an environment variable (`-e`) is replaced before the always-on protections run. A remote server's path is kept as written, so a token a service puts in its path goes with it; an address whose password can't be told from its host sends its scheme alone. A server in none of those files (a claude.ai connector, one the host app provides, one set on the command line) gets its row when a call first names it, with the name its tools are called by and the scope Claude Code's row gives.
- For `skill.text`, the plugin reads the text the engine expands for the model; a later run of the same text in the session carries only its `skill.text_id`. A run counts as given arguments when its slash command or Skill call had any, or when its text holds them, and its text then goes only where `prompt.text` does.

**When it is decided.** As a record is captured, and again as it is sent, so a record queued before a data point was turned off goes without it. A record an earlier session left in the outbox went through that session's settings, which this one doesn't know, so a data point set to as Claude Code sends it goes on that record only if it is on.

**What Claude Code withholds whatever its switches say,** the plugin withholds too where it can see it: an account-memory tool's (`mcp__memory__memory_*`) input and output are recorded only as their length, and responses to Claude Code's memory operations and other requests outside the conversation are not filled in. Claude Code also takes account-memory text out of the prompts and responses it records; the plugin can't see the account's memory, so a prompt or response it fills in keeps such text.

**Always on.** Whatever the settings, every identifier and content value but the session's identity is cleaned on the machine before it is queued:

- Secrets are replaced with a marker naming their kind (`[REDACTED:github_token]`): AWS access key IDs, GitHub tokens, Anthropic and OpenAI-style API keys, Slack tokens, private key blocks, JSON Web Tokens, `Authorization` header values, passwords in web addresses (`https://user:pass@host`), and values assigned to names containing `password`, `secret`, `token`, `api_key`, `access_key` or `private_key`. A record that had any carries their count, `mainwave.redaction.count`.
- Long values are cut at 61,440 characters, Claude Code's own limit for telemetry content, or at what `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` sets; lower where `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`, `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` or `OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT` says. A cut value ends with Claude Code's `[TRUNCATED` marker and carries `<attribute>_truncated` and `<attribute>_original_length`.

## What is coming

In rough order, each in a later version:

1. **Its own telemetry, to production.** The plugin already sends a session's rows, spans and metrics without the env block or a key, to the dev collector. Next it sends them to Mainwave's production collector, so an organization needs nothing but the plugin.
2. **Settings from Mainwave.** At session start the plugin asks Mainwave for the organization's settings and the session's state, by the organization, account, email and device it read.
3. **Attributes.** The organization's attribute list in the session: Claude or the person sets a value (such as the project) with `/mainwave:attribute`, or proposes a new one for an admin to accept.
4. **Anthropic's plugin directory.** A public listing, so updates reach every organization that sets the plugin to Required, and personal Pro and Max accounts can install it.

## Install

Needs Claude Code 2.1.317 or later.

`claude --version` shows the version. `claude update` updates a native install; a Homebrew, WinGet, apt, dnf or apk install updates through that package manager (`brew upgrade claude-code`, `winget upgrade Anthropic.ClaudeCode`, `sudo apt upgrade claude-code` and so on), and by default does not update by itself. On an older version the session is unaffected, as the plugin fails open, but the plugin sends less or nothing:

- Below 2.1.299, its hooks module does not load, so it stamps and sends nothing.
- From 2.1.299 to 2.1.316, its copy's spans lack `gen_ai.provider.name`, and on early versions of that range its keyless copy has gaps too (rows that name the wrong parent span, subagents' requests missing).

The version that counts is the one each session runs, and a person who has updated Claude Code in their terminal may still run older copies elsewhere:

- **Remote machines.** A session over SSH, or in a container or VM, runs the Claude Code on that machine, not the local one: update it there. The desktop app's SSH sessions run a copy the app installs on the remote machine.
- **Scripts and CI.** A `claude -p` run uses the binary its job installs, often a pinned version. Raise the pin.
- **IDE extensions.** The VS Code extension runs a copy of Claude Code it bundles, unless `claudeProcessWrapper` points it at another, and its version number is that copy's: update the extension. The JetBrains plugin runs the `claude` on the machine's `PATH`, or the one its settings name: update that.
- **The desktop app.** In a local session, its Code tab runs its own copy of Claude Code, which the app downloads and updates, so it can differ from the terminal's `claude`, and updating one does not update the other. Update the app: **Claude › Check for Updates…** on macOS, **Help › Check for Updates…** on Windows.

An organization can turn older versions away: the managed setting `requiredMinimumVersion`, set to the floor, makes Claude Code below it exit at startup (it is read from Claude Code 2.1.163 on).

`plugin.json` states the floor too, as `engines`. Claude Code reads `engines` only from 2.1.323 on, so today it turns no version away: every version that reads it is above the floor.

### For a whole organization (org sync)

An owner or admin of the Claude organization, on claude.ai:

1. **Organization settings › Plugins & skills › Sync from GitHub**, then add `mainwaveai/mainwave-agent-plugin` with **Sync automatically** on. While the repository is private, Anthropic's GitHub app must be able to read it.
2. **Inventory › mainwave › Default access › Required**, so every member's Claude Code and Cowork sessions run it with no install step.
3. If an older Mainwave plugin is in the inventory, set it to **Not available**, so only one copy stamps rows.

Each re-sync picks up the repository's `main` branch. For the stamps to reach Mainwave, the organization also needs Mainwave's managed `env` block (from Mainwave's org-wide setup); without it the plugin loads and stamps nothing.

To check it works: run a session, then look for rows with `mainwave.plugin.name = mainwave` in Mainwave.

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
scripts/check-version.sh        # plugin.json and hooks/version.ts agree; the Claude Code floor is the same in CI's pin, plugin.json and here
scripts/check-layout.sh         # one plugin, at the root: org sync refuses a .claude-plugin/ or plugin.json anywhere else
scripts/check-hooks.sh          # the row, tool call, command and spawn hooks keep their fail-open .catch; the turn hooks and session.end are hooked
node tests/e2e/compare.mjs      # real sessions, model mocked: the plugin's copy against the exporter's; without the env block, keyless and coherent
claude --plugin-dir .           # a session with the plugin loaded from this folder
```

CI runs all but the last on every pull request, on two Claude Code versions: the latest, pinned in `.github/claude-code/package.json`, and the floor, the oldest version the plugin supports, pinned in `.github/claude-code-floor/package.json`. Dependabot opens a pull request for each new Claude Code release, so a release that breaks the comparison fails that pull request alone. Dependabot's version updates don't watch the floor, so it changes only by hand: raising it is a pull request of its own, which changes the pin, `engines` in `plugin.json`, the Install section and the note at the README's top together (`scripts/check-version.sh` fails where they differ). To run the checks on another version, install it in a scratch folder (`npm i @anthropic-ai/claude-code@<version>`) and put it first on `PATH`, with `DISABLE_AUTOUPDATER=1`.

The end-to-end comparison runs `claude -p` in a fresh config folder and a scratch git repository, with an API key and a local mock of the Anthropic API, so no login and no organization's settings reach it, and nothing leaves the machine. The mock model scripts a turn that runs Bash, writes and edits a file, commits, has a command fail, is refused a command and starts a background subagent; it answers each request after a different delay, and refuses one request once as overloaded, so Claude Code retries it. The session runs three times: with the env block, once with Mainwave's org-wide setup captures on and once with each set to `0`, and then without it. With it, Claude Code's exporter sends all three signals to a local receiver, and a test-only plugin, built in a temporary folder from `tests/e2e/redirect.ts`, sends the plugin's copy there too. The script pairs every log row by session, event name and sequence; every span by what identifies it (its ID where the rows name it, else its request ID or tool call ID); and every metric series by its name and attributes, summing its points. It compares each pair field by field, attribute keys in order and value types included, and fails on any difference but the known ones in the table above, which it lists with their counts. The first runs in auto mode: the mock answers auto mode's classifier, blocking the refused command and allowing the rest, and it counts the exporter's spans of the classifier's requests as the known gap above, and, where the exporter counts those requests in `cost.usage` and `token.usage` (as through the mock, which stands where a gateway would), that share too, each token type's exactly the tokens on those spans; it fails unless the classifier was asked about that command and refused it. Without the env block, the exporter sends nothing and the plugin sends keyless; the receiver applies keyless ingest's rules (no `Authorization` header; an `idempotency-key` header of the collector's shape, which the plugin sends on every request; one `organization.id` and one `user.email` on every item, the same pair across a request) and the script fails on any request it refuses, on any span out of its place in the interaction's trace, on any row that names a kind of span other than the exporter's rows of the same event named with the env block, and when the copy lacks the commands, file paths, subagent types, tool output, prompts or responses its defaults send. As the session runs on an API key, its rows carry an organization and an email there only through `OTEL_RESOURCE_ATTRIBUTES`, standing in for what a login puts on them. `--keep` keeps what was received. The type check runs locally: start one interactive session with `claude --plugin-dir .`, which writes Claude Code's declarations to `.claude-plugin/types/` (gitignored), then run `npx -p typescript@5.6.3 tsc -p .`.

A release bumps the version in both `.claude-plugin/plugin.json` and `hooks/version.ts`.

| Module | What it holds |
| --- | --- |
| `hooks/register.ts` | the hooks: the collector row hook and its fail-open handler, the turn, model request, tool call, command and spawn hooks, `session.start` and `session.end` |
| `hooks/stamps.ts` | the keys the plugin owns, their shape rules, and the strip of forged keys |
| `hooks/settings.ts` | where the dev ingest key may come from, and its shape |
| `hooks/identity.ts` | the organization, account, email and device read from a row, and the pair a record is routed by without a key |
| `hooks/rebuild.ts` | Claude Code's spans, and the measures behind its metrics, rebuilt from rows and events; without the env block, the trace built by the plugin |
| `hooks/catalog.ts` | the data points: their IDs, classes, switches and attributes, and the table of defaults |
| `hooks/gate.ts` | the gate: which data points go, applied to every record as it is captured and again as it is sent |
| `hooks/protect.ts` | the always-on protections: secrets replaced, long values cut |
| `hooks/capture.ts` | what the hooks read for the rows Claude Code writes without it: a call's parameters and input, a prompt, a response |
| `hooks/servers.ts` | the MCP servers set up for a session, read from Claude's settings files for `mcp.url`: name, scope, transport and address |
| `hooks/derive.ts` | the rules Claude Code fills attributes by: tool names, query sources, Bash commands, line counts, languages |
| `hooks/meter.ts` | the counters behind the metrics, collected as delta points |
| `hooks/sender.ts` | the copy: one queue for all three signals, timer, batches (keyless, one organization and email each) and their idempotency keys, retries and the outbox kept in the store |
| `hooks/otlp.ts` | the copy as OTLP/JSON (log records, spans, metric points), with the resource rebuilt as the exporter builds it |
| `hooks/http.ts` | `fetchWithin`: a request with a time limit that ends with its session |

## Credits

Ported from Mainwave's internal pilot plugin, written by Ryan Merlin: the mod skeleton and the row-stamping hook, fail-open stamping and the strip of forged keys, the settings order, reading the account and email from rows, the fetch wrapper with its time limit, and the CI gate on `claude plugin validate` and `claude plugin test`. The files were ported fresh; the pilot's history stays in its own repository.

## License

Not chosen yet. Until a license is added, no rights are granted to use, copy or redistribute this code.
