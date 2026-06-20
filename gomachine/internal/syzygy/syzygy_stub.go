//go:build !cgo

// This stub is compiled when cgo is disabled (e.g. `make cross` portable
// artifacts built with CGO_ENABLED=0). It mirrors the real API in syzygy.go so
// the rest of the engine compiles unchanged, but tablebase support is inert:
// Open always reports unavailability, so callers downgrade to a plain search.
package syzygy

import "errors"

// WDL values (mirrors the cgo build's Fathom constants).
const (
	WDLLoss        = 0
	WDLBlessedLoss = 1
	WDLDraw        = 2
	WDLCursedWin   = 3
	WDLWin         = 4
)

// Promotion codes (mirrors the cgo build's Fathom constants).
const (
	PromoteNone   = 0
	PromoteQueen  = 1
	PromoteRook   = 2
	PromoteBishop = 3
	PromoteKnight = 4
)

// Tablebase is a no-op handle in cgo-less builds.
type Tablebase struct{}

// Open always fails: without cgo, Fathom isn't compiled in.
func Open(path string) (*Tablebase, error) {
	return nil, errors.New("syzygy: tablebase support requires a cgo build (CGO_ENABLED=1)")
}

// Close is a no-op.
func (tb *Tablebase) Close() {}

// MaxPieces reports 0 (no coverage) so callers never attempt a probe.
func (tb *Tablebase) MaxPieces() int { return 0 }

// Position mirrors the cgo build's input type.
type Position struct {
	White, Black                                  uint64
	Kings, Queens, Rooks, Bishops, Knights, Pawns uint64
	Rule50                                        uint
	Castling                                      uint
	EP                                            uint
	WhiteToMove                                   bool
}

// Result mirrors the cgo build's output type.
type Result struct {
	WDL      int
	From, To int
	Promotes int
	EP       bool
}

// ProbeRoot always misses in cgo-less builds.
func (tb *Tablebase) ProbeRoot(pos Position) (Result, bool) { return Result{}, false }
