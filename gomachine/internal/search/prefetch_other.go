//go:build !amd64

package search

import "unsafe"

// ttPrefetchT0 is a no-op on non-amd64 arches (arm64 could use PRFM later). It
// inlines away, so the prefetch hook costs nothing off the prod box.
func ttPrefetchT0(p unsafe.Pointer) {}
