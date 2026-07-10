#!/usr/bin/env bash
# setup-engines.sh — provision the Abitur opponent engines (Stockfish, Stormphrax,
# Reckless) as prebuilt AVX-512 release binaries. KISS: no compiler needed, just
# curl + tar. Designed for a Zen4/AVX-512 Linux box (coalla). Idempotent.
#
#   bash scripts/abitur/setup-engines.sh            # into ~/abitur/engines
#   ENGINES_DIR=/path bash scripts/abitur/setup-engines.sh
#
# Picks the best asset for AVX-512+VNNI hardware, falling back to plain avx512.
# After it runs, each engine is verified to answer `uci` with `uciok`.
set -euo pipefail

DIR="${ENGINES_DIR:-$HOME/abitur/engines}"
mkdir -p "$DIR"
cd "$DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# latest_asset <repo> <grep-pattern...> — echo the browser_download_url of the
# first asset in the latest release matching any pattern (in order).
latest_asset() {
  local repo="$1"; shift
  local json; json="$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest")"
  local urls; urls="$(echo "$json" | grep -o '"browser_download_url": "[^"]*"' | cut -d'"' -f4)"
  local pat
  for pat in "$@"; do
    local hit; hit="$(echo "$urls" | grep -iE "$pat" | head -1 || true)"
    [ -n "$hit" ] && { echo "$hit"; return 0; }
  done
  echo "no matching asset for $repo (patterns: $*)" >&2
  return 1
}

verify() {
  local bin="$1"
  chmod +x "$bin"
  if printf 'uci\nquit\n' | "$bin" 2>/dev/null | grep -qi uciok; then
    local name; name="$(printf 'uci\nquit\n' | "$bin" 2>/dev/null | grep -i '^id name' | head -1)"
    echo "  OK  $bin  ($name)"
  else
    echo "  FAIL $bin did not answer uciok" >&2
    return 1
  fi
}

echo "== Stockfish =="
sf_url="$(latest_asset official-stockfish/Stockfish 'ubuntu-x86-64-vnni512\.tar$' 'ubuntu-x86-64-avx512\.tar$' 'ubuntu-x86-64-bmi2\.tar$')"
echo "  $sf_url"
curl -fsSL "$sf_url" -o "$tmp/sf.tar"
tar -xf "$tmp/sf.tar" -C "$tmp"
# The tar unpacks to stockfish/stockfish-ubuntu-x86-64-*.
find "$tmp" -type f -name 'stockfish*' ! -name '*.tar' -perm -u+x -exec cp {} "$DIR/stockfish" \; 2>/dev/null || \
  find "$tmp" -type f -path '*/stockfish/stockfish*' -exec cp {} "$DIR/stockfish" \;
verify "$DIR/stockfish"

echo "== Stormphrax =="
sp_url="$(latest_asset Ciekce/Stormphrax 'vnni512$' 'avx512$' 'avx2-bmi2$')"
echo "  $sp_url"
curl -fsSL "$sp_url" -o "$DIR/stormphrax"
verify "$DIR/stormphrax"

echo "== Reckless =="
rk_url="$(latest_asset codedeliveryservice/Reckless 'linux-avx512$' 'linux-avx2$' 'linux-generic$')"
echo "  $rk_url"
curl -fsSL "$rk_url" -o "$DIR/reckless"
verify "$DIR/reckless"

echo
echo "Engines ready in $DIR:"
ls -la "$DIR"
