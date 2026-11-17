#!/bin/sh
# Files the plugin keeps as copies of Mainwave's own, byte for byte: the data-point catalog (hooks/data-points.json) and the cases
# Mainwave's command rules and the plugin's must agree on (tests/fixtures/command-outcomes.json). The test engine loads only code,
# so each has a TypeScript twin the tests import: `export default` and the JSON file's text. This check fails when a twin is not
# that; `--write` rewrites the twins from the JSON files.
set -eu
cd "$(dirname "$0")/.."
write=${1:-}
status=0
twin() {
  printf '// Generated from %s by scripts/check-vendored.sh --write. Do not edit: the test engine loads no JSON file, so tests read this.\n' "$1"
  printf 'export default '
  cat "$1"
}
for pair in 'hooks/data-points.json tests/fixtures/data-points.ts' 'tests/fixtures/command-outcomes.json tests/fixtures/command-outcomes.ts'; do
  json=${pair% *}
  ts=${pair#* }
  if [ "$write" = --write ]; then
    twin "$json" >"$ts"
  elif ! twin "$json" | cmp -s - "$ts"; then
    echo "check-vendored: $ts is not $json's text; run scripts/check-vendored.sh --write" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] && echo "vendored: every twin is its JSON file's text"
exit "$status"
