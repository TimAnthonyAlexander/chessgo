#pragma once
// Drives an external Stockfish binary over UCI/stdio for the `/sf-bestmove`
// serve endpoint (serve_handlers.cpp). Mirrors gomachine's
// internal/server/stockfish.go + internal/bench/uci.go exactly: resolve the
// binary, spawn a FRESH process per call, uci/isready handshake, apply
// UCI_LimitStrength+UCI_Elo when elo>0, `go movetime|depth`, read the last
// `info score` line + `bestmove`, then quit — so zugzwang's `/sf-bestmove`
// wire contract is byte-identical to gomachine's.
#include <string>

namespace SFUCI {

// Set once at startup from the `-sf-path` CLI flag (serve.cpp). Empty means
// "no explicit override" — resolve_path() falls through to env/PATH/fallbacks.
void set_path_override(const std::string& path);

// Resolves the Stockfish binary: the `-sf-path` override above, then
// $SF_PATH, then $STOCKFISH_PATH (gomachine's env var name, kept as a
// fallback so an existing prod/dev env needs no change to also point
// zugzwang at the same binary), then a $PATH lookup for "stockfish", then a
// handful of common absolute install locations — mirrors gomachine's
// stockfishPath() (internal/server/stockfish.go) including the reason it
// checks /usr/games/stockfish: systemd units often run with a minimal PATH
// that omits Debian/Ubuntu's apt install dir even though an interactive
// shell's `which stockfish` finds it. Returns "" if no binary is found
// anywhere.
std::string resolve_path();

// One Stockfish verdict: the UCI bestmove plus the last `info score` line
// seen before it (hasScore=false if Stockfish never printed one — e.g. an
// instant forced move). `value` is raw cp (side-to-move POV) when !isMate,
// or the raw UCI `score mate N` ply count when isMate (matches
// gomachine's wire value exactly — see stockfish.go's mate-distance
// recovery, which is a lossless roundtrip of this same raw N).
struct BestMoveResult {
    std::string bestmove;
    bool hasScore = false;
    bool isMate = false;
    int value = 0;
};

// Spawns a fresh Stockfish process at `path`, performs the uci/isready
// handshake, sets UCI_LimitStrength+UCI_Elo when elo>0 (elo<=0 = full
// strength, no limit), asks for a move at `fen` under `depth` plies (if >0,
// takes precedence) else `movetimeMs` (default 100 when both are <=0), and
// terminates the process afterward — one process per call, matching
// gomachine's stateless FEN-in contract. Throws ApiError{502,...} on any
// spawn/handshake/IO failure.
BestMoveResult query(const std::string& path, const std::string& fen, int elo,
                      int movetimeMs, int depth);

} // namespace SFUCI
