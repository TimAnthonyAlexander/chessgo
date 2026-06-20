//go:build cgo

// Package syzygy wraps the Fathom Syzygy tablebase prober (the reference C
// library used by Stockfish/LC0) for ≤7-piece endgame probing. It exposes a
// small, allocation-free Go API: open a tablebase directory once, then probe a
// position at the search ROOT for the WDL value + a DTZ-optimal move.
//
// The C side (tbprobe.c, which textually includes tbchess.h) is compiled by cgo.
// tb_init / tb_probe_root mutate process-global state and are NOT thread-safe, so
// every entry point here is guarded by a package-level mutex — probing is only
// done at the root (≤7 pieces), so the serialization cost is negligible.
//
// This file is compiled only with cgo enabled (the default for native builds on
// dev + prod). With CGO_ENABLED=0 (e.g. `make cross` portable artifacts) the
// !cgo stub in syzygy_stub.go is used instead and tablebase support is inert.
package syzygy

// #cgo CFLAGS: -O2 -DNDEBUG -std=gnu11 -Wno-unused-function
// #cgo LDFLAGS: -lpthread
// #include <stdlib.h>
// #include "tbprobe.h"
//
// // cgo cannot call function-like macros directly, so wrap the result
// // accessors + sentinels in static inline functions it can bind to.
// static inline unsigned go_tb_get_wdl(unsigned r)      { return TB_GET_WDL(r); }
// static inline unsigned go_tb_get_from(unsigned r)     { return TB_GET_FROM(r); }
// static inline unsigned go_tb_get_to(unsigned r)       { return TB_GET_TO(r); }
// static inline unsigned go_tb_get_promotes(unsigned r) { return TB_GET_PROMOTES(r); }
// static inline unsigned go_tb_get_ep(unsigned r)       { return TB_GET_EP(r); }
// static inline unsigned go_tb_failed(void)             { return TB_RESULT_FAILED; }
// static inline unsigned go_tb_checkmate(void)          { return TB_RESULT_CHECKMATE; }
// static inline unsigned go_tb_stalemate(void)          { return TB_RESULT_STALEMATE; }
import "C"

import (
	"errors"
	"sync"
	"unsafe"
)

// WDL values, matching Fathom's TB_LOSS..TB_WIN. "Cursed"/"blessed" are wins or
// losses that the 50-move rule turns into draws — they should score as draws.
const (
	WDLLoss        = int(C.TB_LOSS)         // loss
	WDLBlessedLoss = int(C.TB_BLESSED_LOSS) // loss, but drawn by the 50-move rule
	WDLDraw        = int(C.TB_DRAW)         // draw
	WDLCursedWin   = int(C.TB_CURSED_WIN)   // win, but drawn by the 50-move rule
	WDLWin         = int(C.TB_WIN)          // win
)

// Promotion codes for Result.Promotes, matching Fathom's TB_PROMOTES_*.
const (
	PromoteNone   = int(C.TB_PROMOTES_NONE)
	PromoteQueen  = int(C.TB_PROMOTES_QUEEN)
	PromoteRook   = int(C.TB_PROMOTES_ROOK)
	PromoteBishop = int(C.TB_PROMOTES_BISHOP)
	PromoteKnight = int(C.TB_PROMOTES_KNIGHT)
)

// mu serializes all Fathom calls. Fathom's root/DTZ probing is explicitly not
// thread-safe, and the SPRT harness runs many games concurrently, each engine
// sharing the one process-global tablebase.
var mu sync.Mutex

// Tablebase is a handle to the loaded Syzygy files. It is a thin wrapper over
// Fathom's process-global state, so there is effectively one live instance; the
// bench loads it once and shares the pointer across all engines (like the book).
type Tablebase struct {
	max int // TB_LARGEST: the largest piece count the loaded files cover
}

// Open initializes Fathom against a directory (or os-pathsep-separated list of
// directories) of Syzygy .rtbw/.rtbz files. It returns an error if Fathom fails
// to initialize, or if the directory contains no usable tablebase files
// (TB_LARGEST == 0) — that way a wrong/empty path is a clear failure the caller
// can downgrade to "no tablebase", rather than a silent no-op.
func Open(path string) (*Tablebase, error) {
	mu.Lock()
	defer mu.Unlock()

	cpath := C.CString(path)
	defer C.free(unsafe.Pointer(cpath))

	if !bool(C.tb_init(cpath)) {
		return nil, errors.New("syzygy: tb_init failed for path " + path)
	}
	max := int(C.TB_LARGEST)
	if max == 0 {
		C.tb_free()
		return nil, errors.New("syzygy: no tablebase files found at " + path)
	}
	return &Tablebase{max: max}, nil
}

// Close frees the resources Fathom allocated. After Close the tablebase must not
// be probed. Safe to call once; the bench keeps the tablebase for the whole run.
func (tb *Tablebase) Close() {
	if tb == nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	C.tb_free()
}

// MaxPieces returns the largest total piece count the loaded files can probe
// (e.g. 5 for the 5-piece set, 6 or 7 for larger sets). The caller must skip the
// probe when a position has more pieces than this.
func (tb *Tablebase) MaxPieces() int {
	if tb == nil {
		return 0
	}
	return tb.max
}

// Position is the bitboard description of a position to probe. The eight piece
// bitboards use a1=0 .. h8=63 (the same LERF layout as internal/chess). White and
// Black are the per-color occupancies; the piece bitboards are color-agnostic
// (both sides' kings, queens, …). EP is the en-passant target square (0 if none —
// a1 is never an ep square, so 0 is unambiguous). Castling must be 0: Syzygy
// positions assume no castling rights, and Fathom returns a failure otherwise.
type Position struct {
	White, Black                          uint64
	Kings, Queens, Rooks, Bishops, Knights, Pawns uint64
	Rule50                                uint // 50-move halfmove clock
	Castling                              uint // must be 0
	EP                                    uint // en-passant square, 0 = none
	WhiteToMove                           bool
}

// Result is a successful root probe: the WDL value (side-to-move relative) plus a
// DTZ-optimal move (From/To squares 0..63, Promotes a Promote* code, EP true when
// the move is an en-passant capture). The move is guaranteed to preserve the WDL
// result under the 50-move rule.
type Result struct {
	WDL      int
	From, To int
	Promotes int
	EP       bool
}

// ProbeRoot probes the DTZ tables at the root for pos and returns the WDL value
// and a best (DTZ-optimal) move. The bool is false when the probe fails — the
// position has too many pieces, has castling rights, the files for that material
// are missing, the position is already mate/stalemate, OR the DTZ table is stored
// from the other side (Fathom's simple tb_probe_root gives up there rather than
// re-probing from the resulting positions). On a miss the caller falls back to a
// normal search, which converts ≤MaxPieces endings safely. Thread-safe
// (serialized). The position MUST be legal (the caller guards with pos.Legal());
// Fathom's capture-resolution assumes the side not to move is not in check.
func (tb *Tablebase) ProbeRoot(pos Position) (Result, bool) {
	if tb == nil {
		return Result{}, false
	}
	mu.Lock()
	defer mu.Unlock()

	res := C.tb_probe_root(
		C.uint64_t(pos.White), C.uint64_t(pos.Black), C.uint64_t(pos.Kings),
		C.uint64_t(pos.Queens), C.uint64_t(pos.Rooks), C.uint64_t(pos.Bishops),
		C.uint64_t(pos.Knights), C.uint64_t(pos.Pawns),
		C.unsigned(pos.Rule50), C.unsigned(pos.Castling), C.unsigned(pos.EP),
		C.bool(pos.WhiteToMove), nil,
	)
	if res == C.go_tb_failed() || res == C.go_tb_checkmate() || res == C.go_tb_stalemate() {
		return Result{}, false
	}
	return Result{
		WDL:      int(C.go_tb_get_wdl(res)),
		From:     int(C.go_tb_get_from(res)),
		To:       int(C.go_tb_get_to(res)),
		Promotes: int(C.go_tb_get_promotes(res)),
		EP:       C.go_tb_get_ep(res) != 0,
	}, true
}
