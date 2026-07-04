//go:build amd64

package search

import "unsafe"

// ttPrefetchT0 issues a PREFETCHT0 for the cache line at p (bring it into all
// cache levels). Used to hide the TT probe's memory latency: prefetch the child
// slot the moment the child key is known, so by the time the recursive node
// actually probes it the line is resident. See prefetch_amd64.s.
//
//go:noescape
func ttPrefetchT0(p unsafe.Pointer)
