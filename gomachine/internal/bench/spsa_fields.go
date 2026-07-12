package bench

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/search"
)

// spsaField binds a tunable integer search.Params field to get/set closures and a
// sensible default per-param perturbation scale (CEnd, in the field's own units).
// CEnd ≥ 1 always, so the integer rounding of θ ± CEnd·δ actually flips the value.
type spsaField struct {
	apply   func(*search.Params, int)
	get     func(search.Params) int
	defCEnd float64
}

// spsaFields is the set of tunable integer margins (the already-promoted ones the
// task targets). Keyed by canonical lowercase name; aliases resolve via spsaAliases.
var spsaFields = map[string]spsaField{
	"singularmargin":   {func(p *search.Params, v int) { p.SingularMargin = v }, func(p search.Params) int { return p.SingularMargin }, 1},
	"singularmindepth": {func(p *search.Params, v int) { p.SingularMinDepth = v }, func(p search.Params) int { return p.SingularMinDepth }, 1},
	"seequietmargin":   {func(p *search.Params, v int) { p.SEEQuietMargin = v }, func(p search.Params) int { return p.SEEQuietMargin }, 20},
	"seequietmaxdepth": {func(p *search.Params, v int) { p.SEEQuietMaxDepth = v }, func(p search.Params) int { return p.SEEQuietMaxDepth }, 1},
	"captseemargin":    {func(p *search.Params, v int) { p.CaptSEEMargin = v }, func(p search.Params) int { return p.CaptSEEMargin }, 8},
	"captseemaxdepth":  {func(p *search.Params, v int) { p.CaptSEEMaxDepth = v }, func(p search.Params) int { return p.CaptSEEMaxDepth }, 1},
	"deltamargin":      {func(p *search.Params, v int) { p.DeltaMargin = v }, func(p search.Params) int { return p.DeltaMargin }, 25},
	"nullmover":        {func(p *search.Params, v int) { p.NullMoveR = v }, func(p search.Params) int { return p.NullMoveR }, 1},
	"doubleextmargin":  {func(p *search.Params, v int) { p.DoubleExtMargin = v }, func(p search.Params) int { return p.DoubleExtMargin }, 4},
	// LMR / history / RFP (docs/open_tasks/spsa-margins.md: "the untapped leverage is
	// LMR/history"). LMR base/div are ×10000 ints; CEnd in those units (≈0.02 base,
	// ≈0.05 div per step). The rest are direct integer margins.
	"lmrbasex10k":    {func(p *search.Params, v int) { p.LMRBaseX10k = v }, func(p search.Params) int { return p.LMRBaseX10k }, 200},
	"lmrdivx10k":     {func(p *search.Params, v int) { p.LMRDivX10k = v }, func(p search.Params) int { return p.LMRDivX10k }, 500},
	"lmrhistdiv":     {func(p *search.Params, v int) { p.LMRHistDiv = v }, func(p search.Params) int { return p.LMRHistDiv }, 256},
	"rfpmargin":      {func(p *search.Params, v int) { p.RFPMargin = v }, func(p search.Params) int { return p.RFPMargin }, 8},
	"histbonusscale": {func(p *search.Params, v int) { p.HistBonusScale = v }, func(p search.Params) int { return p.HistBonusScale }, 4},
	"histbonusmax":   {func(p *search.Params, v int) { p.HistBonusMax = v }, func(p search.Params) int { return p.HistBonusMax }, 128},
	"histmalusscale": {func(p *search.Params, v int) { p.HistMalusScale = v }, func(p search.Params) int { return p.HistMalusScale }, 4},
	"histmalusmax":   {func(p *search.Params, v int) { p.HistMalusMax = v }, func(p search.Params) int { return p.HistMalusMax }, 128},
	// Aspiration variance window (scaffold, AspVariance-gated). AspBaseDelta is a
	// small cp base (~7); AspVarScale the |prevScore|²·scale/2²⁰ numerator (~65).
	"aspbasedelta": {func(p *search.Params, v int) { p.AspBaseDelta = v }, func(p search.Params) int { return p.AspBaseDelta }, 2},
	"aspvarscale":  {func(p *search.Params, v int) { p.AspVarScale = v }, func(p search.Params) int { return p.AspVarScale }, 10},
	// Shallow-pruner depth caps + shape constants (promoted from consts so the
	// highest-Elo pruners are SPSA-reachable — docs/open_tasks/spsa-margins.md).
	// Suggested spec bounds: rfpmaxdepth [4..12], futilitymaxdepth [2..10],
	// lmpmaxdepth [4..12], histprunemaxdepth [2..10], histprunemargin [-3000..-200],
	// lmpbase [1..6], lmpmultx10 [5..20], nmpdepthdiv [2..8], nmpevalcap [1..6],
	// lmrminmoves [2..8].
	"rfpmaxdepth":       {func(p *search.Params, v int) { p.RFPMaxDepth = v }, func(p search.Params) int { return p.RFPMaxDepth }, 1},
	"futilitymaxdepth":  {func(p *search.Params, v int) { p.FutilityMaxDepth = v }, func(p search.Params) int { return p.FutilityMaxDepth }, 1},
	"lmpmaxdepth":       {func(p *search.Params, v int) { p.LMPMaxDepth = v }, func(p search.Params) int { return p.LMPMaxDepth }, 1},
	"histprunemaxdepth": {func(p *search.Params, v int) { p.HistPruneMaxDepth = v }, func(p search.Params) int { return p.HistPruneMaxDepth }, 1},
	"histprunemargin":   {func(p *search.Params, v int) { p.HistPruneMargin = v }, func(p search.Params) int { return p.HistPruneMargin }, 200},
	"lmpbase":           {func(p *search.Params, v int) { p.LMPBase = v }, func(p search.Params) int { return p.LMPBase }, 1},
	"lmpmultx10":        {func(p *search.Params, v int) { p.LMPMultX10 = v }, func(p search.Params) int { return p.LMPMultX10 }, 2},
	"nmpdepthdiv":       {func(p *search.Params, v int) { p.NMPDepthDiv = v }, func(p search.Params) int { return p.NMPDepthDiv }, 1},
	"nmpevalcap":        {func(p *search.Params, v int) { p.NMPEvalCap = v }, func(p search.Params) int { return p.NMPEvalCap }, 1},
	"lmrminmoves":       {func(p *search.Params, v int) { p.LMRMinMoves = v }, func(p search.Params) int { return p.LMRMinMoves }, 1},
	// History gravity clamp/divisor (Stormphrax uses 16384 vs our 8192) and the
	// corrhist pawn/non-pawn blend weights (Stormphrax ~1:1 vs our 2:1).
	"maxhistory": {func(p *search.Params, v int) { p.MaxHistory = v }, func(p search.Params) int { return p.MaxHistory }, 512},
	"corrwpawn":  {func(p *search.Params, v int) { p.CorrWPawn = v }, func(p search.Params) int { return p.CorrWPawn }, 1},
	"corrwnp":    {func(p *search.Params, v int) { p.CorrWNP = v }, func(p search.Params) int { return p.CorrWNP }, 1},
	// Aspiration widening growth numerator/denominator (AspWidenGrow-gated bool is
	// set via config, not SPSA).
	"aspwidennum": {func(p *search.Params, v int) { p.AspWidenNum = v }, func(p search.Params) int { return p.AspWidenNum }, 1},
	"aspwidenden": {func(p *search.Params, v int) { p.AspWidenDen = v }, func(p search.Params) int { return p.AspWidenDen }, 1},
	// PCM parent counter-move fail-low bonus (ParentContHistBonus-gated). The gate:
	// weight = depth·pcmdepthscale − pcmbaseoffset (+pcmmarginbonus if severe), clamped
	// (0,1024]. Suggested bounds: pcmdepthscale [0..300], pcmbaseoffset [0..1500],
	// pcmevalmargin [0..300], pcmmarginbonus [0..600].
	"pcmdepthscale":  {func(p *search.Params, v int) { p.PCMDepthScale = v }, func(p search.Params) int { return p.PCMDepthScale }, 16},
	"pcmbaseoffset":  {func(p *search.Params, v int) { p.PCMBaseOffset = v }, func(p search.Params) int { return p.PCMBaseOffset }, 64},
	"pcmevalmargin":  {func(p *search.Params, v int) { p.PCMEvalMargin = v }, func(p search.Params) int { return p.PCMEvalMargin }, 25},
	"pcmmarginbonus": {func(p *search.Params, v int) { p.PCMMarginBonus = v }, func(p search.Params) int { return p.PCMMarginBonus }, 32},
	// PCM malus (ParentContHistMalus-gated). Suggested bounds: pcmmalusscale [0..600],
	// pcmmalusmaxmoves [1..6] (1 = first-move-only = SF's dominant site 2).
	"pcmmalusscale":    {func(p *search.Params, v int) { p.PCMMalusScale = v }, func(p search.Params) int { return p.PCMMalusScale }, 32},
	"pcmmalusmaxmoves": {func(p *search.Params, v int) { p.PCMMalusMaxMoves = v }, func(p search.Params) int { return p.PCMMalusMaxMoves }, 1},
}

// spsaAliases maps the short spec spellings (shared with bench.ParseParams) to the
// canonical field name.
var spsaAliases = map[string]string{
	"smargin":       "singularmargin",
	"singulardepth": "singularmindepth",
	"sdepth":        "singularmindepth",
	"sqm":           "seequietmargin",
	"sqd":           "seequietmaxdepth",
	"csm":           "captseemargin",
	"csd":           "captseemaxdepth",
	"dm":            "deltamargin",
	"nullr":         "nullmover",
	"dextm":         "doubleextmargin",
	"lmrbase":       "lmrbasex10k",
	"lmrdiv":        "lmrdivx10k",
	"lmrhd":         "lmrhistdiv",
	"rfpm":          "rfpmargin",
	"histscale":     "histbonusscale",
	"histmax":       "histbonusmax",
	"histmscale":    "histmalusscale",
	"histmmax":      "histmalusmax",
	"aspbase":       "aspbasedelta",
	"aspvar":        "aspvarscale",
	"rfpmd":         "rfpmaxdepth",
	"futmd":         "futilitymaxdepth",
	"lmpmd":         "lmpmaxdepth",
	"hpmd":          "histprunemaxdepth",
	"hpm":           "histprunemargin",
	"lmrmin":        "lmrminmoves",
	"maxhist":       "maxhistory",
	"pcmdepth":      "pcmdepthscale",
	"pcmoffset":     "pcmbaseoffset",
	"pcmmargin":     "pcmevalmargin",
	"pcmmbonus":     "pcmmarginbonus",
	"pcmmscale":     "pcmmalusscale",
	"pcmmmax":       "pcmmalusmaxmoves",
}

func canonSPSAName(name string) (string, bool) {
	n := strings.ToLower(strings.TrimSpace(name))
	if _, ok := spsaFields[n]; ok {
		return n, true
	}
	if c, ok := spsaAliases[n]; ok {
		return c, true
	}
	return n, false
}

// DefaultSPSASet returns the task's default tuning set, with each param's Initial
// seeded from the given base config and CEnd from the field default.
//
//	SingularMargin  [1..6]
//	SEEQuietMargin  [50..300]
//	CaptSEEMargin   [10..120]
//	NullMoveR       [1..4]
func DefaultSPSASet(base search.Params) []SPSAParam {
	spec := []struct {
		name     string
		min, max int
	}{
		{"singularmargin", 1, 6},
		{"seequietmargin", 50, 300},
		{"captseemargin", 10, 120},
		{"nullmover", 1, 4},
	}
	out := make([]SPSAParam, 0, len(spec))
	for _, s := range spec {
		f := spsaFields[s.name]
		out = append(out, SPSAParam{
			Name: s.name, Min: s.min, Max: s.max,
			Initial: clampInt(f.get(base), s.min, s.max), CEnd: f.defCEnd,
		})
	}
	return out
}

// ParseSPSASpec parses a comma-separated tuning spec into SPSAParams. Each token is
//
//	name:min:max[:initial[:cend]]
//
// initial defaults to the base config's current value; cend to the field default.
// Unknown field names are an error (a typo must not silently no-op).
func ParseSPSASpec(spec string, base search.Params) ([]SPSAParam, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return DefaultSPSASet(base), nil
	}
	var out []SPSAParam
	for _, tok := range strings.Split(spec, ",") {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		parts := strings.Split(tok, ":")
		if len(parts) < 3 {
			return nil, fmt.Errorf("bad param %q (want name:min:max[:initial[:cend]])", tok)
		}
		name, ok := canonSPSAName(parts[0])
		if !ok {
			return nil, fmt.Errorf("unknown tunable param %q", parts[0])
		}
		f := spsaFields[name]
		min, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil {
			return nil, fmt.Errorf("%s: min %q is not an int", name, parts[1])
		}
		max, err := strconv.Atoi(strings.TrimSpace(parts[2]))
		if err != nil {
			return nil, fmt.Errorf("%s: max %q is not an int", name, parts[2])
		}
		if min >= max {
			return nil, fmt.Errorf("%s: min %d must be < max %d", name, min, max)
		}
		initial := clampInt(f.get(base), min, max)
		if len(parts) >= 4 && strings.TrimSpace(parts[3]) != "" {
			initial, err = strconv.Atoi(strings.TrimSpace(parts[3]))
			if err != nil {
				return nil, fmt.Errorf("%s: initial %q is not an int", name, parts[3])
			}
		}
		cEnd := f.defCEnd
		if len(parts) >= 5 && strings.TrimSpace(parts[4]) != "" {
			cEnd, err = strconv.ParseFloat(strings.TrimSpace(parts[4]), 64)
			if err != nil {
				return nil, fmt.Errorf("%s: cend %q is not a number", name, parts[4])
			}
		}
		if cEnd < 1 {
			cEnd = 1 // integer params need a ≥1 perturbation to flip on rounding
		}
		out = append(out, SPSAParam{Name: name, Min: min, Max: max, Initial: clampInt(initial, min, max), CEnd: cEnd})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no params parsed from %q", spec)
	}
	return out, nil
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
