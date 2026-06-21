// Package gomachine (module root) exists only to embed the small runtime data
// files into the binary, so a bare `go install ...@latest` build is full
// strength from any working directory — no sidecar `data/` dir required.
//
// Only the two small, committed files are embedded:
//   - data/nnue/net.nnue (~386K) — the default-on NNUE evaluation network;
//     without it the engine silently falls back to the (weaker) HCE eval.
//   - data/book.bin (~594K) — the opening book.
//
// Syzygy tablebases are deliberately NOT embedded: they are multi-GB and CGo,
// and the engine is already inert-if-absent. Point SYZYGY_PATH (or -tb-path)
// at a download to enable them.
//
// A real file still wins over the embedded copy (NNUE_PATH / -book), so a
// freshly trained net or recompiled book can be swapped in without a rebuild.
package gomachine

import _ "embed"

// NNUENet is the GNN-format NNUE network compiled into the binary.
//
//go:embed data/nnue/net.nnue
var NNUENet []byte

// Book is the opening book compiled into the binary.
//
//go:embed data/book.bin
var Book []byte
