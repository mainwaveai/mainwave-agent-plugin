#!/bin/sh
# The version a pull request to main carries: YYYY.M.N in UTC, the year, the month with no leading zero, and a release number that
# starts at 1 each month. When main's version is from this month, N is main's plus one; otherwise it is this month's first.
#
#   scripts/next-version.sh           prints the next version
#   scripts/next-version.sh --check   fails unless .claude-plugin/plugin.json and hooks/version.ts carry it
#   scripts/next-version.sh --write   writes it to both
#
# Main's version is read from origin/main (fetch it first: `git fetch origin main`), or from MW_MAIN_VERSION where set. The month is
# today's in UTC, or MW_VERSION_MONTH (`YYYY.M`) where set. CI's version job writes it on every pull request (README, Releasing).
set -eu
cd "$(dirname "$0")/.."

main=${MW_MAIN_VERSION:-$(git show origin/main:.claude-plugin/plugin.json | sed -n 's/^  "version": "\([^"]*\)",$/\1/p')}
month=${MW_VERSION_MONTH:-$(date -u '+%Y %m' | awk '{ print $1 "." $2 + 0 }')}
case $month in
  [0-9][0-9][0-9][0-9].[1-9] | [0-9][0-9][0-9][0-9].1[0-2]) ;;
  *) echo "next-version: '$month' is not a month (YYYY.M)" >&2; exit 1 ;;
esac
if [ -z "$main" ]; then
  echo "next-version: could not read main's version (origin/main:.claude-plugin/plugin.json)" >&2
  exit 1
fi

# Main's version is YYYY.M.N, or, before the first release under this scheme, any other (0.1.0), which starts this month at 1.
if echo "$main" | grep -Eqx '[0-9]{4}\.([1-9]|1[0-2])\.[1-9][0-9]*'; then
  main_month=${main%.*}
  n=${main##*.}
  if [ "$main_month" = "$month" ]; then
    next="$month.$((n + 1))"
  elif [ "$(printf '%s\n%s\n' "$main_month" "$month" | sort -t. -k1,1n -k2,2n | tail -n 1)" = "$main_month" ]; then
    echo "next-version: main's version $main is from a later month than $month" >&2
    exit 1
  else
    next="$month.1"
  fi
else
  next="$month.1"
fi

case ${1:-} in
  '')
    echo "$next"
    ;;
  --check)
    have=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' .claude-plugin/plugin.json)
    code=$(sed -n "s/^export const VERSION = '\([^']*\)'$/\1/p" hooks/version.ts)
    if [ "$have" != "$next" ] || [ "$code" != "$next" ]; then
      echo "next-version: main is at $main, so this branch must carry $next; plugin.json says '$have', hooks/version.ts says '$code'." >&2
      echo "CI's version job writes it on a pull request from a branch of this repository. On one from a fork it can't push:" >&2
      echo "a maintainer runs scripts/next-version.sh --write on the branch and pushes. Where main has moved since, update the branch first." >&2
      exit 1
    fi
    echo "version $next (main is at $main)"
    ;;
  --write)
    tmp=$(mktemp)
    sed "s/^  \"version\": \"[^\"]*\",\$/  \"version\": \"$next\",/" .claude-plugin/plugin.json >"$tmp" && cat "$tmp" >.claude-plugin/plugin.json
    sed "s/^export const VERSION = '[^']*'\$/export const VERSION = '$next'/" hooks/version.ts >"$tmp" && cat "$tmp" >hooks/version.ts
    rm -f "$tmp"
    sh scripts/next-version.sh --check
    ;;
  *)
    echo "usage: scripts/next-version.sh [--check | --write]" >&2
    exit 2
    ;;
esac
