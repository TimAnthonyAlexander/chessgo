#!/usr/bin/env bash
# Tablebase conversion BY RATING — the gate for the WEAKENED bot ladder
# (`limits.rating`), which is the path almost every bot on the site uses.
#
# tb_conversion.sh gates the full-strength path. This one gates
# Rating::root_scores -> Weakening::pick in a DTZ-ranked root: the ladder must
# be MEANINGFUL there (top rung converts, curve rises with rating, not flat),
# not merely "never loses the win". See test/tb_rating.py for what it asserts
# and why a weak rung is allowed — expected, even — to fail to convert.
#
# Re-run this after ANY change to src/rating.cpp or src/weakening.cpp, together
# with `./zugzwang ratingtest probe` and `./zugzwang ratingtest gauntlet`.
#
#   ./test/tb_rating.sh                # the gate (~40 games per rung)
#   ./test/tb_rating.sh -n 10 -v
#
# Any arguments are passed straight through to tb_rating.py.
set -uo pipefail
cd "$(dirname "$0")/.."

[ -e syzygy ] || { echo "tb_rating: no syzygy/ tables — nothing to test" >&2; exit 1; }

make -s zugzwang tbdefend || { echo "tb_rating: build failed" >&2; exit 1; }

exec python3 test/tb_rating.py "$@"
