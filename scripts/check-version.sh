#!/bin/sh
# The plugin's version is written twice: .claude-plugin/plugin.json (what Claude Code reads) and hooks/version.ts (what the plugin
# stamps on rows, since a hooks module cannot read its own manifest). Fails when they differ.
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
