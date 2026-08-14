#!/usr/bin/env bash
# Every zugzwang gate, in one run, with a single exit code.
#
# Exists because the Syzygy-conversion bug (the engine drawing won ≤5-man endings
# while reporting +314.97 for 30 moves) was possible for weeks with all of its
# gates green — because the gates that would have caught it did not exist, and the
# ones that did exist were opt-in and nobody ran them together. Four suites now pin
# that behaviour; this is the one command that runs them, so "did I break the
# tablebase work" has a single answer instead of nine.
#
# Usage:  ./test/all.sh [--quick]
#   --quick   skips tb_rating (~200s, 720 games) and tb_insearch --deep (~60s);
#             everything else runs. Use the full run before anything that ships.
#
# SEQUENTIAL BY DESIGN. Several suites drive the engine at a fixed movetime and
# judge the result — running them concurrently changes how many nodes each search
# gets and therefore what they measure. Do not parallelise this file.
#
# Runtime: ~9-10 min full, ~5 min --quick, on an M3.
set -u
cd "$(dirname "$0")/.." || exit 1

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

PASS=0; FAIL=0; FAILED=""
run() {
    local name="$1"; shift
    local start; start=$(date +%s)
    printf '%-22s ' "$name"
    local out; out=$("$@" 2>&1); local rc=$?
    local dur=$(( $(date +%s) - start ))
    if [ $rc -eq 0 ]; then
        printf 'PASS  %3ds  %s\n' "$dur" "$(printf '%s' "$out" | tail -1 | cut -c1-72)"
        PASS=$((PASS+1))
    else
        printf 'FAIL  %3ds  (rc=%d)\n' "$dur" "$rc"
        printf '%s\n' "$out" | tail -6 | sed 's/^/    | /'
        FAIL=$((FAIL+1)); FAILED="$FAILED $name"
    fi
}

echo "zugzwang gates — $(git rev-parse --short HEAD 2>/dev/null || echo '?')$([ -n "$(git status --porcelain 2>/dev/null)" ] && echo ' (dirty)')"
echo

run build            make
run perft            ./perft_test
run golden_eval      ./test/golden_check.sh ./zugzwang
run multipv_mates    ./test/multipv_mates.sh
# --- the four Syzygy gates. See zugzwang/CLAUDE.md's tablebase sections for what
#     each one is defending and why it is written the way it is.
run tb_conversion    ./test/tb_conversion.sh
run tb_conversion_uci ./test/tb_conversion.sh --path uci
run tb_insearch      ./test/tb_insearch.sh
run tb_eval_wire     ./test/tb_eval_wire.sh
if [ $QUICK -eq 0 ]; then
    run tb_insearch_deep ./test/tb_insearch.sh --deep
    run tb_rating        ./test/tb_rating.sh
fi

echo
if [ $FAIL -eq 0 ]; then
    echo "ALL $PASS GATES PASSED"
    exit 0
fi
echo "$FAIL FAILED:$FAILED  ($PASS passed)"
exit 1
