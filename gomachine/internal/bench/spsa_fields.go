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
	// Aspiration variance window (scaffold, AspVariance-gated). AspBaseDelta is a
	// small cp base (~7); AspVarScale the |prevScore|²·scale/2²⁰ numerator (~65).
	"aspbasedelta": {func(p *search.Params, v int) { p.AspBaseDelta = v }, func(p search.Params) int { return p.AspBaseDelta }, 2},
	"aspvarscale":  {func(p *search.Params, v int) { p.AspVarScale = v }, func(p search.Params) int { return p.AspVarScale }, 10},
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
	"aspbase":       "aspbasedelta",
	"aspvar":        "aspvarscale",
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
