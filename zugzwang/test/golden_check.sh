#!/bin/bash
# M2 oracle: drive the engine's `eval` command over gomachine's 38 golden FENs and
# diff against the frozen stm-relative centipawn values (tol 5). Requires the engine
# built WITH the NNUE dispatch wired into Eval::evaluate + the net auto-loaded.
# Usage: golden_check.sh [binary] [fixture]
set -u
cd /Users/tim.alexander/chessgo/zugzwang
BIN="${1:-./hce}"
FIX="${2:-test/golden_eval.txt}"
TOL=5
pass=0; fail=0; n=0
while IFS='|' read -r fen want; do
  fen="$(echo "$fen" | sed 's/[[:space:]]*$//')"
  want="$(echo "$want" | tr -d '[:space:]')"
  [ -z "$fen" ] && continue
  out=$(printf 'position fen %s\neval\nquit\n' "$fen" | "$BIN" 2>/dev/null)
  got=$(echo "$out" | grep -iE '(^| )eval ' | tail -1 | grep -oE '\-?[0-9]+' | tail -1)
  n=$((n+1))
  if [ -z "$got" ]; then echo "NO-EVAL fen=$fen"; fail=$((fail+1)); continue; fi
  d=$((got - want)); ad=${d#-}
  if [ "$ad" -le "$TOL" ]; then pass=$((pass+1)); else echo "MISMATCH fen=$fen got=$got want=$want d=$d"; fail=$((fail+1)); fi
done < "$FIX"
echo "=== golden: $pass/$n pass (tol $TOL), $fail fail ==="
[ "$fail" -eq 0 ]
