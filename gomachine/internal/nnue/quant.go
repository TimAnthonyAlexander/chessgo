package nnue

// Phase B: integer quantization. The integer view of a Net computes the *exact
// rational* value of the quantized network — no float rounding until a single
// round-to-nearest at the descale — so it is the canonical "bullet quantized
// eval". The float view (Net.Eval) is the reference/comparison path and drifts
// from this by ≤1cp only because of float32 summation order.
//
// Forward (matches bullet's SCReLU quantization, QA/QB/Scale = 255/64/400):
//
//	A[i]  = B0i[i] + Σ_f W0i[f][i]        (int16 accumulator, = QA·float_acc[i])
//	c[i]  = clamp(A[i], 0, QA)            (int, [0,QA])
//	OUT   = Σ_i c[i]² · W1i[i]            (int64)
//	eval  = round( Scale·(B1i·QA + OUT) / (QA²·QB) )   centipawns, stm-relative
//
// The B1i·QA term lifts the output bias (scaled by QA·QB) onto the OUT scale
// (QA²·QB). With the bullet constants this is round((B1i·255 + OUT)/10404).

// quantizeFromFloat fills the integer view from the float view using the net's
// QA/QB/Scale. Lossy for arbitrary floats; used for GNN1 nets and test nets. The
// shipping path (bullet GNN2) never calls this — it loads ints verbatim.
func (n *Net) quantizeFromFloat() {
	if n.QA == 0 {
		n.QA, n.QB, n.Scale = bulletQA, bulletQB, bulletSCALE
	}
	if len(n.W0i) != len(n.W0) {
		n.W0i = make([]int16, len(n.W0))
		n.B0i = make([]int16, len(n.B0))
		n.W1i = make([]int16, len(n.W1))
		n.B1i = make([]int32, len(n.B1))
	}
	qa, qb := float32(n.QA), float32(n.QB)
	for i, v := range n.W0 {
		n.W0i[i] = roundClampI16(v * qa)
	}
	for i, v := range n.B0 {
		n.B0i[i] = roundClampI16(v * qa)
	}
	for i, v := range n.W1 {
		n.W1i[i] = roundClampI16(v * qb)
	}
	for b, v := range n.B1 {
		n.B1i[b] = int32(roundF32(v * qa * qb))
	}
	if n.CpScale != 0 {
		n.Scale = int32(roundF32(n.CpScale))
	}
}

// dequantizeToFloat fills the float view from the integer view (for the
// reference / comparison eval path). The float view is then an approximation of
// the exact-integer forward (≤1cp).
func (n *Net) dequantizeToFloat() {
	qa, qb := float32(n.QA), float32(n.QB)
	for i, v := range n.W0i {
		n.W0[i] = float32(v) / qa
	}
	for i, v := range n.B0i {
		n.B0[i] = float32(v) / qa
	}
	for i, v := range n.W1i {
		n.W1[i] = float32(v) / qb
	}
	for b, v := range n.B1i {
		n.B1[b] = float32(v) / (qa * qb)
	}
	n.CpScale = float32(n.Scale)
}

// descale converts bucket's raw integer output (B1i[bucket]·QA + OUT) into
// centipawns with round-to-nearest, matching the float path's math.Round.
func (n *Net) descale(out int64, bucket int) int {
	num := (int64(n.B1i[bucket])*int64(n.QA) + out) * int64(n.Scale)
	den := int64(n.QA) * int64(n.QA) * int64(n.QB)
	return int(roundDivI64(num, den))
}

// roundF32 rounds to nearest, ties away from zero (matches math.Round).
func roundF32(x float32) int32 {
	if x >= 0 {
		return int32(x + 0.5)
	}
	return int32(x - 0.5)
}

// roundClampI16 rounds to nearest and clamps into the int16 range.
func roundClampI16(x float32) int16 {
	r := roundF32(x)
	if r > 32767 {
		return 32767
	}
	if r < -32768 {
		return -32768
	}
	return int16(r)
}

// roundDivI64 is signed integer division rounding to nearest, ties away from
// zero — so it matches math.Round on the equivalent rational.
func roundDivI64(num, den int64) int64 {
	if den < 0 {
		num, den = -num, -den
	}
	if num >= 0 {
		return (num + den/2) / den
	}
	return -((-num + den/2) / den)
}
