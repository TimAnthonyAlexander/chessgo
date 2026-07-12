package bench

import (
	"io"
	"strconv"
	"strings"
)

// AnalyzeMultiPV searches the position (openFEN + moves) under budget and returns
// up to k root lines, index 0 = best (multipv 1), each sorted by the engine's
// multipv rank. Every line's Cp is side-to-move POV (mate mapped to ±(20000−dist)),
// same as AnalyzeBest. The engine MUST already have its "MultiPV" option set to at
// least k (pass it in StartUCI's options), or it will only report one line.
//
// It keeps, per multipv index, the LAST (deepest) info line reported, then returns
// the contiguous run of populated lines from index 0 (so a position with fewer than
// k legal moves yields fewer lines rather than blank entries).
func (e *UCIEngine) AnalyzeMultiPV(openFEN string, moves []string, b UCIBudget, k int) ([]Analysis, error) {
	pos := "position fen " + openFEN
	if len(moves) > 0 {
		pos += " moves " + strings.Join(moves, " ")
	}
	if err := e.send(pos); err != nil {
		return nil, err
	}
	if err := e.send(b.goLine()); err != nil {
		return nil, err
	}

	lines := make([]Analysis, k)
	seen := make([]bool, k)
	for e.out.Scan() {
		f := strings.Fields(e.out.Text())
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "info":
			mpv := 1
			var a Analysis
			hasScore := false
			for i := 0; i+1 < len(f); i++ {
				switch f[i] {
				case "multipv":
					if v, err := strconv.Atoi(f[i+1]); err == nil {
						mpv = v
					}
				case "score":
					if i+2 < len(f) {
						switch f[i+1] {
						case "cp":
							if v, err := strconv.Atoi(f[i+2]); err == nil {
								a.Cp, hasScore = v, true
							}
						case "mate":
							if v, err := strconv.Atoi(f[i+2]); err == nil {
								if v >= 0 {
									a.Cp = 20000 - v
								} else {
									a.Cp = -20000 - v
								}
								a.IsMate, hasScore = true, true
							}
						}
					}
				case "pv":
					a.PV = append([]string(nil), f[i+1:]...)
					if len(a.PV) > 0 {
						a.BestMove = a.PV[0]
					}
				}
			}
			if hasScore && a.BestMove != "" && mpv >= 1 && mpv <= k {
				lines[mpv-1] = a
				seen[mpv-1] = true
			}
		case "bestmove":
			out := make([]Analysis, 0, k)
			for i := 0; i < k; i++ {
				if !seen[i] {
					break
				}
				out = append(out, lines[i])
			}
			return out, nil
		}
	}
	if err := e.out.Err(); err != nil {
		return nil, err
	}
	return nil, io.EOF
}
