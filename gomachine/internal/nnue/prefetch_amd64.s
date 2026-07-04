#include "textflag.h"

// func prefetchT0(p unsafe.Pointer)
// A single PREFETCHT0 leaf — brings *p's cache line toward L1. No stack frame.
TEXT ·prefetchT0(SB), NOSPLIT, $0-8
	MOVQ p+0(FP), AX
	PREFETCHT0 (AX)
	RET
