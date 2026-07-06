//go:build amd64 && !nopext

#include "textflag.h"

// func pext(src, mask uint64) uint64
//
// Parallel bit extract (BMI2 PEXTQ): gather the bits of src selected by the set
// bits of mask, packed into the low bits of the result. Correct on any CPU
// advertising BMI2; the amd64 && !nopext build tag (not CPU detection) selects
// this backend, so it must only be built for targets known to have fast PEXT
// (Zen 3+ / modern Intel). Pre-Zen 3 AMD builds should use `-tags nopext`.
//
// Go asm operand order for the VEX-encoded 3-operand PEXTQ is Intel-reversed:
//   Intel:  PEXT dst, src, mask
//   Go asm: PEXTQ mask, src, dst
// so BX (mask), AX (src) -> AX (dst).
TEXT ·pext(SB), NOSPLIT, $0-24
	MOVQ  src+0(FP), AX
	MOVQ  mask+8(FP), BX
	PEXTQ BX, AX, AX
	MOVQ  AX, ret+16(FP)
	RET
