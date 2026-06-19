package tune

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/eval"
)

// LoadEPD reads quiet-labelled EPD positions (FEN + game-result label) into
// traced WDL samples — the universal Texel-tuning format, e.g.
//
//	rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - c9 "1/2-1/2";
//
// Supported labels: a `c9 "1-0" | "0-1" | "1/2-1/2"` operation, or a trailing
// `[1.0] | [0.5] | [0.0]`. Loaded positions carry no soft eval (HasSoft=false),
// so they tune pure-WDL; the --lambda blend needs an eval-bearing source. Result
// is White-perspective (1-0 → 1.0), matching the White-perspective trace.
func LoadEPD(path string) ([]Sample, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []Sample
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	lines, skipped := 0, 0
	for sc.Scan() {
		lines++
		t := strings.TrimSpace(sc.Text())
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		fen, result, ok := parseEPD(t)
		if !ok {
			skipped++
			continue
		}
		pos, err := chess.ParseFEN(fen)
		if err != nil {
			skipped++
			continue
		}
		out = append(out, Sample{Trace: eval.EvalTrace(pos), Result: result})
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if skipped > 0 {
		fmt.Fprintf(os.Stderr, "LoadEPD: skipped %d/%d unparseable lines\n", skipped, lines)
	}
	return out, nil
}

// parseEPD pulls the FEN and White-perspective result out of one EPD line.
func parseEPD(s string) (fen string, result float64, ok bool) {
	res, ok := extractResult(s)
	if !ok {
		return "", 0, false
	}
	fields := strings.Fields(s)
	if len(fields) < 4 {
		return "", 0, false
	}
	// FEN is the first 4 fields; include the halfmove/fullmove counters only if
	// present and numeric (some EPDs omit them, some carry them before `c9`).
	n := 4
	if len(fields) >= 6 && isInt(fields[4]) && isInt(fields[5]) {
		n = 6
	}
	return strings.Join(fields[:n], " "), res, true
}

func extractResult(s string) (float64, bool) {
	switch {
	case strings.Contains(s, "1/2-1/2"), strings.Contains(s, "[0.5]"), strings.Contains(s, "1/2"):
		return 0.5, true
	case strings.Contains(s, "1-0"), strings.Contains(s, "[1.0]"):
		return 1.0, true
	case strings.Contains(s, "0-1"), strings.Contains(s, "[0.0]"):
		return 0.0, true
	}
	return 0, false
}

func isInt(s string) bool {
	_, err := strconv.Atoi(s)
	return err == nil
}
