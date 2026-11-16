#!/bin/sh
# The repository is one plugin, at its root: org sync's validation refuses a repository with a `.claude-plugin` folder or a
# `plugin.json` anywhere else, even a test's. Checks the files git tracks, which is what org sync reads.
set -eu
cd "$(dirname "$0")/.."
stray=$(git ls-files | grep -E '(^|/)\.claude-plugin/|(^|/)plugin\.json$' | grep -vE '^\.claude-plugin/(plugin|marketplace)\.json$' || true)
if [ -n "$stray" ]; then
  echo "check-layout: a plugin manifest outside the root's .claude-plugin/ (org sync refuses the repository):" >&2
  echo "$stray" | sed 's/^/  /' >&2
  exit 1
fi
echo "layout: one plugin, at the root"
