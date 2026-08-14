#!/usr/bin/env bash
# Tablebase-conversion gate — one command for CI and for any change that touches
# the TB path. Builds what it needs, then runs test/tb_conversion.py and
# propagates its exit code.
#
# The suite plays out won <=5-man endings with White = zugzwang and Black =
# tools/tbdefend (Fathom's DTZ root probe = perfect 50-move-rule defence) and
# fails if the win is not converted. See test/tb_conversion.py for the three
# pass criteria and why the DTZ root probe is both the opponent and the judge.
#
#   ./test/tb_conversion.sh                 # serve path (what the website uses)
#   ./test/tb_conversion.sh --path uci      # UCI path
#   ./test/tb_conversion.sh --movetime 500 -v
#
# Any arguments are passed straight through to tb_conversion.py.
set -uo pipefail
cd "$(dirname "$0")/.."

[ -e syzygy ] || { echo "tb_conversion: no syzygy/ tables — nothing to test" >&2; exit 1; }

make -s zugzwang tbdefend || { echo "tb_conversion: build failed" >&2; exit 1; }

exec python3 test/tb_conversion.py "$@"
