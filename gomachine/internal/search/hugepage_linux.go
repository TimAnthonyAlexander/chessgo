//go:build linux

package search

import (
	"syscall"
	"unsafe"
)

// madvHugepage is MADV_HUGEPAGE from Linux asm-generic/mman-common.h. The stdlib
// syscall package does not export the constant, and this codebase deliberately
// avoids a golang.org/x/sys dependency, so we spell it here.
const madvHugepage = 14

// adviseHugePages asks the kernel to back the [p, p+n) virtual range with
// transparent huge pages (2 MiB). It is advisory and byte-identical to search
// behavior — it changes only physical page backing, never the table contents or
// the node count — so it cuts TLB misses on the large, randomly-accessed
// transposition table without touching correctness.
//
// It bites only when THP is in `madvise` mode
// (/sys/kernel/mm/transparent_hugepage/enabled = [madvise], which is what our
// amd64 boxes run): in `always` mode the kernel already promotes the pages, and
// in `never` mode this is a no-op. Any error (unsupported arch, bad range) is
// ignored — the table works identically either way.
func adviseHugePages(p unsafe.Pointer, n uintptr) {
	if p == nil || n < 2<<20 { // below one huge page: nothing to promote
		return
	}
	_, _, _ = syscall.Syscall(syscall.SYS_MADVISE, uintptr(p), n, madvHugepage)
}
