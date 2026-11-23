# Security policy

This policy covers the Mainwave plugin for Claude Code and Cowork in this repository: the hooks module, what it reads and sends, how it reads its settings, and the CI workflows that test it. If you find a vulnerability in Mainwave's service through the plugin, report it to the same address; the rest of this policy applies to the plugin alone.

## Report a vulnerability by email

Email security@mainwave.com. Do not open a public issue, pull request or discussion for it.

In the report, give:

- the plugin's version (`version` in `.claude-plugin/plugin.json`) and the Claude Code version (`claude --version`)
- where the session runs: the terminal, an IDE extension, the desktop app or Cowork, and whether the plugin came from org sync, a marketplace install or `--plugin-dir`
- the steps that reproduce it, and the settings they need
- what an attacker gets, and what they need to be or control first

Use example values in the report. Never send a real credential, or someone else's prompts, code or personal data.

## What happens next

We confirm that we received the report, rate how severe it is by what it lets an attacker do, and keep you informed until a fix is released. Please keep the details private until then. We name you in the advisory if you want to be credited.

## In scope

Some examples of what we want to hear about:

- The plugin sends something its README says it never sends, or sends a data point that the settings in force turn off.
- A secret, or personal data that a redaction pack in force covers, gets past the plugin's protections.
- A repository's settings, a prompt, a tool's output or other content a session reads changes where the plugin sends data, raises what it sends, or forges the attributes it owns.
- The commands the plugin runs for its lookups (`git show`, `gh pr view`, `glab mr view`) run something other than what the plugin meant.
- A fault in the plugin holds a tool call or a session, or makes it fail.
- A CI workflow exposes a token or runs code from an untrusted pull request with write access.

## Out of scope

- Vulnerabilities in Claude Code or Cowork themselves. Report those to Anthropic, under its [responsible disclosure policy](https://www.anthropic.com/responsible-disclosure-policy).
- Anything that needs an attacker who already controls the person's machine, their user settings or their organization's managed settings. Those choose what the plugin sends and where, by design.
- Data the plugin sends as its README documents, with the settings that send it.
- Scanner output with no demonstrated impact.

## Supported versions

Only the newest release gets security fixes. A fix ships in a new release. Organizations that sync the plugin get it with their next sync, and a marketplace install gets it with its next update.

## Good-faith research

We do not take legal action against research on the plugin done in good faith under this policy; [LICENSE](LICENSE) permits the copies and changes it needs. Test with your own account and your own organization. Do not read or change other people's data, and do not degrade Mainwave's service for anyone else. If you are not sure whether something is allowed, ask at security@mainwave.com first.
