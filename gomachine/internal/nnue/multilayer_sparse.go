package nnue

// Sparse int8 L1 for MultiNet's tail — the Stockfish / Stormphrax "find_nnz"
// pattern (SF src/nnue/layers/affine_transform_sparse_input.h; SP
// src/eval/nnue/arch/multilayer.h propagateL1). The u8 activation aq (length 2H)
// is IDENTICAL across every L1 output row, so its nonzero 4-byte groups are
// extracted ONCE per node and only those are dotted against each row's weights —
// turning D2 dense length-2H dots into D2 dots over just the nonzero dwords.
//
// Bit-exact with the dense dotU8I8 path: a skipped (all-zero) dword would
// contribute satI16(0)+satI16(0)=0, so the result is identical. It is therefore a
// pure speed lever, gated on int8Sparse and validated by TestSparseMatchesDense —
// NOT an SPRT-for-correctness. This scalar reference is the bit-exact target the
// SIMD/VNNI (scrambled-layout dpbusd) backend must match.
//
// Granularity is the 4-byte dword (matching VPDPBUSD's u8×4·i8×4 unit): a dword is
// "nonzero" if ANY of its 4 bytes is nonzero (a false positive costs one wasted
// dot, never a false negative). The pairwise int16 saturation inside each dword —
// (b,b+1) and (b+2,b+3) — reproduces dotU8I8Scalar exactly, because 2H is a
// multiple of 4 so dword boundaries align with dotU8I8's adjacent-pair boundaries
// (and 2H is even, so there is no odd tail element).

// nnzDwords writes the dword indices (in 4-byte units) of aq's nonzero groups into
// idx and returns the count. len(aq) must be a multiple of 4; len(idx) ≥ len(aq)/4.
func nnzDwords(aq []uint8, idx []uint16) int {
	c := 0
	for d, b := 0, 0; b < len(aq); d, b = d+1, b+4 {
		if aq[b]|aq[b+1]|aq[b+2]|aq[b+3] != 0 {
			idx[c] = uint16(d)
			c++
		}
	}
	return c
}

// satI16 clamps to the int16 range, modeling VPMADDUBSW's per-pair saturation
// (identical to the clamp inside dotU8I8Scalar).
func satI16(p int32) int32 {
	if p > 32767 {
		return 32767
	} else if p < -32768 {
		return -32768
	}
	return p
}

// dotU8I8SparseScalar returns the same value as dotU8I8Scalar(aq, w), but visits
// only the nonzero dwords listed in idx[:cnt] (each a 4-byte group index).
func dotU8I8SparseScalar(aq []uint8, w []int8, idx []uint16, cnt int) int32 {
	var acc int32
	for j := 0; j < cnt; j++ {
		b := int(idx[j]) * 4
		p0 := int32(aq[b])*int32(w[b]) + int32(aq[b+1])*int32(w[b+1])
		p1 := int32(aq[b+2])*int32(w[b+2]) + int32(aq[b+3])*int32(w[b+3])
		acc += satI16(p0) + satI16(p1)
	}
	return acc
}

// tailEvalInt8Sparse is tailEvalInt8 with the L1 matmul restricted to aq's nonzero
// dwords (computed once, reused across all D2 output rows). L2/L3/output are the
// shared l2l3out tail.
func (n *MultiNet) tailEvalInt8Sparse(aq []uint8, bk int, l2, l3 []float32, idx []uint16) int {
	in1 := 2 * n.H
	cnt := nnzDwords(aq, idx)

	w8 := n.L1W8[bk*n.D2*in1 : (bk+1)*n.D2*in1]
	b2 := n.L2B[bk*n.D2 : (bk+1)*n.D2]
	inv := n.L1Inv[bk*n.D2 : (bk+1)*n.D2]
	for o := 0; o < n.D2; o++ {
		row := w8[o*in1 : o*in1+in1]
		dot := dotU8I8SparseScalar(aq, row, idx, cnt)
		l2[o] = creluF(float32(dot)*inv[o] + b2[o])
	}

	return n.l2l3out(bk, l2, l3)
}

// SetInt8Sparse toggles the sparse-NNZ L1 path (requires int8L1). Bit-exact with
// the dense int8 path; a movetime speed lever, default off.
func (n *MultiNet) SetInt8Sparse(v bool) { n.int8Sparse = v }
