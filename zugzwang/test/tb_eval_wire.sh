#!/usr/bin/env bash
# Wire-format gate for tablebase verdicts: no eval JSON leaving `serve` may
# carry a raw internal TB score, and a solved <=5-man position must be tagged
# `"tb": "win"|"loss"`. See test/tb_eval_wire.py for the four assertions and
# why UCI is deliberately exempt.
#
#   ./test/tb_eval_wire.sh          # ~10s
#   ./test/tb_eval_wire.sh -v       # print every eval object it inspects
#
# Any arguments are passed straight through to tb_eval_wire.py.
set -uo pipefail
cd "$(dirname "$0")/.."

[ -e syzygy ] || { echo "tb_eval_wire: no syzygy/ tables — nothing to test" >&2; exit 1; }

make -s zugzwang || { echo "tb_eval_wire: build failed" >&2; exit 1; }

exec python3 test/tb_eval_wire.py "$@"
