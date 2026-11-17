#!/bin/sh
# The plugin's version is written twice: .claude-plugin/plugin.json (what Claude Code reads) and hooks/version.ts (what the plugin
# stamps on rows, since a hooks module cannot read its own manifest). Fails when they differ.
#
# The oldest Claude Code version the plugin supports (the floor) is written three times: .github/claude-code-floor/package.json
# (what CI tests), `engines` in plugin.json (what Claude Code 2.1.323 and later enforce) and the README's Install section (what
# people read), on a line of its own: `Needs Claude Code <floor> or later.`. Fails when they differ, when the Install section has
# no such line or more than one, or when any "Claude Code <version> or later" elsewhere in the README (the note at its top) names
# another version.
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
readme=$(awk '/^## /{install = ($0 == "## Install")} install' README.md | sed -n 's/^Needs Claude Code \([0-9][0-9.]*[0-9]\) or later\.$/\1/p')
if [ ">=$pinned" != "$engines" ] || [ "$pinned" != "$readme" ]; then
  echo "check-version: the Claude Code floor differs: .github/claude-code-floor/package.json pins '$pinned', plugin.json's engines say '$engines' (want '>=$pinned'), README.md's Install section says '$readme' (want one line 'Needs Claude Code $pinned or later.')" >&2
  exit 1
fi
stray=$(grep -o 'Claude Code [0-9][0-9.]*[0-9] or later' README.md | grep -v "^Claude Code $pinned or later\$" || true)
if [ -n "$stray" ]; then
  echo "check-version: README.md names another floor than the pinned $pinned: $stray" >&2
  exit 1
fi
echo "claude code floor $pinned"
