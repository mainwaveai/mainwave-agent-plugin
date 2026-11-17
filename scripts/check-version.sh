#!/bin/sh
# The plugin's version is written twice: .claude-plugin/plugin.json (what Claude Code reads) and hooks/version.ts (what the plugin
# stamps on rows, since a hooks module cannot read its own manifest). Fails when they differ.
#
# The oldest Claude Code version the plugin supports (the floor) is written four times: .github/claude-code-floor/package.json
# (what CI tests), `engines` in plugin.json (what Claude Code 2.1.323 and later enforce), and in the README (what people read): in
# its Install section, on a line of its own, `Needs Claude Code <floor> or later.`, and in the note at its top, on a line of its
# own beginning `> Requires Claude Code <floor> or later`, above its first section. Fails when they differ, or when either README
# line is missing, out of place or there is more than one.
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
note=$(awk '/^## /{exit} 1' README.md | sed -n 's/^> Requires Claude Code \([0-9][0-9.]*[0-9]\) or later[,.].*$/\1/p')
others=$(grep -c '^> Requires Claude Code ' README.md || true)
if [ "$pinned" != "$note" ] || [ "$others" != 1 ]; then
  echo "check-version: the note at README.md's top says '$note' (want one line, above the first section, beginning '> Requires Claude Code $pinned or later')" >&2
  exit 1
fi
echo "claude code floor $pinned"
