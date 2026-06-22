//go:build arm64 && nnue_neon

package nnue

// PROOF-OF-CONCEPT NEON backend, compiled ONLY with `-tags nnue_neon`. It
// repoints the addCol kernel seam (see kernels.go) at the NEON assembly in
// kernels_neon_arm64.s. subCol and screluDot intentionally remain scalar (the
// SCReLU dot needs SMLAL, which has no Go arm64 mnemonic — see the .s comment).
//
// To exercise / benchmark this PoC:
//
//	go test -tags nnue_neon -run TestKernelsMatchScalar -v ./internal/nnue/
//	go test -tags nnue_neon -run x -bench AccumulatorApply ./internal/nnue/
//
// The default (no-tag) build never sees this file, so the shipping path stays
// pure-Go scalar and bit-exact as before.

//go:noescape
func addI16Neon(dst, src *int16, n int)

// addColNeon adds src into dst elementwise via NEON (8 int16 lanes/iter + scalar
// tail). Empty slices are a no-op (the asm's n==0 guards both loops).
func addColNeon(dst, src []int16) {
	if len(dst) == 0 {
		return
	}
	addI16Neon(&dst[0], &src[0], len(dst))
}

func init() {
	addCol = addColNeon
	kernelBackend = "neon-arm64(addCol)"
}
