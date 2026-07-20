#!/usr/bin/env bash
# Live SPRT dashboard for a fastchess log — clean, in-place, no grep, no move spam.
# Renders a gomachine-style LLR progress bar (reject <-> accept) + Elo + pentanomial.
# Usage:  bash watch_sprt.sh <name>        (reads ~/sprt_<name>.log)
set -u
NAME="${1:-cand}"
LOG="$HOME/sprt_${NAME}.log"
W=46; LO=-2.94; HI=2.94              # LLR bounds for alpha=beta=0.05
cleanup(){ printf '\033[?25h\n'; exit 0; }
trap cleanup INT TERM
printf '\033[?25l'                   # hide cursor
# Real time control, read from the log's START line (don't hardcode). sprt_tc.sh writes
# "TC=8+0.08", sprt_flag.sh writes "MT=0.1s"; sprt.sh (fixed movetime) has neither → 100ms.
tclabel=$(grep -am1 -oE 'TC=[0-9+.]+|MT=[0-9.]+s' "$LOG" 2>/dev/null | head -1)
case "$tclabel" in
  TC=*) tclabel="${tclabel#TC=} clock" ;;   # e.g. "8+0.08 clock"
  MT=*) tclabel="${tclabel#MT=}/move" ;;     # e.g. "0.1s/move"
  *)    tclabel="100 ms/move" ;;             # sprt.sh legacy default
esac
while :; do
  el=$(grep -a 'Elo:'    "$LOG" 2>/dev/null | tail -1 | sed 's/^Elo: //; s/, *nElo:.*//')
  ll=$(grep -a 'LLR:'    "$LOG" 2>/dev/null | tail -1)
  ga=$(grep -a 'Games:'  "$LOG" 2>/dev/null | tail -1 | sed 's/^Games: //')
  pt=$(grep -a 'Ptnml'   "$LOG" 2>/dev/null | tail -1 | sed 's/^Ptnml(0-2): //')
  sp=$(grep -a 'SPRT:'   "$LOG" 2>/dev/null | tail -1)
  fin=$(grep -ac 'Finished game' "$LOG" 2>/dev/null || echo 0)
  run=RUNNING; pgrep -f fastchess-linux >/dev/null 2>&1 || run=DONE
  lv=$(printf '%s' "$ll" | grep -oE '\-?[0-9]+\.[0-9]+' | head -1)
  bar=$(awk -v v="${lv:-0}" -v w=$W -v lo=$LO -v hi=$HI 'BEGIN{
    if(v<lo)v=lo; if(v>hi)v=hi; c=int(w/2); p=int((v-lo)/(hi-lo)*(w-1)+0.5);
    for(i=0;i<w;i++) printf (i==p?"\033[1;33m●\033[0m":(i==c?"\033[2m┃\033[0m":"\033[2m─\033[0m")); }')
  col=36; [ "$run" = DONE ] && col=32
  printf '\033[H\033[J'
  printf '  \033[1;%dmZugzwang SPRT\033[0m  \033[1m%s\033[0m vs base   ·   %s   ·   %s\n\n' "$col" "$NAME" "$tclabel" "$run"
  printf '  \033[2mGames\033[0m  %s\n'   "${ga:-— (warming up · ${fin} finished)}"
  printf '  \033[2mElo\033[0m    %s\n'   "${el:-—}"
  printf '  \033[2mPtnml\033[0m  %s\n\n' "${pt:-—}"
  printf '  \033[2mLLR\033[0m %s\n' "${lv:-—}"
  printf '  reject ├%b┤ accept\n' "$bar"
  printf '         \033[2m%-6s%*s\033[0m\n' "$LO" $((W-2)) "+$HI"
  [ -n "$sp" ] && printf '\n  \033[1;32m➤ %s\033[0m\n' "$sp"
  if [ "$run" = DONE ] && [ -n "$el" ]; then printf '\n'; cleanup; fi
  sleep 1
done
