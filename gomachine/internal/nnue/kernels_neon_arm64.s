//go:build arm64 && nnue_neon

#include "textflag.h"

// PROOF-OF-CONCEPT ARM64 NEON kernel for hot loop #1 (the accumulator add).
// Built ONLY under `-tags nnue_neon` so the default build is untouched and the
// pure-Go scalar path remains the shipping default. It is gated by the bit-exact
// test (TestKernelsMatchScalar with -tags nnue_neon) which asserts byte-for-byte
// equality with the scalar reference before this could ever be trusted in search.
//
// This covers ONLY addCol (int16 elementwise add). int16 add is associative, so
// any SIMD reduction is trivially bit-identical to scalar — the safest loop to
// vectorize first. subCol and the SCReLU dot stay scalar even under this tag
// (the dot needs widening multiply-accumulate, SMLAL, which Go's arm64 assembler
// lacks a mnemonic for and would require raw WORD encodings — out of PoC scope).
//
// VADD .H8 adds eight int16 lanes (a 128-bit V register) per iteration; a scalar
// tail handles the remainder when HL is not a multiple of 8 (the kernel test
// exercises odd widths 1,7,15,31,513 to prove the tail is correct).

// func addI16Neon(dst, src *int16, n int)
TEXT ·addI16Neon(SB), NOSPLIT, $0-24
	MOVD dst+0(FP), R0 // &dst[0]
	MOVD src+8(FP), R1 // &src[0]
	MOVD n+16(FP), R2  // n (element count)

loop8:
	CMP  $8, R2
	BLT  tail
	VLD1 (R0), [V0.H8]       // 8 dst int16
	VLD1 (R1), [V1.H8]       // 8 src int16
	VADD V1.H8, V0.H8, V0.H8 // dst += src, 8 lanes
	VST1 [V0.H8], (R0)
	ADD  $16, R0 // 8 * 2 bytes
	ADD  $16, R1
	SUB  $8, R2
	B    loop8

tail:
	CBZ  R2, done
tailloop:
	MOVH (R0), R3
	MOVH (R1), R4
	ADD  R4, R3
	MOVH R3, (R0)
	ADD  $2, R0
	ADD  $2, R1
	SUB  $1, R2
	CBNZ R2, tailloop

done:
	RET
