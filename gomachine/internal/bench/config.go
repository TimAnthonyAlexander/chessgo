package bench

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/search"
)

// ParseParams applies a comma-separated spec like "lmr=off,nullr=3" on top of a
// base Params, returning the patched config. A patch under test is exactly this:
// `--old ""` (the default engine) vs `--new "lmr=off"` (the variant). Keys map to
// the wired search.Params flags; unknown keys are an error so a typo can't
// silently no-op a test.
//
//	tt=on|off        UseTT
//	nullmove=on|off  NullMove
//	nullr=<int>      NullMoveR (null-move base reduction)
//	lmr=on|off       LMR
//	checkext=on|off  CheckExtension
func ParseParams(base search.Params, spec string) (search.Params, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return base, nil
	}
	for _, tok := range strings.Split(spec, ",") {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		kv := strings.SplitN(tok, "=", 2)
		if len(kv) != 2 {
			return base, fmt.Errorf("bad spec token %q (want key=value)", tok)
		}
		key := strings.ToLower(strings.TrimSpace(kv[0]))
		val := strings.TrimSpace(kv[1])
		switch key {
		case "tt":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.UseTT = b
		case "nullmove", "null":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.NullMove = b
		case "nullr":
			n, err := strconv.Atoi(val)
			if err != nil {
				return base, fmt.Errorf("nullr: %q is not an int", val)
			}
			base.NullMoveR = n
		case "lmr":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.LMR = b
		case "checkext", "checkextension":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.CheckExtension = b
		case "see":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.SEE = b
		case "delta", "deltaprune":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.DeltaPrune = b
		case "asp", "aspiration":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.Aspiration = b
		case "rfp":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.RFP = b
		case "lmp":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.LMP = b
		case "mobility", "mob":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.Mobility = b
		case "pawns":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.Pawns = b
		case "kingsafety", "ks":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.KingSafety = b
		case "bishoppair", "bp":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.BishopPair = b
		case "eval":
			// convenience: enable/disable all knowledge eval terms at once
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.Mobility, base.Pawns, base.KingSafety, base.BishopPair = b, b, b, b
		default:
			return base, fmt.Errorf("unknown param %q", key)
		}
	}
	return base, nil
}

func parseBool(s string) (bool, error) {
	switch strings.ToLower(s) {
	case "on", "true", "1", "yes", "y":
		return true, nil
	case "off", "false", "0", "no", "n":
		return false, nil
	}
	return false, fmt.Errorf("%q is not on/off", s)
}

// DiffParams returns a short human description of how patch differs from base,
// for the report header (e.g. "lmr: on→off").
func DiffParams(base, patch search.Params) string {
	var diffs []string
	if base.UseTT != patch.UseTT {
		diffs = append(diffs, fmt.Sprintf("tt: %s→%s", onoff(base.UseTT), onoff(patch.UseTT)))
	}
	if base.NullMove != patch.NullMove {
		diffs = append(diffs, fmt.Sprintf("nullmove: %s→%s", onoff(base.NullMove), onoff(patch.NullMove)))
	}
	if base.NullMoveR != patch.NullMoveR {
		diffs = append(diffs, fmt.Sprintf("nullr: %d→%d", base.NullMoveR, patch.NullMoveR))
	}
	if base.LMR != patch.LMR {
		diffs = append(diffs, fmt.Sprintf("lmr: %s→%s", onoff(base.LMR), onoff(patch.LMR)))
	}
	if base.CheckExtension != patch.CheckExtension {
		diffs = append(diffs, fmt.Sprintf("checkext: %s→%s", onoff(base.CheckExtension), onoff(patch.CheckExtension)))
	}
	if base.SEE != patch.SEE {
		diffs = append(diffs, fmt.Sprintf("see: %s→%s", onoff(base.SEE), onoff(patch.SEE)))
	}
	if base.DeltaPrune != patch.DeltaPrune {
		diffs = append(diffs, fmt.Sprintf("delta: %s→%s", onoff(base.DeltaPrune), onoff(patch.DeltaPrune)))
	}
	if base.Aspiration != patch.Aspiration {
		diffs = append(diffs, fmt.Sprintf("asp: %s→%s", onoff(base.Aspiration), onoff(patch.Aspiration)))
	}
	if base.RFP != patch.RFP {
		diffs = append(diffs, fmt.Sprintf("rfp: %s→%s", onoff(base.RFP), onoff(patch.RFP)))
	}
	if base.LMP != patch.LMP {
		diffs = append(diffs, fmt.Sprintf("lmp: %s→%s", onoff(base.LMP), onoff(patch.LMP)))
	}
	if base.Mobility != patch.Mobility {
		diffs = append(diffs, fmt.Sprintf("mobility: %s→%s", onoff(base.Mobility), onoff(patch.Mobility)))
	}
	if base.Pawns != patch.Pawns {
		diffs = append(diffs, fmt.Sprintf("pawns: %s→%s", onoff(base.Pawns), onoff(patch.Pawns)))
	}
	if base.KingSafety != patch.KingSafety {
		diffs = append(diffs, fmt.Sprintf("kingsafety: %s→%s", onoff(base.KingSafety), onoff(patch.KingSafety)))
	}
	if base.BishopPair != patch.BishopPair {
		diffs = append(diffs, fmt.Sprintf("bishoppair: %s→%s", onoff(base.BishopPair), onoff(patch.BishopPair)))
	}
	if len(diffs) == 0 {
		return "(identical — sanity/noise run)"
	}
	return strings.Join(diffs, ", ")
}

func onoff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
