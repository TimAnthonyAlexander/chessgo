//go:build !linux

package search

import "unsafe"

// adviseHugePages is a no-op off Linux (e.g. the macOS dev build, which has no
// MADV_HUGEPAGE). Prod is Linux/amd64, where the real implementation applies.
func adviseHugePages(p unsafe.Pointer, n uintptr) {}
