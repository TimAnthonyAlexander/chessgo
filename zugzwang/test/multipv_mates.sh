#!/usr/bin/env bash
# MultiPV correctness suite.
#
# Every FEN below is a mate verified against Stockfish 18 (~/sf18-arm, tag sf_18).
# Four of the five are SACRIFICES — the mating move hangs material, so a static
# eval scores it terribly. That is precisely the class of move the old
# /candidates prefilter threw away before searching it (it dropped Be5# in the
# first position, which /bestmove found in 9,812 nodes).
#
# The suite asserts the property that actually matters: line 1 is the mate at
# EVERY MultiPV setting, and the extra lines are well-formed (distinct first
# moves, non-increasing scores, one common depth).
#
#   ./test/multipv_mates.sh            # UCI mode (default)
#   ./test/multipv_mates.sh --http URL # also check /bestmove and /candidates agree
set -uo pipefail
cd "$(dirname "$0")/.."

DEPTH=14
fail=0

# fen | expected first move (uci) | expected mate distance
TESTS=(
  "r4rk1/ppq2pBp/2pbp3/8/2B5/2nP3P/PPPnRP2/6RK w - - 0 19|g7e5|1"
  "6k1/5ppp/8/8/8/1Q6/5PPP/6K1 w - - 0 1|b3b8|1"
  "r1bq2r1/b4pk1/p1pp1p2/1p2pP2/1P2P1PB/3P4/1PPQ2P1/R3K2R w KQ - 0 1|d2h6|2"
  "r1b2k1r/ppp1bppp/8/1B1Q4/5q2/2P5/PPP2PPP/R3R1K1 w - - 0 1|d5d8|2"
  "5rkr/pp2Rp2/1b1p1Pb1/3P2Q1/2n3P1/2p5/P4P2/4R1K1 w - - 0 1|g5g6|2"
)

uci_run() { # <fen> <multipv>
  (printf 'setoption name MultiPV value %s\nposition fen %s\ngo depth %s\n' "$2" "$1" "$DEPTH"; sleep 6) \
    | ./zugzwang 2>/dev/null | grep -E '^info depth'
}

echo "=== UCI MultiPV mate suite (depth $DEPTH) ==="
for t in "${TESTS[@]}"; do
  IFS='|' read -r fen want_move want_mate <<< "$t"
  for n in 1 3 5; do
    out=$(uci_run "$fen" "$n")
    # Last completed iteration's line 1. With MultiPV==1 the engine prints no
    # `multipv` token at all (byte-identical single-PV output), so accept both.
    line1=$(echo "$out" | grep -E ' multipv 1 | multipv 1$' | tail -1)
    [ -n "$line1" ] || line1=$(echo "$out" | tail -1)

    got_move=$(echo "$line1" | gawk '{for(i=1;i<=NF;i++) if($i=="pv"){print $(i+1); exit}}')
    got_mate=$(echo "$line1" | gawk '{for(i=1;i<NF;i++) if($i=="mate"){print $(i+1); exit}}')

    if [ "$got_move" = "$want_move" ] && [ "$got_mate" = "$want_mate" ]; then
      status="ok"
    else
      status="FAIL (want $want_move mate $want_mate, got '${got_move:-none}' mate '${got_mate:-none}')"
      fail=1
    fi

    # Line hygiene, MultiPV>1 only: N distinct first moves, scores non-increasing.
    extra=""
    if [ "$n" -gt 1 ]; then
      lastdepth=$(echo "$out" | gawk '{for(i=1;i<=NF;i++) if($i=="depth"){d=$(i+1); break}} {if(d+0>m+0) m=d+0} END{print m}')
      lines=$(echo "$out" | grep -E "^info depth $lastdepth " | grep -E ' multipv ' || true)
      if [ -z "$lines" ]; then
        extra=" [NO multipv info lines emitted — MultiPV option not honoured]"; fail=1
      else
        nmoves=$(echo "$lines" | gawk '{for(i=1;i<=NF;i++) if($i=="pv"){print $(i+1); next}}' | sort -u | wc -l | tr -d ' ')
        ncount=$(echo "$lines" | wc -l | tr -d ' ')
        if [ "$ncount" != "$n" ]; then extra=" [expected $n lines, got $ncount]"; fail=1; fi
        if [ "$nmoves" != "$ncount" ]; then extra="$extra [DUPLICATE first moves: $ncount lines, $nmoves distinct]"; fail=1; fi
      fi
      # scores must be non-increasing down the list (mate > cp handled by the engine's own ordering)
      if ! echo "$lines" | gawk '
        {for(i=1;i<=NF;i++){ if($i=="cp"){s=$(i+1)+0;f=1;break} if($i=="mate"){m=$(i+1)+0; s=(m>0?100000-m:-100000-m); f=1; break} }}
        f&&NR>1&&s>prev+0{exit 1} {prev=s;f=0} '; then
        extra="$extra [SCORES not descending]"; fail=1
      fi
    fi
    printf '  multipv %-2s %-6s %s%s\n' "$n" "$status" "${fen:0:34}" "$extra"
  done
done

if [ "${1:-}" = "--http" ]; then
  URL=${2:-http://127.0.0.1:6476}
  echo "=== HTTP: /bestmove and /candidates must agree on line 1 ($URL) ==="
  for t in "${TESTS[@]}"; do
    IFS='|' read -r fen want_move want_mate <<< "$t"
    bm=$(curl -s -m 30 -X POST "$URL/bestmove" -H 'Content-Type: application/json' \
          -d "{\"fen\":\"$fen\",\"limits\":{\"depth\":$DEPTH,\"multipv\":5}}")
    cd_=$(curl -s -m 30 -X POST "$URL/candidates" -H 'Content-Type: application/json' \
          -d "{\"fen\":\"$fen\",\"limits\":{\"depth\":$DEPTH,\"multipv\":5}}")
    b=$(echo "$bm" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("bestmove"), (d.get("eval") or {}).get("type"), (d.get("eval") or {}).get("value"))' 2>/dev/null)
    c=$(echo "$cd_" | python3 -c 'import json,sys; m=json.load(sys.stdin)["moves"][0]; print(m["uci"], m["eval"]["type"], m["eval"]["value"])' 2>/dev/null)
    if [ "$b" = "$want_move mate $want_mate" ] && [ "$c" = "$want_move mate $want_mate" ]; then
      printf '  ok     %s\n' "${fen:0:44}"
    else
      printf '  FAIL   %s\n         bestmove=[%s] candidates=[%s] want=[%s mate %s]\n' \
        "${fen:0:44}" "$b" "$c" "$want_move" "$want_mate"
      fail=1
    fi
  done
fi

[ "$fail" = 0 ] && echo "ALL PASS" || echo "FAILURES PRESENT"
exit $fail
