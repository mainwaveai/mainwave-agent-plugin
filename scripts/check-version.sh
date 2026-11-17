#!/bin/sh
# The plugin's version is written twice: .claude-plugin/plugin.json (what Claude Code reads) and hooks/version.ts (what the plugin
# stamps on rows, since a hooks module cannot read its own manifest). Fails when they differ.
#
# The oldest Claude Code version the plugin supports (the floor) is written three times: .github/claude-code-floor/package.json
# (what CI tests), `engines` in plugin.json (what Claude Code 2.1.323 and later enforce) and the README's Install section (what
# people read). Fails when they differ.
set -eu
cd "$(dirname "$0")/.."
manifest=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' .claude-plugin/plugin.json)
code=$(sed -n "s/^export const VERSION = '\([^']*\)'$/\1/p" hooks/version.ts)
if [ -z "$manifest" ] || [ -z "$code" ]; then
  echo "check-version: could not read a version (plugin.json: '$manifest', hooks/version.ts: '$code')" >&2
  exit 1
fi
if [ "$manifest" != "$code" ]; then
  echo "check-version: plugin.json says $manifest, hooks/version.ts says $code" >&2
  exit 1
fi
echo "version $code"

pinned=$(node -p "require('./.github/claude-code-floor/package.json').devDependencies['@anthropic-ai/claude-code']")
engines=$(node -p "require('./.claude-plugin/plugin.json').engines?.['claude-code']")
readme=$(sed -n 's/^Needs Claude Code \([0-9][0-9.]*[0-9]\) or later\..*$/\1/p' README.md)
if [ ">=$pinned" != "$engines" ] || [ "$pinned" != "$readme" ]; then
  echo "check-version: the Claude Code floor differs: .github/claude-code-floor/package.json pins '$pinned', plugin.json's engines say '$engines' (want '>=$pinned'), README.md says '$readme'" >&2
  exit 1
fi
echo "claude code floor $pinned"
