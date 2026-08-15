#!/usr/bin/env bash
# Fixed-DEPTH SPRT (coalla): candidate vs base at equal depth, pentanomial, fastchess
# built-in SPRT. The sibling of sprt.sh, which is fixed-MOVETIME.
#
# Why a second script: movetime measures "strength per second", so it charges a
# candidate for being slower. When the thing under test is an EVAL and the candidate
# pays a known speed tax (the SF-net backend is ~2x fewer nps), movetime answers a
# different question than "is this eval better". Fixed depth removes speed from the
# comparison entirely — both sides search the same tree depth — so it isolates eval
# quality. Neither number is the "real" one; they answer different questions and
# should be reported together.
#
# Usage:  bash sprt_depth.sh <name> <depth> [candidate_bin] [base_bin] [engine_dir]
#   <name>          label for the run + logfile (~/sprt_<name>.log)
#   <depth>         plies per move for BOTH engines (fastchess `depth=`)
#   candidate_bin   default ./zugzwang_sfnet
#   base_bin        default ./zugzwang
#   engine_dir      default ~/sfwork/zugzwang
#
# One dir serves both engines on purpose: the SFNET build reads `sfnet.nnue` and the
# normal build reads `net.nnue`, so they cannot collide despite sharing a cwd.
#
# SPRT: H0 Elo<=0 vs H1 Elo>=5, alpha=beta=0.05 (LLR bounds +-2.94). Caps at 800 rounds
# (1600 games); if undecided at the cap, read the final Elo/LB and trend-accept if LB>0.
set -u
NAME="${1:-sfnet}"
DEPTH="${2:-8}"
CAND="${3:-./zugzwang_sfnet}"
BASE="${4:-./zugzwang}"
ZDIR="${5:-$HOME/sfwork/zugzwang}"
FC=~/fastchess/fastchess-linux-x86-64/fastchess
LOG=~/sprt_${NAME}.log
cd "$ZDIR" || exit 1
# watch_sprt.sh reads this marker to label the run; keep the `D=` form in sync with it.
echo "D=${DEPTH}" > "$LOG"
exec "$FC" \
  -engine cmd="$CAND" name="cand_${NAME}" dir="$ZDIR" \
  -engine cmd="$BASE" name="base"         dir="$ZDIR" \
  -each depth="$DEPTH" timemargin=10000 option.Hash=64 \
  -openings file="$ZDIR/book.epd" format=epd order=random \
  -sprt elo0=0 elo1=5 alpha=0.05 beta=0.05 \
  -rounds 800 -games 2 -repeat -concurrency 10 -ratinginterval 4 \
  >> "$LOG" 2>&1
