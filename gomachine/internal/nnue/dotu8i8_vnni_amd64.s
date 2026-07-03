//go:build amd64

#include "textflag.h"

// func dotU8I8VNNI(a []uint8, w []int8) int32
//
// AVX-512-VNNI int8 dot: Σ a[i]·w[i] as int32 via VPDPBUSD (one unsigned×signed
// byte multiply-accumulate-to-int32, no pairwise int16 saturation). Correct ONLY
// on CPUs advertising AVX512_VNNI; the caller gates on hasAVX512VNNI().
//
// Activations are u8 ∈ [0,int8QA=127], weights i8 ∈ [-127,127], so no maddubs
// pair sum can exceed 32258 < 32767 — the saturating archsimd path never actually
// saturates, so it already equals the exact int32 sum VPDPBUSD computes. Hence
// this kernel is BIT-IDENTICAL to dotU8I8Scalar on the operating domain
// (TestDotU8I8MatchScalar is the gate).
//
// PERFORMANCE — why 4 accumulators. VPDPBUSD FUSES the accumulate into the
// instruction, so `acc += dp(a,w)` chains acc through the op's full ~4-5c
// latency. A single accumulator is latency-bound and loses to the archsimd
// maddubs path (whose VPMADDUBSW+VPMADDWD sit OFF the acc critical path, leaving
// only a latency-1 VPADDD chain). Four independent accumulators (Z0..Z3),
// 256 bytes/iter, hide the latency so the loop runs throughput-bound — one fused
// op per 64 bytes beating maddubs' two.
//
// a = SI (ptr), n = CX (len); w = DI (ptr). Z4..Z11 are load temps.
TEXT ·dotU8I8VNNI(SB), NOSPLIT, $0-52
	MOVQ a_base+0(FP), SI
	MOVQ a_len+8(FP), CX
	MOVQ w_base+24(FP), DI

	VPXORQ Z0, Z0, Z0
	VPXORQ Z1, Z1, Z1
	VPXORQ Z2, Z2, Z2
	VPXORQ Z3, Z3, Z3
	XORQ   AX, AX // i = 0

	// Main loop: 256 bytes/iter into 4 independent accumulators.
	MOVQ CX, R11
	ANDQ $-256, R11 // R11 = n rounded down to a multiple of 256

loop256:
	CMPQ AX, R11
	JGE  combine
	VMOVDQU32 (SI)(AX*1), Z4
	VMOVDQU32 (DI)(AX*1), Z8
	VPDPBUSD  Z8, Z4, Z0
	VMOVDQU32 64(SI)(AX*1), Z5
	VMOVDQU32 64(DI)(AX*1), Z9
	VPDPBUSD  Z9, Z5, Z1
	VMOVDQU32 128(SI)(AX*1), Z6
	VMOVDQU32 128(DI)(AX*1), Z10
	VPDPBUSD  Z10, Z6, Z2
	VMOVDQU32 192(SI)(AX*1), Z7
	VMOVDQU32 192(DI)(AX*1), Z11
	VPDPBUSD  Z11, Z7, Z3
	ADDQ      $256, AX
	JMP       loop256

combine:
	VPADDD Z1, Z0, Z0
	VPADDD Z3, Z2, Z2
	VPADDD Z2, Z0, Z0 // Z0 = Σ of the four accumulators (16 int32 lanes)

	// Trailing 64-byte chunks (n mod 256), single accumulator into Z0.
	MOVQ CX, R11
	ANDQ $-64, R11

loop64:
	CMPQ AX, R11
	JGE  reduce
	VMOVDQU32 (SI)(AX*1), Z4
	VMOVDQU32 (DI)(AX*1), Z8
	VPDPBUSD  Z8, Z4, Z0
	ADDQ      $64, AX
	JMP       loop64

reduce: // horizontal sum of Z0's 16 int32 lanes → R8
	VEXTRACTI64X4 $1, Z0, Y1
	VPADDD        Y1, Y0, Y0
	VEXTRACTI128  $1, Y0, X1
	VPADDD        X1, X0, X0
	VPSHUFD       $0xEE, X0, X1
	VPADDD        X1, X0, X0
	VPSHUFD       $0x01, X0, X1
	VPADDD        X1, X0, X0
	VMOVD         X0, R8

tail: // remaining bytes [AX, CX): exact per-byte products (no-saturation domain)
	CMPQ AX, CX
	JGE  done
	MOVBLZX (SI)(AX*1), R9
	MOVBLSX (DI)(AX*1), R10
	IMULL   R10, R9
	ADDL    R9, R8
	INCQ    AX
	JMP     tail

done:
	MOVL R8, ret+48(FP)
	VZEROUPPER
	RET

// func cpuidLeaf7ECX() uint32 — CPUID.(EAX=7,ECX=0):ECX (AVX512_VNNI is bit 11).
TEXT ·cpuidLeaf7ECX(SB), NOSPLIT, $0-4
	MOVL $7, AX
	MOVL $0, CX
	CPUID
	MOVL CX, ret+0(FP)
	RET
