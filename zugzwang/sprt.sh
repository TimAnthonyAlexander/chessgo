#!/usr/bin/env bash
# Zugzwang SPRT harness (coalla): a candidate binary vs the accepted base, movetime
# 100 ms, pentanomial, fastchess built-in SPRT. Two binaries (no per-engine env needed).
#
# Usage:  bash sprt.sh <name> [candidate_bin] [base_bin]
#   <name>          label for the run + logfile (~/sprt_<name>.log)
#   candidate_bin   default ./zugzwang        (the change under test)
#   base_bin        default ./zugzwang_base   (last accepted)
#
# SPRT: H0 Elo<=0 vs H1 Elo>=5, alpha=beta=0.05 (LLR bounds ±2.94). Caps at 800 rounds
# (1600 games); if undecided at the cap, read the final Elo/LB and trend-accept if LB>0.
set -u
NAME="${1:-cand}"
CAND="${2:-./zugzwang}"
BASE="${3:-./zugzwang_base}"
ZDIR=/home/tim/chessgo/zugzwang
FC=~/fastchess/fastchess-linux-x86-64/fastchess
LOG=~/sprt_${NAME}.log
cd "$ZDIR" || exit 1
exec "$FC" \
  -engine cmd="$CAND" name="cand_${NAME}" dir="$ZDIR" \
  -engine cmd="$BASE" name="base"          dir="$ZDIR" \
  -each st=0.1 timemargin=1000 option.Hash=64 \
  -openings file="$ZDIR/book.epd" format=epd order=random \
  -sprt elo0=0 elo1=5 alpha=0.05 beta=0.05 \
  -rounds 800 -games 2 -repeat -concurrency 6 -ratinginterval 4 \
  > "$LOG" 2>&1
