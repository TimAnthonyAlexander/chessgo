#!/usr/bin/env bash
# Byte-identity gate for the real-MultiPV change.
#
# `bench` runs a fixed 6-FEN, depth-12 single-PV search and prints one `info`
# line per iteration. With MultiPV defaulting to 1 the search tree must be
# EXACTLY what it was before the change: same depth, same score, same node
# count, same PV, line for line. nps/time are wall-clock and are stripped.
#
#   ./test/multipv_identity.sh --record <file>   # capture a baseline
#   ./test/multipv_identity.sh --check  <file>   # diff current build vs baseline
#
# Any diff at all is a failure — "close" is not a pass.
set -uo pipefail
cd "$(dirname "$0")/.."

run() {
  (printf 'bench\n'; sleep 25) | ./zugzwang 2>&1 \
    | grep -E '^info depth' \
    | sed -E 's/ nps [0-9]+//; s/ time [0-9]+//; s/ hashfull [0-9]+//'
}

mode=${1:-}
file=${2:-}
[ -n "$file" ] || { echo "usage: $0 --record|--check <file>"; exit 2; }

case "$mode" in
  --record) run > "$file"; echo "recorded $(wc -l < "$file") lines -> $file" ;;
  --check)
    tmp=$(mktemp); run > "$tmp"
    if diff -u "$file" "$tmp"; then
      echo "IDENTITY OK ($(wc -l < "$tmp") lines match)"; rm -f "$tmp"
    else
      echo "IDENTITY FAIL — search tree changed at MultiPV=1"; rm -f "$tmp"; exit 1
    fi ;;
  *) echo "usage: $0 --record|--check <file>"; exit 2 ;;
esac
