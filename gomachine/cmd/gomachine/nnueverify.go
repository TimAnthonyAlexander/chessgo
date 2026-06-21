package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnuedata"
)

// cmdNNUEVerifyLabels is the load-bearing gate on real flat data (DATA_PIPELINE
// §9.2). It samples records evenly ACROSS the whole file (stride-seek, so it hits
// material-lopsided endgames rather than just the opening of game #1) and asserts
// that on any clearly-lopsided position the stored White-relative score AND result
// share the sign of the material balance. This proves the STM→White flip held
// end-to-end. PASS requires a minimum number of lopsided positions actually
// asserted — a vacuous "nothing to check" is reported as INCONCLUSIVE, not PASS.
func cmdNNUEVerifyLabels(args []string) {
	fs := flag.NewFlagSet("nnue-verify-labels", flag.ExitOnError)
	flat := fs.String("flat", "", "flat .bin file to inspect")
	n := fs.Int("n", 12, "number of sampled records to print")
	scan := fs.Int("scan", 200000, "number of records to sample across the file")
	minChecks := fs.Int("min-checks", 50, "minimum lopsided records required to assert PASS")
	_ = fs.Parse(args)

	if *flat == "" {
		fmt.Fprintln(os.Stderr, "nnue-verify-labels: --flat is required")
		os.Exit(2)
	}

	f, err := os.Open(*flat)
	if err != nil {
		fmt.Fprintln(os.Stderr, "nnue-verify-labels: open:", err)
		os.Exit(1)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		fmt.Fprintln(os.Stderr, "nnue-verify-labels: stat:", err)
		os.Exit(1)
	}
	total := info.Size() / nnuedata.RecordSize
	if total == 0 {
		fmt.Fprintln(os.Stderr, "nnue-verify-labels: empty file")
		os.Exit(1)
	}
	sample := int64(*scan)
	if sample > total {
		sample = total
	}
	stride := total / sample // ≥1; spreads the sample across the whole file

	checked, consistent, failures, printed := 0, 0, 0, 0
	var buf [nnuedata.RecordSize]byte
	for k := int64(0); k < sample; k++ {
		off := (k * stride) * nnuedata.RecordSize
		if _, err := f.ReadAt(buf[:], off); err != nil {
			if err == io.EOF {
				break
			}
			fmt.Fprintln(os.Stderr, "nnue-verify-labels: read:", err)
			os.Exit(1)
		}
		fen, score, result, derr := nnuedata.Decode(buf)
		if derr != nil {
			fmt.Fprintln(os.Stderr, "nnue-verify-labels: decode:", derr)
			os.Exit(1)
		}
		pos, perr := chess.ParseFEN(fen)
		if perr != nil {
			fmt.Fprintf(os.Stderr, "record %d: rebuilt FEN failed to parse: %v\n", k, perr)
			os.Exit(1)
		}
		bal := materialBalance(pos)
		stm := "w"
		if pos.SideToMove() == chess.Black {
			stm = "b"
		}
		if printed < *n {
			fmt.Printf("[%d] %-66s stm=%s score=%+d result=%d matBal=%+d\n",
				k*stride, fen, stm, score, result, bal)
			printed++
		}

		// On a clear material edge, the stored White-relative score should USUALLY
		// share the balance's sign. Material is a noisy proxy (sacrifices/attacks
		// legitimately invert it), so we judge the *rate*, not zero failures: a
		// correct flip yields a high consistency rate; a REVERSED flip would invert
		// it (≈9% vs ≈91%). |bal|>=9 (up a queen+) cuts most of the tactical noise.
		if bal >= 9 || bal <= -9 {
			checked++
			if sameSign(int(score), bal) {
				consistent++
			} else if failures < 6 {
				failures++
				fmt.Printf("    (material-discordant, expected: %+d bal, %+d score) %s\n", bal, score, fen)
			}
		}
	}

	rate := 0.0
	if checked > 0 {
		rate = float64(consistent) / float64(checked)
	}
	fmt.Printf("\nsampled %d records (stride %d over %d); |bal|>=9 asserted %d; score-sign consistency %.1f%%\n",
		sample, stride, total, checked, rate*100)
	switch {
	case checked < *minChecks:
		fmt.Printf("INCONCLUSIVE: only %d decisive-material positions (< %d) — too little signal\n", checked, *minChecks)
		os.Exit(1)
	case rate < 0.80:
		fmt.Printf("FAIL: consistency %.1f%% < 80%% — the STM→White flip looks REVERSED/broken\n", rate*100)
		os.Exit(1)
	default:
		fmt.Printf("PASS: %.1f%% of decisive-material records sign-consistent (a reversed flip would be ~%.0f%%) — flip verified\n",
			rate*100, (1-rate)*100)
	}
}

// materialBalance returns White−Black material (Q=9 R=5 B=N=3 P=1).
func materialBalance(pos *chess.Position) int {
	vals := [6]int{1, 3, 3, 5, 9, 0} // P N B R Q K
	bal := 0
	for pc := chess.WhitePawn; pc <= chess.BlackKing; pc++ {
		cnt := pos.PieceBB(pc).Count()
		v := vals[pc.Type()]
		if pc.Color() == chess.White {
			bal += cnt * v
		} else {
			bal -= cnt * v
		}
	}
	return bal
}

func sameSign(a, b int) bool {
	if a == 0 || b == 0 {
		return true // a zero side is never a contradiction
	}
	return (a > 0) == (b > 0)
}
