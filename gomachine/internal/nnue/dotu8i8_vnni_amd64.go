//go:build amd64

package nnue

// AVX-512-VNNI int8 dot kernel (asm in dotu8i8_vnni_amd64.s). Declared for every
// amd64 build so the asm always links, but only INSTALLED as the dotU8I8 seam by
// the AVX-512 (GOAMD64=v4) SIMD backend's init, and only when the running CPU
// advertises AVX512_VNNI (GOAMD64=v4 mandates AVX-512F but NOT VNNI — a
// Skylake-SP v4 box would #UD on VPDPBUSD without this guard).

// dotU8I8VNNI computes Σ a[i]·w[i] as int32 via VPDPBUSD. Requires AVX512_VNNI.
func dotU8I8VNNI(a []uint8, w []int8) int32

// cpuidLeaf7ECX returns CPUID.(EAX=7,ECX=0):ECX.
func cpuidLeaf7ECX() uint32

// hasAVX512VNNI reports whether the CPU supports AVX512_VNNI (leaf 7 ECX bit 11).
func hasAVX512VNNI() bool { return cpuidLeaf7ECX()&(1<<11) != 0 }
