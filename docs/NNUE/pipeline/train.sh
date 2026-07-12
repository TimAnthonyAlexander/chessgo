#!/usr/bin/env bash
# train.sh — resume-capable NNUE training wrapper for the interleaved pipeline
# (SF_PARITY_ROADMAP Phase 1). Run ON THE GPU BOX (or the M3 with FEATURES=metal).
#
# Re-run / supervisor-restart safe: resumes from the highest existing checkpoint and exits 0
# once the run reaches SB (so `autorestart=unexpected` stops on completion). A vast container
# bounce wipes tmpfs + kills the process but the disk checkpoints survive — just re-launch.
#
# Env levers (all optional; defaults reproduce the shipped chessgo_threats_sf_640 EXCEPT
# INTERLEAVE, which defaults ON here because that is the whole point of Phase 1):
#   NET_ID     checkpoint/net name          (default chessgo_threats_sf_640)
#   SB         end superbatch               (default 640)
#   BINPACKS   ':'-separated source list    (default: the trainer's built-in test80 Jan-Apr)
#   INTERLEAVE 1=round-robin sources / 0=concat   (default 1)
#   WDL_ANNEAL 1=LinearWDL(START->END) / 0=ConstantWDL 0.6   (default 0 — anneal is a lever,
#              run it as a SINGLE-VARIABLE A/B, see DATA_RECIPE_SF_2026 §lambda-coupling)
#   WDL_START/WDL_END   anneal endpoints    (default 0.0 -> 0.25 = result-weight up)
#   FEATURES   cargo backend feature        (default cuda; use metal on the M3)
#   FETCH      non-empty => run fetch-data.sh first (recreates /dev/shm symlinks)
#   OUT_DIR    checkpoint dir               (default checkpoints)
set -euo pipefail

BULLET_DIR="${BULLET_DIR:-$HOME/nnue-training/bullet}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$BULLET_DIR"

export CUDA_PATH="${CUDA_PATH:-/usr/local/cuda}"
export PATH="$CUDA_PATH/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_PATH/lib64:${LD_LIBRARY_PATH:-}"

FEATURES="${FEATURES:-cuda}"
NET_ID="${NET_ID:-chessgo_threats_sf_640}"
SB="${SB:-640}"
OUT_DIR="${OUT_DIR:-checkpoints}"

# (re)create /dev/shm data symlinks + optionally download (tmpfs is wiped on a container bounce).
if [ -n "${FETCH:-}" ]; then
  # shellcheck disable=SC1091
  eval "$(bash "$HERE/fetch-data.sh" | grep '^BINPACKS=')"
  export BINPACKS
fi

# Resume from the highest checkpoint sb (weights + Adam moments restored inside the trainer).
latest="$(ls -d "$OUT_DIR/${NET_ID}-"* 2>/dev/null | sed "s#.*${NET_ID}-##" | grep -E '^[0-9]+$' | sort -n | tail -1 || true)"
START_SB=1
if [ -n "$latest" ]; then
  if [ "$latest" -ge "$SB" ]; then echo "DONE: checkpoint $latest >= SB $SB — nothing to do"; exit 0; fi
  START_SB=$((latest + 1)); echo "RESUME from checkpoint $latest (start_superbatch=$START_SB)"
fi

echo "TRAIN net=$NET_ID sb=$SB start=$START_SB interleave=${INTERLEAVE:-1} wdl_anneal=${WDL_ANNEAL:-0} features=$FEATURES"
SB="$SB" START_SB="$START_SB" NET_ID="$NET_ID" OUT_DIR="$OUT_DIR" \
  INTERLEAVE="${INTERLEAVE:-1}" BINPACKS="${BINPACKS:-}" \
  WDL_ANNEAL="${WDL_ANNEAL:-0}" WDL_START="${WDL_START:-0.0}" WDL_END="${WDL_END:-0.25}" \
  cargo r -r --features "$FEATURES" --example chessgo_ml_threats_sf
