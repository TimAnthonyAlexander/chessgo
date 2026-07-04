//go:build amd64

package nnue

import "unsafe"

// prefetchT0 issues a PREFETCHT0 for the cache line at p. Used to hide the memory
// latency of the scattered threat/base weight columns during the accumulator apply:
// prefetch the next feature's column while the current one is still being added.
// See prefetch_amd64.s.
//
//go:noescape
func prefetchT0(p unsafe.Pointer)
