package nnuetrain

import (
	"bufio"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
	"github.com/timanthonyalexander/gomachine/internal/nnuedata"
)

// sample is one training position: its pre-extracted active features from both
// perspectives, plus the two side-to-move-relative targets the λ-schedule CE
// loss blends — the teacher eval (as a centipawn score) and the game result
// (as a win probability ∈ {0, 0.5, 1}).
//
// Both targets are folded into the side-to-move frame up front (the net is
// stm-relative), keeping the forward/backward perspective-agnostic:
//
//	stmScore    = (stm==White) ? whiteScore : −whiteScore
//	stmResultWP = (stm==White) ? whiteWP    : (1−whiteWP)
//
// where whiteWP ∈ {0,0.5,1} is the White-perspective WDL win-probability.
type sample struct {
	featsStm    []uint16 // features for pos.SideToMove()
	featsOpp    []uint16 // features for the opposite color
	stmScore    float64  // teacher eval, stm-relative centipawns
	stmResultWP float64  // game-result win-prob, stm-relative ∈ {0,0.5,1}
}

// LoadEPD reads WDL-labelled EPD positions from one or more comma-separated
// paths into training samples. Each line is FEN fields followed by either a
// `c9 "1-0"|"0-1"|"1/2-1/2";` operation or a trailing `[1.0]|[0.5]|[0.0]`.
// Unparseable lines are skipped and counted. The returned counts are total lines
// seen and lines skipped (across all files).
func LoadEPD(paths []string) (samples []sample, lines, skipped int, err error) {
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		l, s, e := loadOne(p, &samples)
		lines += l
		skipped += s
		if e != nil {
			return nil, lines, skipped, e
		}
	}
	return samples, lines, skipped, nil
}

func loadOne(path string, out *[]sample) (lines, skipped int, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		lines++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fen, result, ok := parseEPD(line)
		if !ok {
			skipped++
			continue
		}
		pos, perr := chess.ParseFEN(fen)
		if perr != nil {
			skipped++
			continue
		}
		stm := pos.SideToMove()
		wp := result
		if stm == chess.Black {
			wp = 1 - result
		}
		// EPD carries no teacher eval; use the result win-prob as the eval target
		// too (mapped back through the default scaling factor so p_eval==p_res).
		*out = append(*out, sample{
			featsStm:    nnue.AppendFeatures(nil, pos, stm),
			featsOpp:    nnue.AppendFeatures(nil, pos, stm.Opposite()),
			stmScore:    wpToScore(wp, DefaultScalingFactor),
			stmResultWP: wp,
		})
	}
	if err := sc.Err(); err != nil {
		return lines, skipped, fmt.Errorf("scan %s: %w", path, err)
	}
	return lines, skipped, nil
}

// parseEPD pulls the FEN and the White-perspective result out of one EPD line.
func parseEPD(s string) (fen string, result float64, ok bool) {
	res, ok := extractResult(s)
	if !ok {
		return "", 0, false
	}
	fields := strings.Fields(s)
	if len(fields) < 4 {
		return "", 0, false
	}
	// FEN is the first 4 fields, plus the halfmove/fullmove counters if present
	// and numeric (some EPDs omit them, some carry them before `c9`).
	n := 4
	if len(fields) >= 6 && isInt(fields[4]) && isInt(fields[5]) {
		n = 6
	}
	return strings.Join(fields[:n], " "), res, true
}

// extractResult reads the White-perspective game result from the label. Order
// matters: test the exact "1/2-1/2" / "[0.5]" forms before "1-0"/"0-1" so a draw
// isn't misread (a "1/2-1/2" line contains neither "1-0" nor "0-1").
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

// wpToScore maps a win-probability ∈ (0,1) back to a centipawn score under
// sigmoid(score/sf), i.e. score = sf·logit(wp). The win-prob is clamped off the
// {0,1} boundaries so logit stays finite (used only for EPD's eval target).
func wpToScore(wp, sf float64) float64 {
	const eps = 1e-3
	if wp < eps {
		wp = eps
	} else if wp > 1-eps {
		wp = 1 - eps
	}
	return sf * math.Log(wp/(1-wp))
}

// LoadFlat reads up to limit records (0 = all) from a .flat training file (the
// 32-byte nnuedata codec) into training samples. Each record is decoded to a FEN
// + White-relative score/result, the FEN is re-parsed for features, and the
// White-relative labels are flipped into the side-to-move frame the net targets.
//
// Returns the loaded samples and the total record count read (== len(samples)
// unless a record failed to decode/parse, which is counted in skipped).
func LoadFlat(path string, limit int) (samples []sample, read, skipped int, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	rd := nnuedata.NewReader(bufio.NewReaderSize(f, 1<<20))
	for {
		if limit > 0 && len(samples) >= limit {
			break
		}
		rec, e := rd.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return samples, read, skipped, fmt.Errorf("read %s: %w", path, e)
		}
		read++

		fen, whiteScore, result, de := nnuedata.Decode(rec)
		if de != nil {
			skipped++
			continue
		}
		pos, pe := chess.ParseFEN(fen)
		if pe != nil {
			skipped++
			continue
		}

		stm := pos.SideToMove()
		white := stm == chess.White

		// White-relative score → stm-relative.
		stmScore := float64(whiteScore)
		if !white {
			stmScore = -stmScore
		}
		// White-relative result byte {0,1,2} → White win-prob {0,0.5,1} → stm.
		whiteWP := float64(result) / 2.0
		stmResultWP := whiteWP
		if !white {
			stmResultWP = 1 - whiteWP
		}

		samples = append(samples, sample{
			featsStm:    nnue.AppendFeatures(nil, pos, stm),
			featsOpp:    nnue.AppendFeatures(nil, pos, stm.Opposite()),
			stmScore:    stmScore,
			stmResultWP: stmResultWP,
		})
	}
	return samples, read, skipped, nil
}
