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
		case "histmalus", "histgravity":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.HistMalus = b
		case "improving":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.Improving = b
		case "lmrformula", "lmrf", "loglmr":
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.LMRFormula = b
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
		case "kingprox", "kprox", "kp":
			// EG-only king proximity to advanced passers (endgame term #1, SPRT).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.KingProx = b
		case "pawnrace", "prace", "race":
			// EG-only knight-aware unstoppable-passer / race term (endgame, SPRT).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.PawnRace = b
		case "scalefactor", "sf", "scale":
			// EG drawishness scale factor (Stockfish-classical): scales the eg term
			// toward draw in drawish material (endgame correctness term, SPRT).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.ScaleFactor = b
		case "tuned", "tunedeval":
			// the full Texel-tuned eval as a unit: tuned PSQT + tuned weights +
			// all knowledge terms (what we SPRT against the shipped base eval).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.TunedEval = b
			base.Mobility, base.Pawns, base.KingSafety, base.BishopPair = b, b, b, b
		case "book", "usebook":
			// consult the precomputed opening book before searching (the engine
			// must have a book loaded via --engine-book, else this is inert).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.UseBook = b
		case "tb", "tablebase", "usetablebase":
			// probe Syzygy endgame tablebases at the root (the engine must have a
			// tablebase loaded via --tb-path, else this is inert).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.UseTablebase = b
		case "tbsearch", "tbwdl", "wdl":
			// probe Syzygy WDL at internal search nodes (horizon extension to the
			// ≤MaxPieces boundary; engine must have a tablebase loaded via --tb-path).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.TBSearch = b
		case "nnue":
			// route static eval through the NNUE net (internal/nnue) instead of HCE;
			// inert (falls back to HCE) unless a net is loaded via NNUE_PATH or the
			// cwd-relative data/nnue/net.nnue. The Phase-3 go/no-go SPRT vs HCE.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.Nnue = b
		case "nnuefloat":
			// with NNUE on, use the float from-scratch eval instead of the int
			// incremental path — for the Phase-B int-vs-float quality A/B only.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.NnueFloat = b
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
	if base.HistMalus != patch.HistMalus {
		diffs = append(diffs, fmt.Sprintf("histmalus: %s→%s", onoff(base.HistMalus), onoff(patch.HistMalus)))
	}
	if base.Improving != patch.Improving {
		diffs = append(diffs, fmt.Sprintf("improving: %s→%s", onoff(base.Improving), onoff(patch.Improving)))
	}
	if base.LMRFormula != patch.LMRFormula {
		diffs = append(diffs, fmt.Sprintf("lmrformula: %s→%s", onoff(base.LMRFormula), onoff(patch.LMRFormula)))
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
	if base.KingProx != patch.KingProx {
		diffs = append(diffs, fmt.Sprintf("kingprox: %s→%s", onoff(base.KingProx), onoff(patch.KingProx)))
	}
	if base.PawnRace != patch.PawnRace {
		diffs = append(diffs, fmt.Sprintf("pawnrace: %s→%s", onoff(base.PawnRace), onoff(patch.PawnRace)))
	}
	if base.ScaleFactor != patch.ScaleFactor {
		diffs = append(diffs, fmt.Sprintf("scalefactor: %s→%s", onoff(base.ScaleFactor), onoff(patch.ScaleFactor)))
	}
	if base.TunedEval != patch.TunedEval {
		diffs = append(diffs, fmt.Sprintf("tuned: %s→%s", onoff(base.TunedEval), onoff(patch.TunedEval)))
	}
	if base.UseBook != patch.UseBook {
		diffs = append(diffs, fmt.Sprintf("book: %s→%s", onoff(base.UseBook), onoff(patch.UseBook)))
	}
	if base.UseTablebase != patch.UseTablebase {
		diffs = append(diffs, fmt.Sprintf("tb: %s→%s", onoff(base.UseTablebase), onoff(patch.UseTablebase)))
	}
	if base.TBSearch != patch.TBSearch {
		diffs = append(diffs, fmt.Sprintf("tbsearch: %s→%s", onoff(base.TBSearch), onoff(patch.TBSearch)))
	}
	if base.Nnue != patch.Nnue {
		diffs = append(diffs, fmt.Sprintf("nnue: %s→%s", onoff(base.Nnue), onoff(patch.Nnue)))
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
