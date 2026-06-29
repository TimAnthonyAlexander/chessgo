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
		case "singularmargin", "smargin":
			n, err := strconv.Atoi(val)
			if err != nil {
				return base, fmt.Errorf("singularmargin: %q is not an int", val)
			}
			base.SingularMargin = n
		case "singulardepth", "sdepth":
			n, err := strconv.Atoi(val)
			if err != nil {
				return base, fmt.Errorf("singulardepth: %q is not an int", val)
			}
			base.SingularMinDepth = n
		case "doubleextmargin", "dextm":
			n, err := strconv.Atoi(val)
			if err != nil {
				return base, fmt.Errorf("doubleextmargin: %q is not an int", val)
			}
			base.DoubleExtMargin = n
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
		case "tteval", "ttstatic":
			// reuse the TT-cached static eval instead of recomputing it on TT hits
			// that don't cut off — a movetime speed feature (eval is deterministic,
			// so it's behavior-preserving at fixed nodes). SPRT at --movetime.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.TTEval = b
		case "corrhist", "ch":
			// correction history: learn the per-pattern (pawn / per-color non-pawn)
			// static-eval-vs-search-result bias within a game and correct the static
			// eval by it. Sharpens every eval-gated decision; SPRT at fixed nodes.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.CorrHist = b
		case "corrhistminor", "chm":
			// extra corrhist key on the minor-piece (N+B) skeleton (requires corrhist).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.CorrHistMinor = b
		case "corrhistcont", "chc":
			// extra corrhist key: continuation correction from the stm's prior moves
			// at ply-2/-4 (requires corrhist).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.CorrHistCont = b
		case "capthist", "caph":
			// capture history: (piece,to,victim) stats refine capture ordering within
			// the SEE good/bad tier.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.CaptHist = b
		case "conthist", "cont", "cmh":
			// continuation history: 1-ply (countermove) + 2-ply history keyed by the
			// preceding move(s); feeds quiet ordering + the LMR reduction term.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.ContHist = b
		case "lmr2":
			// aggressive LMR: reduce captures/promotions too, earlier onset, with
			// PV/improving/ordering-trust/SEE adjustments (supersedes LMR when on).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.LMR2 = b
		case "singular", "se":
			// singular extensions: verify the TT move vs all alternatives at reduced
			// depth; extend a ply if singular, multi-cut if a second move beats beta.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.Singular = b
		case "doubleext", "dext":
			// double extensions: when the TT move is singular by a wide margin at a
			// non-PV node, extend it 2 plies instead of 1 (DEFAULT OFF).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.DoubleExt = b
		case "multicut", "mc":
			// singular: allow the verification's multi-cut early-return (diagnostic;
			// default on — flip off to isolate fragile multi-cut from the rest of singular).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.MultiCut = b
		case "cleanverify", "cv":
			// singular: run the verification subtree with conservative LMR, not LMR2
			// (diagnostic for the lmr2+singular anti-synergy; inert unless LMR2 is on).
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.CleanVerify = b
		case "iir":
			// internal iterative reduction: reduce a ply at a deep node with no TT move.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.IIR = b
		case "futility", "fut":
			// frontier futility pruning: skip late quiets that can't reach alpha.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.Futility = b
		case "histprune", "hp":
			// history pruning: skip late quiets whose history score is strongly negative.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.HistPrune = b
		case "seequiet", "seeq":
			// quiet-move SEE pruning: skip a quiet move that hangs material to the recapture.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.SEEQuiet = b
		case "seequietmargin", "sqm":
			n, err := strconv.Atoi(val)
			if err != nil {
				return base, fmt.Errorf("seequietmargin: %q is not an int", val)
			}
			base.SEEQuietMargin = n
		case "seequietmaxdepth", "sqd":
			n, err := strconv.Atoi(val)
			if err != nil {
				return base, fmt.Errorf("seequietmaxdepth: %q is not an int", val)
			}
			base.SEEQuietMaxDepth = n
		case "probcut", "pc":
			// probcut: capture-driven reduced-depth fail-high prune.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.ProbCut = b
		case "razor", "razoring":
			// razoring: shallow drop-to-qsearch fail-low prune.
			b, err := parseBool(val)
			if err != nil {
				return base, fmt.Errorf("%s: %w", key, err)
			}
			base.Razor = b
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
	if base.TTEval != patch.TTEval {
		diffs = append(diffs, fmt.Sprintf("tteval: %s→%s", onoff(base.TTEval), onoff(patch.TTEval)))
	}
	if base.CorrHist != patch.CorrHist {
		diffs = append(diffs, fmt.Sprintf("corrhist: %s→%s", onoff(base.CorrHist), onoff(patch.CorrHist)))
	}
	if base.CorrHistMinor != patch.CorrHistMinor {
		diffs = append(diffs, fmt.Sprintf("corrhistminor: %s→%s", onoff(base.CorrHistMinor), onoff(patch.CorrHistMinor)))
	}
	if base.CorrHistCont != patch.CorrHistCont {
		diffs = append(diffs, fmt.Sprintf("corrhistcont: %s→%s", onoff(base.CorrHistCont), onoff(patch.CorrHistCont)))
	}
	if base.ContHist != patch.ContHist {
		diffs = append(diffs, fmt.Sprintf("conthist: %s→%s", onoff(base.ContHist), onoff(patch.ContHist)))
	}
	if base.LMR2 != patch.LMR2 {
		diffs = append(diffs, fmt.Sprintf("lmr2: %s→%s", onoff(base.LMR2), onoff(patch.LMR2)))
	}
	if base.Singular != patch.Singular {
		diffs = append(diffs, fmt.Sprintf("singular: %s→%s", onoff(base.Singular), onoff(patch.Singular)))
	}
	if base.DoubleExt != patch.DoubleExt {
		diffs = append(diffs, fmt.Sprintf("doubleext: %s→%s", onoff(base.DoubleExt), onoff(patch.DoubleExt)))
	}
	if base.MultiCut != patch.MultiCut {
		diffs = append(diffs, fmt.Sprintf("multicut: %s→%s", onoff(base.MultiCut), onoff(patch.MultiCut)))
	}
	if base.CleanVerify != patch.CleanVerify {
		diffs = append(diffs, fmt.Sprintf("cleanverify: %s→%s", onoff(base.CleanVerify), onoff(patch.CleanVerify)))
	}
	if base.IIR != patch.IIR {
		diffs = append(diffs, fmt.Sprintf("iir: %s→%s", onoff(base.IIR), onoff(patch.IIR)))
	}
	if base.Futility != patch.Futility {
		diffs = append(diffs, fmt.Sprintf("futility: %s→%s", onoff(base.Futility), onoff(patch.Futility)))
	}
	if base.HistPrune != patch.HistPrune {
		diffs = append(diffs, fmt.Sprintf("histprune: %s→%s", onoff(base.HistPrune), onoff(patch.HistPrune)))
	}
	if base.SEEQuiet != patch.SEEQuiet {
		diffs = append(diffs, fmt.Sprintf("seequiet: %s→%s", onoff(base.SEEQuiet), onoff(patch.SEEQuiet)))
	}
	if base.SEEQuietMargin != patch.SEEQuietMargin {
		diffs = append(diffs, fmt.Sprintf("seequietmargin: %d→%d", base.SEEQuietMargin, patch.SEEQuietMargin))
	}
	if base.SEEQuietMaxDepth != patch.SEEQuietMaxDepth {
		diffs = append(diffs, fmt.Sprintf("seequietmaxdepth: %d→%d", base.SEEQuietMaxDepth, patch.SEEQuietMaxDepth))
	}
	if base.ProbCut != patch.ProbCut {
		diffs = append(diffs, fmt.Sprintf("probcut: %s→%s", onoff(base.ProbCut), onoff(patch.ProbCut)))
	}
	if base.Razor != patch.Razor {
		diffs = append(diffs, fmt.Sprintf("razor: %s→%s", onoff(base.Razor), onoff(patch.Razor)))
	}
	if base.SingularMargin != patch.SingularMargin {
		diffs = append(diffs, fmt.Sprintf("singularmargin: %d→%d", base.SingularMargin, patch.SingularMargin))
	}
	if base.SingularMinDepth != patch.SingularMinDepth {
		diffs = append(diffs, fmt.Sprintf("singulardepth: %d→%d", base.SingularMinDepth, patch.SingularMinDepth))
	}
	if base.DoubleExtMargin != patch.DoubleExtMargin {
		diffs = append(diffs, fmt.Sprintf("doubleextmargin: %d→%d", base.DoubleExtMargin, patch.DoubleExtMargin))
	}
	if base.CaptHist != patch.CaptHist {
		diffs = append(diffs, fmt.Sprintf("capthist: %s→%s", onoff(base.CaptHist), onoff(patch.CaptHist)))
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
