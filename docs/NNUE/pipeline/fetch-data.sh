#!/usr/bin/env bash
# fetch-data.sh — download + decompress Leela test80-2024 binpacks for the interleaved
# NNUE data pipeline (SF_PARITY_ROADMAP Phase 1). Run ON THE GPU BOX.
#
# Re-executable + resume-safe: skips any file already decompressed, re-verifies .zst before
# decompressing, and (re)creates the /dev/shm symlinks the trainer reads (tmpfs is wiped on a
# vast container bounce, so this is safe to re-run at every launch).
#
# Env:
#   MONTHS  space-separated month tags to fetch (default: Jan-Jun 2024 = SFNNv10+ range).
#   DEST    disk decompress target (default /root/data) — real files live here.
#   SHM     dir the trainer reads (default /dev/shm) — symlinks point back to $DEST, so a box
#           with more disk than RAM works with zero recipe edits (loader is CPU-bound anyway).
#
# On success prints a `BINPACKS=...` line — copy it into the trainer env (train.sh reads it).
set -euo pipefail

MONTHS="${MONTHS:-01-jan 02-feb 03-mar 04-apr 05-may 06-jun}"
DEST="${DEST:-/root/data}"
SHM="${SHM:-/dev/shm}"
REPO="https://huggingface.co/datasets/linrock/test80-2024/resolve/main"

command -v aria2c >/dev/null || { echo "need aria2c (apt-get install -y aria2)"; exit 1; }
command -v zstd   >/dev/null || { echo "need zstd (apt-get install -y zstd)"; exit 1; }
mkdir -p "$DEST"

paths=()
for m in $MONTHS; do
  base="test80-2024-${m}-2tb7p.min-v2.v6.binpack"
  bin="$DEST/$base"
  zst="$DEST/$base.zst"

  if [ -f "$bin" ]; then
    echo "[skip] $base already decompressed"
  else
    if [ ! -f "$zst" ]; then
      echo "[dl]   $base.zst"
      aria2c -x16 -s16 --auto-file-renaming=false -o "$base.zst" -d "$DEST" "$REPO/$base.zst"
    fi
    echo "[verify]     $base.zst"
    zstd --long=31 -t "$zst"
    echo "[decompress] -> $base"
    zstd -d --long=31 "$zst" -o "$bin"
    rm -f "$zst"   # reclaim space; re-downloads if re-run and the .bin is missing
  fi

  ln -sf "$bin" "$SHM/$base"
  paths+=("$SHM/$base")
  echo "[ready] $SHM/$base"
done

# Emit the BINPACKS env string (':'-separated) the trainer's data loader consumes.
printf 'BINPACKS='
( IFS=':'; printf '%s\n' "${paths[*]}" )
