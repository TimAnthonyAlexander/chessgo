package bench

import (
	"fmt"
	"io"
	"math"
	"os"
	"strings"
	"time"
)

// ANSI helpers (no-ops when color is disabled).
const (
	cReset  = "\033[0m"
	cBold   = "\033[1m"
	cDim    = "\033[2m"
	cRed    = "\033[31m"
	cGreen  = "\033[32m"
	cYellow = "\033[33m"
	cBlue   = "\033[34m"
	cCyan   = "\033[36m"
	cGray   = "\033[90m"
	cBGreen = "\033[92m"
	cBRed   = "\033[91m"
)

// Reporter renders the live SPRT box and the final summary.
type Reporter struct {
	w          io.Writer
	color      bool
	cfg        Config
	linesDrawn int
	lastDraw   time.Time
}

// NewReporter builds a reporter for cfg, auto-detecting whether stdout is a TTY
// (color + in-place redraw) or a pipe (plain, periodic lines).
func NewReporter(cfg Config) *Reporter {
	return &Reporter{w: os.Stdout, color: isTTY(os.Stdout), cfg: cfg}
}

func isTTY(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && (st.Mode()&os.ModeCharDevice) != 0
}

func (r *Reporter) c(code, s string) string {
	if !r.color {
		return s
	}
	return code + s + cReset
}

// Header prints the one-time static run description.
func (r *Reporter) Header() {
	budget := fmt.Sprintf("%d nodes/move", r.cfg.Nodes)
	if r.cfg.Nodes == 0 {
		budget = fmt.Sprintf("%v/move", r.cfg.MoveTime)
	}
	fmt.Fprintln(r.w)
	fmt.Fprintln(r.w, r.c(cBold+cCyan, "  ♟  gomachine SPRT  ·  self-play strength test"))
	fmt.Fprintf(r.w, "  %s  %s  %s  %s\n",
		r.c(cBold, r.cfg.NewName),
		r.c(cGray, "vs"),
		r.c(cBold, r.cfg.OldName),
		r.c(cDim, "(new vs old)"))
	fmt.Fprintf(r.w, "  %s %s\n", r.c(cGray, "patch:"), DiffParams(r.cfg.OldParams, r.cfg.NewParams))
	fmt.Fprintf(r.w, "  %s %s   %s SPRT[%.0f, %.0f] α=%.2f β=%.2f   %s %d×TT %dMB\n",
		r.c(cGray, "budget:"), budget,
		r.c(cGray, "·"), r.cfg.Elo0, r.cfg.Elo1, r.cfg.Alpha, r.cfg.Beta,
		r.c(cGray, "·"), r.cfg.Concurrency, r.cfg.TTMB)
	fmt.Fprintln(r.w)
}

// Update redraws the live box in place (throttled). force=true bypasses the
// throttle (used for the final frame).
func (r *Reporter) Update(p Progress, force bool) {
	if !force && time.Since(r.lastDraw) < 80*time.Millisecond {
		return
	}
	r.lastDraw = time.Now()

	lines := r.box(p)
	if r.color && r.linesDrawn > 0 {
		fmt.Fprintf(r.w, "\033[%dA", r.linesDrawn) // cursor up
	}
	for _, ln := range lines {
		if r.color {
			fmt.Fprint(r.w, "\033[2K") // clear line
		}
		fmt.Fprintln(r.w, ln)
	}
	r.linesDrawn = len(lines)
	if !r.color && !force {
		// On a pipe, separate periodic snapshots so they don't merge visually.
		r.linesDrawn = 0
	}
}

// box returns the rendered lines (without trailing newlines).
func (r *Reporter) box(p Progress) []string {
	rate := 0.0
	if s := p.Elapsed.Seconds(); s > 0 {
		rate = float64(p.Games) / s
	}

	eloStr := "—"
	if !math.IsNaN(p.Err95) {
		col := cYellow
		if p.Elo-p.Err95 > 0 {
			col = cBGreen
		} else if p.Elo+p.Err95 < 0 {
			col = cBRed
		}
		eloStr = r.c(col, fmt.Sprintf("%+.1f ± %.1f", p.Elo, p.Err95))
	} else {
		eloStr = r.c(cDim, fmt.Sprintf("%+.1f", p.Elo))
	}

	llrCol := cYellow
	if p.LLR > 0 {
		llrCol = cGreen
	} else if p.LLR < 0 {
		llrCol = cRed
	}

	wdl := fmt.Sprintf("%s %s   %s %s   %s %s",
		r.c(cGreen, "W"), r.c(cBold, fmt.Sprint(p.WNew)),
		r.c(cRed, "L"), r.c(cBold, fmt.Sprint(p.WOld)),
		r.c(cGray, "D"), r.c(cBold, fmt.Sprint(p.Draws)))

	penta := fmt.Sprintf("%s  %s",
		r.c(cGray, "pentanomial [LL LDg DD WD WW]:"),
		r.c(cDim, fmt.Sprintf("%v", [5]int(p.Penta))))

	status := r.c(cYellow, "running…")
	switch p.Done {
	case AcceptH1:
		status = r.c(cBold+cBGreen, "✓ H1 — patch is stronger")
	case AcceptH0:
		status = r.c(cBold+cBRed, "✗ H0 — patch is not stronger")
	}

	var b []string
	b = append(b, fmt.Sprintf("  %s   %s   %s",
		r.c(cBold, fmt.Sprintf("%d pairs", p.Pairs)),
		r.c(cGray, fmt.Sprintf("%d games", p.Games)),
		r.c(cDim, fmt.Sprintf("%.0f g/s · %s", rate, fmtDur(p.Elapsed)))))
	b = append(b, "  "+wdl+"     "+r.c(cGray, "Elo ")+eloStr)
	b = append(b, "  "+r.llrBar(p)+"  "+r.c(llrCol, fmt.Sprintf("LLR %+.2f", p.LLR)))
	b = append(b, "  "+penta)
	b = append(b, "  "+status)
	return b
}

// llrBar draws the LLR position between the lower and upper Wald bounds.
func (r *Reporter) llrBar(p Progress) string {
	const width = 32
	frac := (p.LLR - p.Lower) / (p.Upper - p.Lower)
	frac = math.Max(0, math.Min(1, frac))
	pos := int(math.Round(frac * float64(width-1)))
	zero := int(math.Round(((0 - p.Lower) / (p.Upper - p.Lower)) * float64(width-1)))

	var sb strings.Builder
	for i := 0; i < width; i++ {
		switch {
		case i == pos:
			col := cYellow
			if p.LLR > 0 {
				col = cGreen
			} else if p.LLR < 0 {
				col = cRed
			}
			sb.WriteString(r.c(cBold+col, "●"))
		case i == zero:
			sb.WriteString(r.c(cGray, "┊"))
		case i < pos:
			sb.WriteString(r.c(cDim, "─"))
		default:
			sb.WriteString(r.c(cGray, "·"))
		}
	}
	return fmt.Sprintf("%s%s%s",
		r.c(cRed, fmt.Sprintf("%+.1f ", p.Lower)),
		sb.String(),
		r.c(cGreen, fmt.Sprintf(" %+.1f", p.Upper)))
}

// Final prints the verdict block after the live box.
func (r *Reporter) Final(s Summary) {
	r.Update(s.Progress, true)
	p := s.Progress
	fmt.Fprintln(r.w)

	var verdict, sub string
	switch p.Done {
	case AcceptH1:
		verdict = r.c(cBold+cBGreen, "  ✓  ACCEPT  — the patch is an improvement")
		sub = "Keep it. Re-baseline (copy new→old) before the next test."
	case AcceptH0:
		verdict = r.c(cBold+cBRed, "  ✗  REJECT   — the patch is not an improvement")
		sub = "Drop or rework it. The Elo gain (if any) is below the H1 threshold."
	default:
		verdict = r.c(cBold+cYellow, "  ◌  INCONCLUSIVE — hit the pair cap before deciding")
		sub = "Raise --maxpairs, or widen the [elo0, elo1] bounds, to converge."
	}
	fmt.Fprintln(r.w, verdict)
	fmt.Fprintf(r.w, "     %s Elo %s   over %s pairs   in %s\n",
		r.c(cGray, "→"),
		eloPlain(p),
		fmt.Sprint(p.Pairs), fmtDur(p.Elapsed))
	fmt.Fprintln(r.w, "     "+r.c(cDim, sub))
	fmt.Fprintln(r.w)
}

func eloPlain(p Progress) string {
	if math.IsNaN(p.Err95) {
		return fmt.Sprintf("%+.1f", p.Elo)
	}
	return fmt.Sprintf("%+.1f ± %.1f", p.Elo, p.Err95)
}

// GauntletReporter renders the live vs-Stockfish match.
type GauntletReporter struct {
	w          io.Writer
	color      bool
	linesDrawn int
	lastDraw   time.Time
	sfElo      int
	sfDesc     string
	ourDesc    string
	budget     string
}

// NewGauntletReporter builds a reporter for a vs-Stockfish run.
func NewGauntletReporter(sfElo int, sfDesc, ourDesc, budget string) *GauntletReporter {
	return &GauntletReporter{
		w: os.Stdout, color: isTTY(os.Stdout),
		sfElo: sfElo, sfDesc: sfDesc, ourDesc: ourDesc, budget: budget,
	}
}

func (r *GauntletReporter) c(code, s string) string {
	if !r.color {
		return s
	}
	return code + s + cReset
}

// Header prints the static run description.
func (r *GauntletReporter) Header() {
	fmt.Fprintln(r.w)
	fmt.Fprintln(r.w, r.c(cBold+cCyan, "  ♟  gomachine vs Stockfish  ·  absolute strength anchor"))
	fmt.Fprintf(r.w, "  %s  %s  %s\n",
		r.c(cBold, r.ourDesc), r.c(cGray, "vs"), r.c(cBold, r.sfDesc))
	fmt.Fprintf(r.w, "  %s %s\n", r.c(cGray, "budget:"), r.budget)
	fmt.Fprintln(r.w)
}

func (r *GauntletReporter) Update(p GauntletProgress, force bool) {
	if !force && time.Since(r.lastDraw) < 80*time.Millisecond {
		return
	}
	r.lastDraw = time.Now()

	scorePct := fmt.Sprintf("%.1f%%", p.Score*100)
	eloStr := r.c(cDim, "—")
	if !math.IsNaN(p.Err95) {
		col := cYellow
		if p.OurElo-p.Err95 > float64(r.sfElo) {
			col = cBGreen
		} else if p.OurElo+p.Err95 < float64(r.sfElo) {
			col = cBRed
		}
		eloStr = r.c(cBold+col, fmt.Sprintf("≈ %.0f ± %.0f", p.OurElo, p.Err95))
	}

	lines := []string{
		fmt.Sprintf("  %s   %s",
			r.c(cBold, fmt.Sprintf("%d games", p.Games)),
			r.c(cDim, fmt.Sprintf("%s · %s", fmtDur(p.Elapsed), gps(p.Games, p.Elapsed)))),
		fmt.Sprintf("  %s %s   %s %s   %s %s    %s %s",
			r.c(cGreen, "W"), r.c(cBold, fmt.Sprint(p.Wins)),
			r.c(cGray, "D"), r.c(cBold, fmt.Sprint(p.Draws)),
			r.c(cRed, "L"), r.c(cBold, fmt.Sprint(p.Losses)),
			r.c(cGray, "score"), r.c(cBold, scorePct)),
		fmt.Sprintf("  %s %s   %s",
			r.c(cGray, "our estimated Elo"), eloStr,
			r.c(cDim, fmt.Sprintf("(head-to-head %+.0f vs SF %d)", p.EloDiff, r.sfElo))),
	}
	if r.color && r.linesDrawn > 0 {
		fmt.Fprintf(r.w, "\033[%dA", r.linesDrawn)
	}
	for _, ln := range lines {
		if r.color {
			fmt.Fprint(r.w, "\033[2K")
		}
		fmt.Fprintln(r.w, ln)
	}
	r.linesDrawn = len(lines)
	if !r.color && !force {
		r.linesDrawn = 0
	}
}

// Final prints the closing estimate and the calibration caveat.
func (r *GauntletReporter) Final(s GauntletSummary) {
	r.Update(s.GauntletProgress, true)
	p := s.GauntletProgress
	fmt.Fprintln(r.w)
	est := r.c(cDim, "inconclusive (need a decisive result)")
	if !math.IsNaN(p.Err95) {
		est = r.c(cBold+cCyan, fmt.Sprintf("≈ %.0f ± %.0f Elo", p.OurElo, p.Err95))
	}
	fmt.Fprintf(r.w, "  %s  our strength %s\n", r.c(cBold, "→"), est)
	fmt.Fprintln(r.w, "     "+r.c(cDim, "Anchored to Stockfish's UCI_Elo scale (its own calibration, roughly"))
	fmt.Fprintln(r.w, "     "+r.c(cDim, "Lichess-like, not exact FIDE). Sweep a few --sf-elo values to triangulate."))
	fmt.Fprintln(r.w)
}

func gps(games int, d time.Duration) string {
	if d.Seconds() <= 0 {
		return "—"
	}
	return fmt.Sprintf("%.1f g/s", float64(games)/d.Seconds())
}

func fmtDur(d time.Duration) string {
	d = d.Round(time.Second)
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	m := int(d.Minutes())
	s := int(d.Seconds()) % 60
	return fmt.Sprintf("%dm%02ds", m, s)
}
