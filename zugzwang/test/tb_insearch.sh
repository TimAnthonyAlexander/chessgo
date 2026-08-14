#!/usr/bin/env bash
# In-search Syzygy WDL gate — the companion to tb_conversion.sh.
#
# tb_conversion.sh gates the ROOT DTZ ranking (<=5-man roots). This one gates the
# IN-SEARCH WDL probe, which those roots no longer reach: a ranked root zeroes
# C.tbCardinality and switches the in-search probe off for the whole search. See
# test/tb_insearch.py for the two parts and the pass criteria.
#
#   ./test/tb_insearch.sh                # part A: the score gate (fast, ~30s)
#   ./test/tb_insearch.sh --deep         # + part B: 16 six/seven-man conversions
#   ./test/tb_insearch.sh --deep -v      # ... printing every ply
#
# Any arguments are passed straight through to tb_insearch.py.
set -uo pipefail
cd "$(dirname "$0")/.."

[ -e syzygy ] || { echo "tb_insearch: no syzygy/ tables — nothing to test" >&2; exit 1; }

make -s zugzwang tbdefend || { echo "tb_insearch: build failed" >&2; exit 1; }

exec python3 test/tb_insearch.py "$@"
