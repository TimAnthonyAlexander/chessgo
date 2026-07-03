//go:build goexperiment.simd && amd64.v4

package nnue

import (
	"fmt"
	"testing"
)

var dotU8Sink int32

// BenchmarkDotU8I8Backends A/Bs the int8 L1 dot at realistic widths: the two-step
// archsimd maddubs (VPMADDUBSW+VPMADDWD) vs the single-instruction VPDPBUSD
// (AVX512-VNNI). Both are bit-exact on the [0,127] activation domain; this
// measures only the throughput gap. Run on coalla/prod (Zen 4, avx512_vnni):
//
//	GOAMD64=v4 GOEXPERIMENT=simd go1.26.4 test ./internal/nnue/ -run '^$' \
//	  -bench BenchmarkDotU8I8Backends -benchtime=200ms
func BenchmarkDotU8I8Backends(b *testing.B) {
	for _, n := range []int{512, 1024, 2048} {
		a := make([]uint8, n)
		w := make([]int8, n)
		for i := range a {
			a[i] = uint8(i % 128)      // [0,127], the quantU8 domain
			w[i] = int8((i*7)%255 - 127) // [-127,127]
		}
		b.Run(fmt.Sprintf("maddubs/n=%d", n), func(b *testing.B) {
			var s int32
			for i := 0; i < b.N; i++ {
				s += dotU8I8SIMD(a, w)
			}
			dotU8Sink = s
			b.SetBytes(int64(n))
		})
		b.Run(fmt.Sprintf("vnni/n=%d", n), func(b *testing.B) {
			var s int32
			for i := 0; i < b.N; i++ {
				s += dotU8I8VNNI(a, w)
			}
			dotU8Sink = s
			b.SetBytes(int64(n))
		})
	}
}
