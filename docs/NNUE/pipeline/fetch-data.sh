#!/usr/bin/env bash
# fetch-data.sh — download + decompress Leela training binpacks for the interleaved NNUE
# pipeline (SF_PARITY_ROADMAP Phase 1). Run ON THE GPU BOX.
#
# Two modes:
#   1. MANIFEST=<file>  — download the exact "<hf-repo> <filename.zst>" list (multi-repo:
#      test80-2024 + test79 + test78 ...). This is the high-value heterogeneous run (run1.manifest).
#   2. default (no MANIFEST) — the test80-2024 months in MONTHS (single-repo convenience).
#
# Re-executable + resume-safe: skips any file already decompressed, re-verifies .zst before
# decompressing, and (re)creates the /dev/shm symlinks the trainer reads (tmpfs is wiped on a
# vast container bounce, so this is safe to re-run at every launch).
#
# Env:
#   MANIFEST  path to a "<repo> <file.zst>" manifest (overrides MONTHS mode). '#' comments ok.
#   MONTHS    test80-2024 month tags for default mode (default: Jan-Jun 2024).
#   DEST      disk decompress target (default /root/data) — real files live here.
#   SHM       dir the trainer reads (default /dev/shm) — symlinks point back to $DEST, so a box
#             with more disk than RAM works with zero recipe edits (loader is CPU-bound anyway).
#
# On success prints a `BINPACKS=...` line — copy it into the trainer env (train.sh reads it).
set -euo pipefail

MONTHS="${MONTHS:-01-jan 02-feb 03-mar 04-apr 05-may 06-jun}"
DEST="${DEST:-/root/data}"
SHM="${SHM:-/dev/shm}"
HF="https://huggingface.co/datasets"

command -v zstd >/dev/null || { echo "need zstd (apt-get install -y zstd / brew install zstd)"; exit 1; }
# Downloader: prefer aria2c (parallel, fast) on the GPU box; fall back to curl (macOS ships it).
dl() { # dl <url> <out-path>
  if command -v aria2c >/dev/null; then
    aria2c -x16 -s16 --auto-file-renaming=false -o "$(basename "$2")" -d "$(dirname "$2")" "$1"
  else
    curl -L --fail --retry 3 -o "$2" "$1"
  fi
}
mkdir -p "$DEST"

# Build the (repo, zst-filename) work list: from the manifest, or synthesised from MONTHS.
repos=(); files=()
if [ -n "${MANIFEST:-}" ]; then
  [ -f "$MANIFEST" ] || { echo "MANIFEST not found: $MANIFEST"; exit 1; }
  while read -r repo file _rest; do
    [ -z "$repo" ] && continue
    case "$repo" in \#*) continue;; esac   # skip comment lines
    repos+=("$repo"); files+=("$file")
  done < "$MANIFEST"
else
  for m in $MONTHS; do
    repos+=("test80-2024"); files+=("test80-2024-${m}-2tb7p.min-v2.v6.binpack.zst")
  done
fi

paths=()
for i in "${!files[@]}"; do
  repo="${repos[$i]}"
  zfile="${files[$i]}"
  base="${zfile%.zst}"          # decompressed name
  bin="$DEST/$base"
  zst="$DEST/$zfile"

  if [ -f "$bin" ]; then
    echo "[skip] $base already decompressed"
  else
    if [ ! -f "$zst" ]; then
      echo "[dl]   $repo/$zfile"
      dl "$HF/linrock/$repo/resolve/main/$zfile" "$zst"
    fi
    echo "[verify]     $zfile"
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
