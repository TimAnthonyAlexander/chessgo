// Package search implements iterative-deepening negamax with alpha-beta,
// a transposition table, move ordering, quiescence, null-move pruning, and late
// move reductions (SPEC §4.5–§4.7). Scores are centipawns; mate scores are
// encoded near ±mateScore.
package search

import (
	"math"
	"sort"
	"sync"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/eval"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

// lmrTable[depth][moveCount] is the base late-move reduction in plies, the
// canonical log(d)·log(m) surface (Ethereal's 0.7844 + ln·ln/2.4696). Read-only
// after init, so it is safe to share across Lazy SMP workers.
var lmrTable [64][64]int

func init() {
	for d := 1; d < 64; d++ {
		for m := 1; m < 64; m++ {
			lmrTable[d][m] = int(0.7844 + math.Log(float64(d))*math.Log(float64(m))/2.4696)
		}
	}
}

const (
	maxPly        = 128
	infinity      = 30000
	mateScore     = 29000
	mateThreshold = mateScore - maxPly
	// Syzygy WDL-in-search scores sit in a band just BELOW the mate band: a TB win
	// is exact and stronger than any eval, but it is not a forced mate, so it must
	// rank under real mates and must NOT be reported as one by mateDistance. tbWin
	// is the (ply-0) magnitude; with the ply adjustment a TB score ranges over
	// [tbThreshold, tbWin]. The TT ply-adjusts any score above tbThreshold (so both
	// TB and mate bands are corrected across plies); mateDistance still keys off
	// mateThreshold, so TB scores read as 0 mate distance. No normal static eval
	// reaches tbThreshold, so this is inert when TBSearch is off.
	tbWin       = mateThreshold - 1
	tbThreshold = tbWin - maxPly
	// deltaMargin is the safety cushion (centipawns) for quiescence delta pruning.
	deltaMargin = 200
	// Reverse futility pruning: margin per depth and the max depth it applies at.
	rfpMargin   = 75
	rfpMaxDepth = 8
	// Late move pruning: max depth it applies at. The move-count limit is
	// 3 + depth² (so depth 1→4, 2→7, 3→12, …).
	lmpMaxDepth = 8
	// History (gravity scheme, Params.HistMalus): values saturate toward
	// ±maxHistory via the gravity update; the per-update bonus/malus is capped at
	// histBonusMax so a single deep cutoff can't dominate the table.
	maxHistory   = 8192
	histBonusMax = 1536
	// lmrHistoryDiv scales a quiet move's history into a reduction adjustment:
	// good-history quiets reduce less, malus'd (negative) quiets reduce more.
	lmrHistoryDiv = 4096
	// evalNone marks a ply whose static eval is undefined (the side was in check),
	// so the "improving" comparison skips it. Outside any real eval range.
	evalNone = infinity + 1
	// Singular extensions (Params.Singular): the minimum remaining depth at which we
	// attempt a verification search, and the per-depth margin for the singular
	// window singularBeta = ttScore − singularMargin·depth. The verification search
	// runs at reduced depth (depth−1)/2 with the TT move excluded; if every other
	// move fails low under singularBeta the TT move is "singular" and is extended a
	// ply. Margin/depth follow Stockfish-class defaults (depth≥~6–8, margin ~2–3·d).
	singularMinDepth = 8
	singularMargin   = 2
	// Internal iterative reduction (Params.IIR): at a node this deep with no TT
	// move to guide ordering, search a ply shallower (seeds the TT, cheaper redo).
	iirMinDepth = 4
	// Frontier futility pruning (Params.Futility): max depth it applies at and the
	// per-depth centipawn margin. A late quiet is skipped when staticEval +
	// futilityMargin·depth ≤ alpha (it almost surely can't raise alpha).
	futilityMaxDepth = 6
	futilityMargin   = 100
	// History pruning (Params.HistPrune): max depth it applies at and the per-depth
	// history threshold. A late quiet is skipped when its history score (butterfly,
	// plus continuation history when ContHist is on) is below histPruneMargin·depth.
	// The threshold is negative and grows more negative with depth (deeper = prune
	// only the very worst-ranked quiets). Distinct from LMP (move count) and
	// Frontier futility (static eval) — this keys off history magnitude.
	histPruneMaxDepth = 6
	histPruneMargin   = -1000
	// ProbCut (Params.ProbCut): min depth, the raised-beta margin (cp), and the
	// reduced search depth = depth − probcutReduction.
	probcutMinDepth  = 5
	probcutMargin    = 180
	probcutReduction = 4
	// Razoring (Params.Razor): max depth and per-depth margin (cp). If staticEval +
	// razorMargin·depth < alpha at a shallow non-PV node, fall to qsearch and prune
	// if it confirms the score is below alpha.
	razorMaxDepth = 3
	razorMargin   = 250
)

// statBonus is the depth-scaled history bonus/malus magnitude (capped). Used both
// as the bonus for a quiet move that caused a beta cutoff and as the malus for the
// quiets that were tried first and did not.
func statBonus(depth int) int {
	b := 32 * depth * depth
	if b > histBonusMax {
		b = histBonusMax
	}
	return b
}

// updateHistory applies the "history gravity" update: the entry is nudged toward
// ±maxHistory by bonus, with a pull proportional to the current magnitude, so the
// table self-ages (old evidence decays as new arrives) and stays bounded.
func (s *Searcher) updateHistory(pc chess.Piece, to chess.Square, bonus int) {
	if bonus > maxHistory {
		bonus = maxHistory
	} else if bonus < -maxHistory {
		bonus = -maxHistory
	}
	e := &s.history[pc][to]
	*e += bonus - (*e)*absInt(bonus)/maxHistory
}

// updateQuietStats credits a quiet move that caused a beta cutoff. With HistMalus
// off it keeps the legacy unbounded `depth²` bonus (byte-identical to before).
// With it on it uses the gravity update: +bonus to the cutting move and −bonus to
// every quiet tried before it that failed to cut off (tried includes best as its
// last element).
func (s *Searcher) updateQuietStats(pos *chess.Position, best chess.Move, tried []chess.Move, depth int) {
	if !s.params.HistMalus {
		s.history[pos.PieceOn(best.From())][best.To()] += depth * depth
		return
	}
	bonus := statBonus(depth)
	s.updateHistory(pos.PieceOn(best.From()), best.To(), bonus)
	for _, q := range tried {
		if q != best {
			s.updateHistory(pos.PieceOn(q.From()), q.To(), -bonus)
		}
	}
}

// captureVictim returns the captured piece type of a capture move m on the
// (current) position. En-passant captures a pawn; otherwise it's the piece on the
// destination square. Caller must only pass capture moves.
func captureVictim(pos *chess.Position, m chess.Move) chess.PieceType {
	if m.Type() == chess.EnPassant {
		return chess.Pawn
	}
	return pos.PieceOn(m.To()).Type()
}

// updateCaptureHistory applies the same bounded "gravity" update as updateHistory,
// keyed by (moved piece, to-square, victim type). pos must be the position the
// capture is made FROM (so m.From()/m.To() resolve the mover and victim).
func (s *Searcher) updateCaptureHistory(pos *chess.Position, m chess.Move, bonus int) {
	if bonus > maxHistory {
		bonus = maxHistory
	} else if bonus < -maxHistory {
		bonus = -maxHistory
	}
	pc := pos.PieceOn(m.From())
	e := &s.captureHist[pc][m.To()][captureVictim(pos, m)]
	*e += bonus - (*e)*absInt(bonus)/maxHistory
}

// updateCaptureStats credits a capture that caused a beta cutoff (+bonus) and
// penalizes the captures tried before it that did not (−bonus), using the gravity
// scheme. pos must be restored to the node position (after UndoMove).
func (s *Searcher) updateCaptureStats(pos *chess.Position, best chess.Move, tried []chess.Move, depth int) {
	bonus := statBonus(depth)
	s.updateCaptureHistory(pos, best, bonus)
	for _, c := range tried {
		if c != best {
			s.updateCaptureHistory(pos, c, -bonus)
		}
	}
}

// pieceOrderVal is a coarse piece value used by MVV-LVA move ordering.
var pieceOrderVal = [6]int{100, 320, 330, 500, 900, 20000}

// Limits bounds a search.
type Limits struct {
	Depth    int           // max depth (<=0 → use maxPly)
	MoveTime time.Duration // soft time budget (0 → none)
	Nodes    uint64        // optional node cap (0 → none)
}

// Result is the outcome of a search.
type Result struct {
	BestMove chess.Move
	Score    int
	Depth    int
	Nodes    uint64
	PV       []chess.Move
	MateIn   int // signed mate distance in moves (0 = none)
	Elapsed  time.Duration
}

// Searcher holds reusable search state (TT, killers, history).
type Searcher struct {
	tt      *TT
	params  Params
	ec      eval.Config // evaluation config derived from params
	killers [maxPly][2]chess.Move
	history [12][64]int
	// captureHist[movedPiece][toSquare][victimType] is the capture-history table
	// (Params.CaptHist): gravity-updated stats that refine capture ordering within
	// the SEE good/bad tier. Per-search, like the butterfly history.
	captureHist [12][64][6]int
	// staticEvals[ply] is the static eval at that ply (evalNone while in check), so
	// a node can ask whether its side is "improving" vs two plies ago.
	staticEvals [maxPly]int
	nodes       uint64
	stop        bool
	deadline    time.Time
	useTime     bool
	nodeCap     uint64
	keyStack    []uint64

	// Syzygy tablebase for WDL-in-search (Params.TBSearch). Shared, read-only
	// pointer (Fathom's WDL probe is thread-safe), copied to every SMP worker.
	tb    *syzygy.Tablebase
	tbMax int // tb.MaxPieces() cached, 0 when no tablebase
	// weakenedSearch suppresses the WDL-in-search probe while ranking root moves
	// for a WEAKENED bot (RootScores). Mirrors how root-DTZ only probes in the
	// no-noise branch: a leveled bot must keep playing at its level, not suddenly
	// convert ≤MaxPieces endings perfectly (which would break levelForRating).
	weakenedSearch bool

	rootBest  chess.Move
	rootScore int

	// NNUE incremental accumulator (Phase A). accStack is a per-searcher,
	// ply-indexed accumulator stack; useNNUE is true only while a net is loaded
	// AND the eval is routed through NNUE, so HCE searches pay zero overhead.
	accStack *nnue.Stack
	useNNUE  bool
	// multiStack, when non-nil, is the active INCREMENTAL accumulator for a
	// multilayer (GNN4) net: it shadows accStack at the same push/pop sites (via
	// the acc* helpers) and routes rawEvaluate to the multilayer tail. nil ⇒ the
	// single-layer accStack path (v6). multiStackCache holds the allocation across
	// searches so it is rebuilt only on a net swap. useNNUE is true for either net.
	multiStack      *nnue.MultiStack
	multiStackCache *nnue.MultiStack
	// enrichedStack, when non-nil, is the active INCREMENTAL accumulator for an
	// ENRICHED (threats) net: it shadows accStack/multiStack at the push/pop sites
	// and routes rawEvaluate to the enriched tail. It takes precedence over both.
	// enrichedStackCache holds the allocation across searches (rebuilt on net swap).
	enrichedStack      *nnue.EnrichedStack
	enrichedStackCache *nnue.EnrichedStack

	// Diagnostic counters (cheap, like nodes) — used by tests to confirm the
	// accumulator gate actually covered null-move and quiescence nodes, and that the
	// singular-extension paths fire.
	dbgNullMoves uint64
	dbgQNodes    uint64
	dbgSingular  uint64 // singular extensions applied (TT move extended a ply)
	dbgDoubleExt uint64 // double extensions applied (TT move extended 2 plies; Params.DoubleExt)
	dbgMultiCut  uint64 // singular verification multi-cuts (early fail-high)
	dbgHistPrune uint64 // late quiets skipped by history pruning (Params.HistPrune)
	dbgSEEQuiet  uint64 // quiets skipped by quiet-move SEE pruning (Params.SEEQuiet)
	dbgCaptSEE   uint64 // captures skipped by capture-move SEE pruning (Params.CaptSEE)

	// Correction history tables (Params.CorrHist). Persist across moves within a
	// game; cleared in ClearTT() between games, NOT in reset(). See corrhist.go.
	corr corrTables

	// Continuation history (Params.ContHist). cont holds the two keyed tables
	// (allocated only when ContHist is on); contMove[ply] records the move played
	// to descend from that ply, so a child can key off its parent/grandparent.
	// Cleared per-search in reset() (mirrors butterfly history). See conthist.go.
	cont     *contHist
	contMove [maxPly]contEntry

	// excluded[ply] is the move barred from the search at that ply during a
	// singular-extension verification search (Params.Singular); NullMove outside a
	// verification. A node with an excluded move set skips its own TT cutoff and TT
	// store (the stored entry describes the full move set, not the restricted one).
	excluded [maxPly]chess.Move

	// inSingularVerify is true while we are inside a singular-extension
	// verification subtree (Params.CleanVerify): it makes that subtree fall back to
	// conservative LMR instead of LMR2, so over-reduced alternatives don't pollute
	// the singular decision. Save/restore around the verify call so nesting is safe.
	inSingularVerify bool
}

// DbgNullMoves and DbgQNodes report how many null-move and quiescence nodes the
// last search executed (test/diagnostic only).
func (s *Searcher) DbgNullMoves() uint64 { return s.dbgNullMoves }
func (s *Searcher) DbgQNodes() uint64    { return s.dbgQNodes }

// DbgSingular and DbgMultiCut report how many singular extensions and singular
// multi-cuts the last search performed (test/diagnostic only).
func (s *Searcher) DbgSingular() uint64 { return s.dbgSingular }
func (s *Searcher) DbgMultiCut() uint64 { return s.dbgMultiCut }

// DbgDoubleExt reports how many double extensions the last search applied
// (Params.DoubleExt; test/diagnostic only).
func (s *Searcher) DbgDoubleExt() uint64 { return s.dbgDoubleExt }

// DbgHistPrune reports how many late quiets the last search skipped via history
// pruning (Params.HistPrune; test/diagnostic only).
func (s *Searcher) DbgHistPrune() uint64 { return s.dbgHistPrune }

// DbgSEEQuiet reports how many quiets the last search skipped via quiet-move SEE
// pruning (Params.SEEQuiet; test/diagnostic only).
func (s *Searcher) DbgSEEQuiet() uint64 { return s.dbgSEEQuiet }

// DbgCaptSEE reports how many captures the last search skipped via capture-move
// SEE pruning (Params.CaptSEE; test/diagnostic only).
func (s *Searcher) DbgCaptSEE() uint64 { return s.dbgCaptSEE }

// New returns a full-strength Searcher with a transposition table of ttSizeMB
// megabytes.
func New(ttSizeMB int) *Searcher { return NewWithParams(ttSizeMB, DefaultParams()) }

// NewWithParams returns a Searcher configured by params — used by the self-play
// harness to build the "old" and "new" engines from the same code.
func NewWithParams(ttSizeMB int, params Params) *Searcher {
	return &Searcher{
		tt:       NewTT(ttSizeMB),
		params:   params,
		ec:       evalConfig(params),
		keyStack: make([]uint64, 0, 1024),
	}
}

// SetTablebase attaches the Syzygy handle used for WDL-in-search. The handle is
// shared read-only across SMP workers (Fathom's WDL probe is thread-safe), so it
// is only stored, never copied. Pass nil to detach. Inert unless Params.TBSearch.
func (s *Searcher) SetTablebase(tb *syzygy.Tablebase) {
	s.tb = tb
	if tb != nil {
		s.tbMax = tb.MaxPieces()
	} else {
		s.tbMax = 0
	}
}

// evalConfig derives the evaluation config (term toggles + weights) from params.
func evalConfig(p Params) eval.Config {
	w := eval.DefaultWeights()
	if p.TunedEval {
		w = eval.TunedWeights()
	}
	return eval.Config{
		Mobility:    p.Mobility,
		Pawns:       p.Pawns,
		KingSafety:  p.KingSafety,
		BishopPair:  p.BishopPair,
		KingProx:    p.KingProx,
		PawnRace:    p.PawnRace,
		ScaleFactor: p.ScaleFactor,
		UseTuned:    p.TunedEval,
		NNUE:        p.Nnue,
		W:           w,
	}
}

// evaluate is the searcher's static evaluation, honoring its enabled eval terms.
// When NNUE is enabled and a net is loaded it reads the incrementally-maintained
// accumulator (Phase A — a side-to-move-relative cp score, same contract as HCE);
// otherwise it falls back to the hand-crafted eval.
func (s *Searcher) evaluate(pos *chess.Position) int {
	raw := s.rawEvaluate(pos)
	// Correction history: shift the raw static eval by the learned per-pattern bias
	// (bounded). Gated on the flag so an off-search is byte-identical to before.
	if s.params.CorrHist {
		raw += s.correction(pos)
	}
	return raw
}

// rawEvaluate is the position-deterministic static eval (NNUE accumulator or HCE)
// WITHOUT the correction-history shift. The TT static-eval cache stores this raw
// value (not the corrected one): the correction depends on the evolving corrhist
// tables, so caching the corrected eval would make TTEval reuse a stale value and
// stop being behavior-preserving. Callers apply the fresh correction on top.
func (s *Searcher) rawEvaluate(pos *chess.Position) int {
	if s.useNNUE {
		return s.accEval(pos)
	}
	return eval.Evaluate(pos, s.ec)
}

// acc* route the per-ply accumulator operations to the active stack — the
// multilayer multiStack when a GNN4 net is installed, else the single-layer
// accStack. The nil-check is a cheap, predictable branch, so v6 keeps its
// concrete fast path (no interface dispatch).
func (s *Searcher) accReset(pos *chess.Position) {
	if s.enrichedStack != nil {
		s.enrichedStack.Reset(pos)
		return
	}
	if s.multiStack != nil {
		s.multiStack.Reset(pos)
		return
	}
	s.accStack.Reset(pos)
}

func (s *Searcher) accPush(pos *chess.Position, m chess.Move) {
	if s.enrichedStack != nil {
		s.enrichedStack.Push(pos, m)
		return
	}
	if s.multiStack != nil {
		s.multiStack.Push(pos, m)
		return
	}
	s.accStack.Push(pos, m)
}

func (s *Searcher) accPushNull() {
	if s.enrichedStack != nil {
		s.enrichedStack.PushNull()
		return
	}
	if s.multiStack != nil {
		s.multiStack.PushNull()
		return
	}
	s.accStack.PushNull()
}

func (s *Searcher) accPop() {
	if s.enrichedStack != nil {
		s.enrichedStack.Pop()
		return
	}
	if s.multiStack != nil {
		s.multiStack.Pop()
		return
	}
	s.accStack.Pop()
}

func (s *Searcher) accEval(pos *chess.Position) int {
	if s.enrichedStack != nil {
		return s.enrichedStack.Eval(pos)
	}
	if s.multiStack != nil {
		return s.multiStack.Eval(pos)
	}
	return s.accStack.Eval(pos)
}

// nnueBegin prepares the incremental accumulator for a search rooted at pos. It
// sets useNNUE only when NNUE is on AND a net is loaded, (re)allocating the stack
// if the default net changed, and rebuilds slot 0 from scratch. Cheap and
// idempotent — safe to call at every top-level search entry.
func (s *Searcher) nnueBegin(pos *chess.Position) {
	s.useNNUE = false
	s.multiStack = nil
	s.enrichedStack = nil
	if !s.ec.NNUE {
		return
	}
	// An enriched (threats) net, if installed, takes precedence and drives its own
	// incremental accumulator (enrichedStack), shadowing accStack at the push/pop
	// sites. enrichedStackCache keeps the allocation across searches.
	if en := nnue.DefaultEnriched(); en != nil {
		if s.enrichedStackCache == nil || s.enrichedStackCache.Net() != en {
			s.enrichedStackCache = en.NewStack(maxPly + 8)
		}
		s.enrichedStack = s.enrichedStackCache
		s.enrichedStack.Reset(pos)
		s.useNNUE = true
		return
	}
	// A multilayer (GNN4) net, if installed, takes precedence: drive its own
	// incremental accumulator (multiStack), shadowing accStack at the same push/pop
	// sites. multiStackCache keeps the allocation across searches (rebuilt only on
	// a net swap); multiStack==nil for the v6 path leaves accStack in charge.
	if m := nnue.DefaultMulti(); m != nil {
		if s.multiStackCache == nil || s.multiStackCache.Net() != m {
			s.multiStackCache = m.NewStack(maxPly + 8)
		}
		s.multiStack = s.multiStackCache
		s.multiStack.Reset(pos)
		s.useNNUE = true
		return
	}
	net := nnue.Default()
	if net == nil {
		return
	}
	if s.accStack == nil || s.accStack.Net() != net {
		s.accStack = net.NewStack(maxPly + 8)
	}
	s.accStack.SetFloatMode(s.params.NnueFloat)
	s.accStack.Reset(pos)
	s.useNNUE = true
}

// tbProbePosition builds Fathom's bitboard request from a chess.Position (mirrors
// engine.tbPosition). Piece bitboards are color-agnostic; White/Black are the
// per-color occupancies. Castling is 0 — the caller only probes positions without
// castling rights. ep is 0 when there's no en-passant target (a1 is never an ep
// square, so 0 is unambiguous).
func tbProbePosition(pos *chess.Position) syzygy.Position {
	both := func(pt chess.PieceType) uint64 {
		return uint64(pos.PieceBB(chess.MakePiece(chess.White, pt)) |
			pos.PieceBB(chess.MakePiece(chess.Black, pt)))
	}
	ep := uint(0)
	if sq := pos.EnPassantSquare(); sq != chess.SqNone {
		ep = uint(sq)
	}
	return syzygy.Position{
		White:       uint64(pos.ColorBB(chess.White)),
		Black:       uint64(pos.ColorBB(chess.Black)),
		Kings:       both(chess.King),
		Queens:      both(chess.Queen),
		Rooks:       both(chess.Rook),
		Bishops:     both(chess.Bishop),
		Knights:     both(chess.Knight),
		Pawns:       both(chess.Pawn),
		Rule50:      uint(pos.HalfmoveClock()),
		Castling:    0,
		EP:          ep,
		WhiteToMove: pos.SideToMove() == chess.White,
	}
}

// newWithSharedTT returns a helper Searcher that shares tt with others (Lazy SMP
// worker). It has its own killers/history/stack/node counter; only the TT is
// shared. It must NOT bump the TT age — the coordinator does that once.
func newWithSharedTT(tt *TT, params Params) *Searcher {
	return &Searcher{
		tt:       tt,
		params:   params,
		ec:       evalConfig(params),
		keyStack: make([]uint64, 0, 1024),
	}
}

// ClearTT empties the transposition table. The match driver calls this between
// games so a finished game's entries never bias the next one.
func (s *Searcher) ClearTT() {
	s.tt.Clear()
	s.corr = corrTables{} // correction history is per-game; reset it with the TT
}

func (s *Searcher) reset(limits Limits, gameHistory []uint64) {
	s.nodes = 0
	s.dbgNullMoves = 0
	s.dbgQNodes = 0
	s.dbgSingular = 0
	s.dbgDoubleExt = 0
	s.dbgMultiCut = 0
	s.dbgHistPrune = 0
	s.dbgSEEQuiet = 0
	s.dbgCaptSEE = 0
	s.stop = false
	s.killers = [maxPly][2]chess.Move{}
	s.history = [12][64]int{}
	s.captureHist = [12][64][6]int{}
	s.excluded = [maxPly]chess.Move{} // always NullMove outside a verification; reset for safety
	s.inSingularVerify = false
	s.contBegin() // continuation history: clear tables + path, per-search like butterfly
	s.useTime = limits.MoveTime > 0
	if s.useTime {
		s.deadline = time.Now().Add(limits.MoveTime)
	}
	s.nodeCap = limits.Nodes
	s.keyStack = append(s.keyStack[:0], gameHistory...)
	s.rootBest = chess.NullMove
	s.rootScore = 0
}

func (s *Searcher) pushKey(k uint64) { s.keyStack = append(s.keyStack, k) }
func (s *Searcher) popKey()          { s.keyStack = s.keyStack[:len(s.keyStack)-1] }

func (s *Searcher) checkStop() {
	if s.stop {
		return
	}
	if s.useTime && s.nodes&2047 == 0 && time.Now().After(s.deadline) {
		s.stop = true
	}
	if s.nodeCap > 0 && s.nodes >= s.nodeCap {
		s.stop = true
	}
}

// isRepetition reports whether the current position (top of keyStack) has
// occurred earlier within the halfmove window.
//
// This treats the FIRST repetition as a draw, regardless of whether the earlier
// occurrence is inside the search tree or back in the pre-root game history — the
// standard "first-repetition = draw" heuristic most engines use (Chess
// Programming Wiki, "Repetitions"). It's a deliberate playing-strength choice:
// self-play SPRT measured the stricter "threefold against game history" rule at
// −33 ± 16 Elo @ 25k nodes, because the cheap draw-detection earns Elo at a fixed
// node budget. Game ANALYSIS, which wants an objective per-position eval rather
// than a practical playing decision, deliberately does NOT feed game history in
// (see server.analyzePosition), so this heuristic can't mask a result there.
func (s *Searcher) isRepetition(pos *chess.Position) bool {
	key := pos.Key()
	last := len(s.keyStack) - 1
	start := last - int(pos.HalfmoveClock())
	if start < 0 {
		start = 0
	}
	for i := last - 2; i >= start; i -= 2 {
		if s.keyStack[i] == key {
			return true
		}
	}
	return false
}

// Search runs iterative deepening and returns the best line. gameHistory holds
// Zobrist keys of positions that occurred before the root (for repetition).
func (s *Searcher) Search(pos *chess.Position, limits Limits, gameHistory []uint64) Result {
	s.tt.NewSearchAge()
	return s.runID(pos, limits, gameHistory)
}

// SearchParallel runs Lazy SMP: `threads` workers search the same position
// concurrently, sharing this Searcher's transposition table (each worker keeps
// its own killers/history/stack). They diverge via timing and cross-pollinate
// through the shared TT; the result is taken from the worker that reached the
// greatest completed depth. threads<=1 is exactly the single-threaded Search.
func (s *Searcher) SearchParallel(pos *chess.Position, limits Limits, gameHistory []uint64, threads int) Result {
	if threads <= 1 {
		return s.Search(pos, limits, gameHistory)
	}
	s.tt.NewSearchAge() // once, before any worker — TT age is then read-only

	results := make([]Result, threads)
	var wg sync.WaitGroup
	for i := 0; i < threads; i++ {
		wg.Add(1)
		worker := s
		if i > 0 {
			worker = newWithSharedTT(s.tt, s.params)
			worker.tb, worker.tbMax = s.tb, s.tbMax // share the read-only TB handle
		}
		go func(i int, w *Searcher) {
			defer wg.Done()
			p := *pos // value copy: each worker mutates its own board
			results[i] = w.runID(&p, limits, gameHistory)
		}(i, worker)
	}
	wg.Wait()

	best := results[0]
	for i := 1; i < threads; i++ {
		if results[i].Depth > best.Depth ||
			(results[i].Depth == best.Depth && results[i].Score > best.Score) {
			best = results[i]
		}
	}
	return best
}

// runID is the iterative-deepening loop for one worker (no TT-age bump — the
// caller owns that so parallel workers don't all bump the shared counter).
func (s *Searcher) runID(pos *chess.Position, limits Limits, gameHistory []uint64) Result {
	s.reset(limits, gameHistory)
	s.pushKey(pos.Key())
	s.nnueBegin(pos)

	maxDepth := limits.Depth
	if maxDepth <= 0 || maxDepth >= maxPly {
		maxDepth = maxPly - 1
	}

	start := time.Now()
	var result Result
	for d := 1; d <= maxDepth; d++ {
		s.searchRoot(pos, d, result.Score)
		if s.stop && d > 1 {
			break // discard incomplete iteration
		}
		result.BestMove = s.rootBest
		result.Score = s.rootScore
		result.Depth = d
		result.Nodes = s.nodes
		result.PV = s.extractPV(pos, d)
		result.MateIn = mateDistance(s.rootScore)
		if result.MateIn != 0 {
			break // mate found; no need to search deeper
		}
		if s.useTime && time.Now().After(s.deadline) {
			break
		}
	}
	result.Elapsed = time.Since(start)
	return result
}

// Aspiration-window constants (SPEC §4.5). Around the previous iteration's
// score we open a narrow window and only re-search wider on a fail.
const (
	aspMinDepth  = 4    // full window for shallower iterations
	aspInitDelta = 25   // initial half-window (centipawns)
	aspMaxDelta  = 1500 // beyond this, fall back to a full window
)

// searchRoot runs one iterative-deepening iteration at the given depth. With
// aspiration enabled (and past the warmup depth) it searches a narrow window
// around prevScore, widening only the bound that fails until the score lands
// inside — fewer root nodes than a full -inf/+inf window. rootBest/rootScore are
// set by negamax at ply 0; on a fail-low the root move is not trusted (we
// re-search), and the caller discards the whole iteration if the clock expires.
func (s *Searcher) searchRoot(pos *chess.Position, depth, prevScore int) {
	// Re-anchor the incremental accumulator at the root each iteration (sp→0,
	// rebuilt from scratch): self-correcting against any push/pop imbalance and
	// cheap relative to a full-depth search.
	if s.useNNUE {
		s.accReset(pos)
	}
	if !s.params.Aspiration || depth < aspMinDepth || absInt(prevScore) >= mateThreshold {
		s.negamax(pos, depth, 0, -infinity, infinity)
		return
	}
	delta := aspInitDelta
	alpha := maxInt(prevScore-delta, -infinity)
	beta := minInt(prevScore+delta, infinity)
	for {
		score := s.negamax(pos, depth, 0, alpha, beta)
		if s.stop {
			return
		}
		switch {
		case score <= alpha: // fail low: lower alpha, pull beta toward center
			beta = (alpha + beta) / 2
			alpha = maxInt(score-delta, -infinity)
		case score >= beta: // fail high: raise beta
			beta = minInt(score+delta, infinity)
		default:
			return // score inside the window
		}
		delta += delta
		if delta >= aspMaxDelta {
			alpha, beta = -infinity, infinity
		}
	}
}

func absInt(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// RootMove pairs a root move with its searched score.
type RootMove struct {
	Move  chess.Move
	Score int
}

// Nodes returns the node count of the most recent search.
func (s *Searcher) Nodes() uint64 { return s.nodes }

// RootScores searches every legal root move independently to limits.Depth and
// returns their scores (MultiPV-style), used by the engine's level-based
// weakening. Scores are from the root side-to-move's perspective.
func (s *Searcher) RootScores(pos *chess.Position, limits Limits, gameHistory []uint64) []RootMove {
	s.tt.NewSearchAge()
	s.reset(limits, gameHistory)
	// Weakened-bot ranking: suppress WDL-in-search so a leveled bot doesn't play
	// perfect ≤MaxPieces endgames (same gating root-DTZ gets via the no-noise
	// branch). Restored on return so the shared searcher's next full-strength call
	// probes normally.
	s.weakenedSearch = true
	defer func() { s.weakenedSearch = false }()
	s.pushKey(pos.Key())
	s.nnueBegin(pos)

	depth := limits.Depth
	if depth < 1 {
		depth = 1
	}

	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	out := make([]RootMove, 0, ml.Len())
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		var u chess.Undo
		if s.useNNUE {
			s.accPush(pos, m)
		}
		pos.DoMove(m, &u)
		s.pushKey(pos.Key())
		score := -s.negamax(pos, depth-1, 1, -infinity, infinity)
		s.popKey()
		pos.UndoMove(m, &u)
		if s.useNNUE {
			s.accPop()
		}
		out = append(out, RootMove{Move: m, Score: score})
	}
	return out
}

// RootLine is one candidate root move with its full-strength evaluation: score,
// signed mate distance, principal variation, and the depth it was searched to.
type RootLine struct {
	Move   chess.Move
	Score  int // root side-to-move's perspective (centipawns, or mate-encoded)
	MateIn int // signed mate distance in moves (0 = none)
	PV     []chess.Move
	Depth  int
}

// MultiPV evaluates EVERY legal root move at full strength and returns them ranked
// best-first, each with its exact score/mate and PV. This is the engine side of
// the analysis board's "candidate moves + an eval bar per move".
//
// Unlike RootScores (which powers bot weakening and deliberately suppresses the
// tablebase probe), MultiPV is a full-strength analysis primitive — WDL-in-search
// stays on. It runs iterative deepening at the root; each iteration scores all
// root moves with a full (-inf,inf) window so every move gets an exact score (not
// just the best), and honours limits.Depth / MoveTime / Nodes via the shared stop
// machinery. Only the deepest FULLY-completed iteration is returned, so a partial
// iteration cut off by time can't leave some moves deeper than others.
func (s *Searcher) MultiPV(pos *chess.Position, limits Limits, gameHistory []uint64) []RootLine {
	s.tt.NewSearchAge()
	s.reset(limits, gameHistory)
	s.pushKey(pos.Key())
	s.nnueBegin(pos)

	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	n := ml.Len()
	if n == 0 {
		return nil
	}
	moves := make([]chess.Move, n)
	for i := 0; i < n; i++ {
		moves[i] = ml.Get(i)
	}

	maxDepth := limits.Depth
	if maxDepth <= 0 || maxDepth > maxPly {
		maxDepth = maxPly
	}

	// scoreAll scores every root move at one depth, returning the per-move results
	// and whether the whole iteration completed before the stop flag fired. When
	// force is set it ignores time (a guaranteed shallow pass so we always return
	// something even under a tiny budget).
	scoreAll := func(depth int, force bool) ([]RootLine, bool) {
		iter := make([]RootLine, n)
		for i, m := range moves {
			if !force && s.stop {
				return iter, false
			}
			var u chess.Undo
			if s.useNNUE {
				s.accPush(pos, m)
			}
			pos.DoMove(m, &u)
			s.pushKey(pos.Key())
			score := -s.negamax(pos, depth-1, 1, -infinity, infinity)
			pv := append([]chess.Move{m}, s.extractPV(pos, depth)...)
			s.popKey()
			pos.UndoMove(m, &u)
			if s.useNNUE {
				s.accPop()
			}
			if !force && s.stop {
				return iter, false // this move's score is unreliable — discard the iteration
			}
			iter[i] = RootLine{Move: m, Score: score, MateIn: mateDistance(score), PV: pv, Depth: depth}
		}
		return iter, true
	}

	var committed []RootLine
	for depth := 1; depth <= maxDepth; depth++ {
		iter, done := scoreAll(depth, false)
		if !done {
			break
		}
		committed = iter
	}
	if committed == nil {
		// Budget too small for even depth 1 to complete — force one shallow pass.
		s.stop = false
		committed, _ = scoreAll(1, true)
	}

	sort.SliceStable(committed, func(i, j int) bool { return committed[i].Score > committed[j].Score })
	return committed
}

func mateDistance(score int) int {
	if score > mateThreshold {
		return (mateScore - score + 1) / 2
	}
	if score < -mateThreshold {
		return -((mateScore + score + 1) / 2)
	}
	return 0
}

func (s *Searcher) negamax(pos *chess.Position, depth, ply, alpha, beta int) int {
	s.nodes++
	s.checkStop()
	if s.stop {
		return 0
	}
	if ply >= maxPly-1 {
		return s.evaluate(pos)
	}
	if ply > 0 && (pos.HalfmoveClock() >= 100 || s.isRepetition(pos)) {
		return 0
	}

	inCheck := pos.InCheck()
	if inCheck && s.params.CheckExtension {
		depth++ // check extension
	}
	if depth <= 0 {
		return s.quiescence(pos, ply, alpha, beta)
	}

	// excludedMove: set on a singular-extension verification search at this ply. Such
	// a node must not take a TT cutoff or store to the TT (its result describes the
	// move set minus the excluded move, not the full position).
	excludedMove := s.excluded[ply]

	// Transposition table probe.
	ttMove := chess.NullMove
	ttHit := false
	ttEvalCached := ttEvalNone
	ttDepth := 0
	ttFlag := ttNone
	ttScore := 0
	if e, ok := s.tt.probe(pos.Key()); s.params.UseTT && ok {
		ttMove = e.move
		ttHit = true
		ttEvalCached = e.eval
		ttDepth = int(e.depth)
		ttFlag = e.flag
		ttScore = e.scoreFromTT(ply)
		if ply > 0 && excludedMove == chess.NullMove && int(e.depth) >= depth {
			sc := e.scoreFromTT(ply)
			switch e.flag {
			case ttExact:
				return sc
			case ttLower:
				if sc >= beta {
					return sc
				}
			case ttUpper:
				if sc <= alpha {
					return sc
				}
			}
		}
	}

	// Internal iterative reduction: a deep node with no TT move has no good move to
	// search first, so a full-depth search wastes effort on poor ordering. Reduce a
	// ply — cheaper, and it seeds the TT with a move. Skipped inside a singular
	// verification (excludedMove set) so that search's depth stays intact.
	// PV-only: the all-nodes variant SPRT'd −33.7 Elo (over-broad). Standard IIR
	// fires on PV (and expected-cut) nodes; we have no cutnode flag, so PV-only
	// (beta-alpha > 1, same predicate as isPV computed below).
	if s.params.IIR && beta-alpha > 1 && depth >= iirMinDepth && ttMove == chess.NullMove &&
		excludedMove == chess.NullMove {
		depth--
	}

	// Syzygy WDL probe at internal nodes. Once enough pieces have come off that the
	// position is in tablebase range, return the EXACT game-theoretic value instead
	// of a heuristic eval — this extends the effective horizon all the way to the
	// ≤MaxPieces boundary, so a winning/drawn/losing trade-down is seen ~15 plies
	// early rather than guessed at. Root-only DTZ (engine.tablebaseMove) still owns
	// move selection when the ROOT itself is in range; this fires only for nodes
	// BELOW an out-of-range root (ply > 0). Skipped while in check (Fathom assumes
	// the side not to move isn't in check) and with castling rights (Syzygy assumes
	// none). The value is ply-adjusted so the search prefers faster wins / slower
	// losses; cursed-win/blessed-loss map to draw (rule50-independent, safe).
	if s.params.TBSearch && !s.weakenedSearch && s.tb != nil && ply > 0 && !inCheck &&
		!pos.HasCastlingRights() && pos.Occupied().Count() <= s.tbMax {
		if wdl, ok := s.tb.ProbeWDL(tbProbePosition(pos)); ok {
			switch wdl {
			case syzygy.WDLWin:
				return tbWin - ply
			case syzygy.WDLLoss:
				return -(tbWin - ply)
			default: // draw, cursed win, blessed loss → draw
				return 0
			}
		}
	}

	isPV := beta-alpha > 1

	// Static evaluation at this node (meaningless while in check); used by reverse
	// futility pruning and the "improving" heuristic. rawEval is the cacheable,
	// position-deterministic part; staticEval adds the fresh correction-history
	// shift on top (kept out of the TT so TTEval stays behavior-preserving).
	var staticEval, rawEval int
	if !inCheck {
		// TT static-eval cache: a TT hit that did not cut off (shallower depth, or
		// a bound that didn't prune) still carries this node's RAW static eval from a
		// prior visit. Reusing it skips the NNUE/HCE recompute. The raw eval is
		// deterministic, so the reused value equals a fresh one — speed only, no
		// behavior change (hence measured at movetime, gated for SPRT).
		if s.params.TTEval && ttHit && ttEvalCached != ttEvalNone {
			rawEval = int(ttEvalCached)
		} else {
			rawEval = s.rawEvaluate(pos)
		}
		staticEval = rawEval
		if s.params.CorrHist {
			staticEval += s.correction(pos) // applied fresh, never cached
			if s.params.CorrHistCont {
				staticEval += s.contCorrection(ply) // continuation keys (ply-2/-4)
			}
		}
		s.staticEvals[ply] = staticEval
	} else {
		s.staticEvals[ply] = evalNone
	}

	// "improving": is our static eval better than it was two plies ago (our last
	// turn)? A position trending our way warrants pruning less; default false when
	// unknown (in check, near the root, or after an in-check ancestor).
	improving := false
	if !inCheck && ply >= 2 && s.staticEvals[ply-2] != evalNone {
		improving = staticEval > s.staticEvals[ply-2]
	}
	impInt := 0
	if improving {
		impInt = 1
	}

	// Razoring: at a very shallow non-PV node, if the static eval plus a depth-scaled
	// margin still can't reach alpha, drop straight to quiescence; if qsearch confirms
	// the score is below alpha, fail low immediately. Guarded off the mate band.
	if s.params.Razor && !inCheck && !isPV && depth <= razorMaxDepth &&
		absInt(alpha) < mateThreshold && staticEval+razorMargin*depth < alpha {
		score := s.quiescence(pos, ply, alpha, beta)
		if s.stop {
			return 0
		}
		if score < alpha {
			return score
		}
	}

	// Reverse futility pruning (static null move): at a non-PV node near the
	// leaves, if the static eval beats beta by a depth-scaled margin even after
	// conceding that margin, fail high without searching. When improving, shave a
	// ply off the margin's depth term (a position trending up is likelier to hold).
	rfpDepth := depth
	if s.params.Improving {
		rfpDepth = depth - impInt
	}
	if s.params.RFP && !inCheck && !isPV && ply > 0 && depth <= rfpMaxDepth &&
		absInt(beta) < mateThreshold && staticEval-rfpMargin*rfpDepth >= beta {
		return staticEval - rfpMargin*rfpDepth
	}

	// Null-move pruning.
	if s.params.NullMove && !inCheck && depth >= 3 && ply > 0 && beta < mateThreshold &&
		pos.NonPawnMaterial(pos.SideToMove()) {
		s.dbgNullMoves++
		var u chess.Undo
		if s.useNNUE {
			s.accPushNull()
		}
		pos.DoNullMove(&u)
		s.pushKey(pos.Key())
		s.contMove[ply] = contEntry{} // null move: child has no continuation parent
		r := s.params.NullMoveR + depth/4
		sc := -s.negamax(pos, depth-1-r, ply+1, -beta, -beta+1)
		s.popKey()
		pos.UndoNullMove(&u)
		if s.useNNUE {
			s.accPop()
		}
		if s.stop {
			return 0
		}
		if sc >= beta {
			return beta
		}
	}

	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	if ml.Len() == 0 {
		if inCheck {
			return -mateScore + ply // checkmated
		}
		return 0 // stalemate
	}

	var scores [256]int
	s.scoreMoves(pos, &ml, ttMove, ply, &scores)

	// ProbCut: before searching the node properly, try good captures at a reduced
	// depth against a beta raised by a margin. If one already beats that raised beta,
	// the node is almost certainly a fail-high, so prune. Non-PV, deep enough, off the
	// mate band, never inside a singular verification. Scans captures linearly so it
	// does not disturb the main loop's lazy (selectMove) ordering.
	if s.params.ProbCut && !isPV && !inCheck && excludedMove == chess.NullMove &&
		depth >= probcutMinDepth && beta < tbThreshold-probcutMargin {
		probcutBeta := beta + probcutMargin
		probcutDepth := depth - probcutReduction
		if probcutDepth < 1 {
			probcutDepth = 1
		}
		for i := 0; i < ml.Len(); i++ {
			m := ml.Get(i)
			if !isCapture(pos, m) && m.Type() != chess.Promotion {
				continue
			}
			if s.params.SEE && !pos.SEEGE(m, 0) {
				continue // only winning/equal captures are worth a probcut try
			}
			mover := pos.PieceOn(m.From())
			var u chess.Undo
			if s.useNNUE {
				s.accPush(pos, m)
			}
			pos.DoMove(m, &u)
			s.pushKey(pos.Key())
			s.contMove[ply] = contEntry{pc: mover, to: m.To(), ok: true}
			// Cheap qsearch filter first, then confirm with a reduced-depth search.
			score := -s.quiescence(pos, ply+1, -probcutBeta, -probcutBeta+1)
			if score >= probcutBeta {
				score = -s.negamax(pos, probcutDepth, ply+1, -probcutBeta, -probcutBeta+1)
			}
			s.popKey()
			pos.UndoMove(m, &u)
			if s.useNNUE {
				s.accPop()
			}
			if s.stop {
				return 0
			}
			if score >= probcutBeta {
				return probcutBeta // fail high — prune the node
			}
		}
	}

	bestScore := -infinity
	bestMove := chess.NullMove
	origAlpha := alpha
	searched := 0

	// Quiet moves searched at this node (in order), so a beta cutoff can reward the
	// cutting quiet and penalize the earlier quiets that failed (HistMalus).
	var triedQuiets [256]chess.Move
	nQuiets := 0

	// Captures searched at this node (in order), so a capture beta cutoff can reward
	// the cutting capture and penalize earlier captures that failed (CaptHist).
	var triedCaptures [256]chess.Move
	nCaptures := 0

	// Late-move-pruning move-count limit. Improving lets more late quiets through
	// (2−improving halves the budget when the position is not trending our way).
	lmpLimit := 3 + depth*depth
	if s.params.Improving {
		lmpLimit = (3 + depth*depth) / (2 - impInt)
	}

	// Singular extension: if the TT move is, at a shallower search, much better than
	// every alternative, it is the only good move — extend it a ply so the one move
	// that matters isn't under-searched. We verify by searching all moves EXCEPT the
	// TT move (s.excluded[ply]) to a reduced depth in a null window just below the
	// TT score; if they all fail low the TT move is "singular". Conservative and
	// explosion-safe: depth-gated, single ply only, requires a deep-enough TT entry
	// with a lower/exact bound and a non-mate/non-TB score. extension is applied to
	// the TT move's search inside the loop (newDepth). When the verification itself
	// already beats beta with the TT move excluded, a second move is also good, so we
	// multi-cut (fail high) immediately.
	extension := 0
	if s.params.Singular && !inCheck && ply > 0 && excludedMove == chess.NullMove &&
		ttHit && ttMove != chess.NullMove && depth >= s.params.SingularMinDepth &&
		ttDepth >= depth-3 && (ttFlag == ttLower || ttFlag == ttExact) &&
		absInt(ttScore) < tbThreshold {
		singularBeta := ttScore - s.params.SingularMargin*depth
		rDepth := (depth - 1) / 2
		s.excluded[ply] = ttMove
		prevVerify := s.inSingularVerify
		s.inSingularVerify = true // CleanVerify: verify subtree uses conservative LMR
		singScore := s.negamax(pos, rDepth, ply, singularBeta-1, singularBeta)
		s.inSingularVerify = prevVerify
		s.excluded[ply] = chess.NullMove
		if s.stop {
			return 0
		}
		if singScore < singularBeta {
			// Double extension: the alternatives fail low by a wide margin, so the TT
			// move is very clearly the only good move — extend it 2 plies instead of 1.
			// Non-PV only (the !isPV gate + singularMinDepth are the search-explosion
			// guards). When DoubleExt is off this is byte-identical: extension = 1.
			if s.params.DoubleExt && !isPV && singScore < singularBeta-s.params.DoubleExtMargin {
				extension = 2
				s.dbgDoubleExt++
			} else {
				extension = 1
			}
			s.dbgSingular++
		} else if s.params.MultiCut && singularBeta >= beta {
			s.dbgMultiCut++
			return singularBeta // multi-cut: another move also beats beta
		}
	}

	for i := 0; i < ml.Len(); i++ {
		selectMove(&ml, &scores, i)
		m := ml.Get(i)
		if m == excludedMove { // singular verification: skip the move under test
			continue
		}
		capture := isCapture(pos, m) // before DoMove, while the victim is still on m.To()
		quiet := !capture && m.Type() != chess.Promotion
		mover := pos.PieceOn(m.From()) // captured before DoMove empties m.From()

		// Late move pruning: at a non-PV node near the leaves, once enough quiet
		// moves have been searched, skip the remaining late quiets (move ordering
		// puts them last, so they are almost never the best move). Never when in
		// check or when escaping a mate.
		if s.params.LMP && quiet && !isPV && !inCheck && searched > 0 &&
			depth <= lmpMaxDepth && bestScore > -mateThreshold &&
			searched >= lmpLimit {
			continue
		}

		// Frontier futility pruning: at a shallow non-PV node, skip a late quiet whose
		// static eval plus a depth-scaled margin still can't reach alpha — it almost
		// surely won't raise it. The fail-low counterpart to RFP. Quiet only (captures
		// /promotions excluded), never the first move, never when getting mated.
		if s.params.Futility && quiet && !isPV && !inCheck && searched > 0 &&
			depth <= futilityMaxDepth && bestScore > -mateThreshold &&
			staticEval+futilityMargin*depth <= alpha {
			continue
		}

		// History pruning: at a shallow non-PV node, skip a late quiet whose history
		// score is strongly negative — move ordering already ranked it last, and a very
		// negative history means it almost never raises alpha. Mirrors the LMR history
		// computation (butterfly + continuation history). The threshold grows more
		// negative with depth, so deeper nodes prune only the very worst quiets.
		if s.params.HistPrune && quiet && !isPV && !inCheck && searched > 0 &&
			depth <= histPruneMaxDepth && bestScore > -mateThreshold {
			hist := s.history[mover][m.To()]
			if s.params.ContHist && s.cont != nil {
				hist += s.contScore(ply, mover, m.To())
			}
			if hist < histPruneMargin*depth {
				s.dbgHistPrune++
				continue
			}
		}

		// Quiet-move SEE pruning: at a shallow non-PV node, skip a quiet move whose
		// Static Exchange Evaluation is strongly negative — the move puts a piece on a
		// square where it loses material to the opponent's recapture (it "hangs").
		// Move ordering already ranks such quiets low and at low depth they almost
		// never raise alpha. Orthogonal to LMP (move count), Futility (static eval) and
		// HistPrune (history magnitude) — this keys off whether the move hangs material.
		if s.params.SEEQuiet && quiet && !isPV && !inCheck && searched > 0 &&
			depth <= s.params.SEEQuietMaxDepth && bestScore > -mateThreshold {
			if !pos.SEEGE(m, -s.params.SEEQuietMargin*depth) {
				s.dbgSEEQuiet++
				continue
			}
		}

		// Capture-move SEE pruning: at a shallow non-PV node, skip a CAPTURE whose
		// Static Exchange Evaluation is strongly negative — a clearly-losing capture
		// that hangs material through the recapture sequence. Captures are already
		// SEE-ordered (losing ones last) and SEE-pruned in qsearch, but in the main
		// move loop a losing capture is still fully searched; this prunes the clearly-
		// losing tail at low depth. The capture analog of SEEQuiet (which fires only on
		// quiets) — restricted to genuine captures, never promotions (incl. capture-
		// promotions), so a promotion is never pruned here.
		if s.params.CaptSEE && capture && m.Type() != chess.Promotion && !isPV && !inCheck && searched > 0 &&
			depth <= s.params.CaptSEEMaxDepth && bestScore > -mateThreshold {
			if !pos.SEEGE(m, -s.params.CaptSEEMargin*depth) {
				s.dbgCaptSEE++
				continue
			}
		}

		var u chess.Undo
		if s.useNNUE {
			s.accPush(pos, m)
		}
		pos.DoMove(m, &u)
		s.pushKey(pos.Key())
		// Record the move played to descend into the child, so the child can key its
		// continuation history off this (and its grandparent) move.
		s.contMove[ply] = contEntry{pc: mover, to: m.To(), ok: true}
		givesCheck := pos.InCheck()

		// Singular extension applies to the TT move only (extension is 0 otherwise,
		// so newDepth == depth-1 and the off-path is byte-identical).
		newDepth := depth - 1
		if extension != 0 && m == ttMove {
			newDepth += extension
		}

		var sc int
		if searched == 0 {
			sc = -s.negamax(pos, newDepth, ply+1, -beta, -alpha)
		} else {
			reduction := 0
			// CleanVerify: while inside a singular verification subtree, fall back to
			// the conservative LMR path so over-reduced alternatives don't pollute the
			// singular decision. Inert unless LMR2 + CleanVerify are both on.
			if s.params.LMR2 && !(s.params.CleanVerify && s.inSingularVerify) {
				// Aggressive LMR: reduce earlier and in more cases (captures/promotions
				// too), adjusted by PV / improving / ordering-trust / SEE. The
				// zero-window re-search at full newDepth below catches over-reductions.
				minSearched := 2
				if !isPV {
					minSearched = 1
				}
				if depth >= 2 && !inCheck && !givesCheck && searched >= minSearched {
					r := lmrTable[minInt(depth, 63)][minInt(searched, 63)]
					if quiet {
						hist := s.history[mover][m.To()]
						if s.params.ContHist && s.cont != nil {
							hist += s.contScore(ply, mover, m.To())
						}
						r -= hist / lmrHistoryDiv
					} else {
						r-- // noisy move: reduce less than a quiet
						if s.params.SEE && isCapture(pos, m) && pos.SEEGE(m, 0) {
							r-- // winning/equal capture: reduce even less
						}
					}
					if isPV {
						r-- // PV nodes reduce less
					} else {
						r++ // non-PV nodes reduce more
					}
					if !improving {
						r++
					}
					if m == ttMove || m == s.killers[ply][0] || m == s.killers[ply][1] {
						r-- // don't over-reduce ordering-trusted moves
					}
					if maxR := newDepth - 1; maxR >= 1 {
						if r < 1 {
							r = 1
						}
						if r > maxR {
							r = maxR
						}
						reduction = r
					}
				}
			} else if s.params.LMR && depth >= 3 && quiet && !inCheck && !givesCheck && searched >= 4 {
				if s.params.LMRFormula {
					// Smooth log(d)·log(m) base in place of the flat 1/2; reduce
					// less for good-history quiets, more for malus'd ones. Clamped
					// to [1, depth-1] so a reduced move still searches ≥1 ply.
					r := lmrTable[minInt(depth, 63)][minInt(searched, 63)]
					hist := s.history[mover][m.To()]
					if s.params.ContHist && s.cont != nil {
						hist += s.contScore(ply, mover, m.To())
					}
					r -= hist / lmrHistoryDiv
					if r < 1 {
						r = 1
					}
					if r > depth-1 {
						r = depth - 1
					}
					reduction = r
				} else {
					reduction = 1
					if searched >= 8 {
						reduction = 2
					}
				}
			}
			sc = -s.negamax(pos, newDepth-reduction, ply+1, -alpha-1, -alpha)
			if sc > alpha && reduction > 0 {
				sc = -s.negamax(pos, newDepth, ply+1, -alpha-1, -alpha)
			}
			if sc > alpha && sc < beta {
				sc = -s.negamax(pos, newDepth, ply+1, -beta, -alpha)
			}
		}

		s.popKey()
		pos.UndoMove(m, &u)
		if s.useNNUE {
			s.accPop()
		}
		if s.stop {
			return 0
		}
		searched++
		if quiet {
			triedQuiets[nQuiets] = m
			nQuiets++
		} else if s.params.CaptHist && capture {
			triedCaptures[nCaptures] = m
			nCaptures++
		}

		if sc > bestScore {
			bestScore = sc
			bestMove = m
			if ply == 0 {
				s.rootBest = m
				s.rootScore = sc
			}
			if sc > alpha {
				alpha = sc
				if alpha >= beta {
					if quiet {
						s.recordKiller(ply, m)
						s.updateQuietStats(pos, m, triedQuiets[:nQuiets], depth)
						s.updateContHist(pos, m, triedQuiets[:nQuiets], depth, ply)
					} else if s.params.CaptHist && capture {
						s.updateCaptureStats(pos, m, triedCaptures[:nCaptures], depth)
					}
					break
				}
			}
		}
	}

	flag := ttExact
	if bestScore <= origAlpha {
		flag = ttUpper
	} else if bestScore >= beta {
		flag = ttLower
	}

	// A singular-verification node (excludedMove set) describes only the restricted
	// move set, so it must neither teach correction history nor write the TT.
	if excludedMove != chess.NullMove {
		return bestScore
	}

	// Correction history update: teach the tables the static-eval-vs-search error at
	// this node. Only when the signal is trustworthy: out of check (static defined),
	// a non-noisy best move (not a capture/promotion), a non-mate/non-TB score, and
	// the bound agrees with the direction of the error (an exact score always; a
	// lower bound only if search beat static; an upper bound only if it fell short).
	if s.params.CorrHist && !inCheck && bestMove != chess.NullMove &&
		absInt(bestScore) < tbThreshold {
		dir := flag == ttExact ||
			(flag == ttLower && bestScore > staticEval) ||
			(flag == ttUpper && bestScore < staticEval)
		if dir && !isCapture(pos, bestMove) && bestMove.Type() != chess.Promotion {
			s.updateCorrHist(pos, staticEval, bestScore, depth, ply)
		}
	}

	if s.params.UseTT {
		// Cache the RAW static eval (ttEvalNone when in check, or when it falls
		// outside the int16 band — a real static eval never does, but a corrupt
		// truncation would feed RFP a bogus value, so we simply don't cache it). The
		// corrhist correction is intentionally NOT cached (see rawEvaluate).
		ev := ttEvalNone
		if !inCheck && rawEval > -32000 && rawEval < 32000 {
			ev = int16(rawEval)
		}
		s.tt.store(pos.Key(), bestMove, bestScore, depth, ply, flag, ev)
	}
	return bestScore
}

func (s *Searcher) quiescence(pos *chess.Position, ply, alpha, beta int) int {
	s.nodes++
	s.dbgQNodes++
	s.checkStop()
	if s.stop {
		return 0
	}
	if ply >= maxPly-1 {
		return s.evaluate(pos)
	}

	inCheck := pos.InCheck()
	standPat := 0
	if !inCheck {
		standPat = s.evaluate(pos)
		if standPat >= beta {
			return beta
		}
		if standPat > alpha {
			alpha = standPat
		}
	}

	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	if ml.Len() == 0 {
		if inCheck {
			return -mateScore + ply
		}
		return alpha
	}

	var scores [256]int
	s.scoreMoves(pos, &ml, chess.NullMove, ply, &scores)

	for i := 0; i < ml.Len(); i++ {
		selectMove(&ml, &scores, i)
		m := ml.Get(i)
		// Out of check, search only captures/promotions; in check, all evasions.
		if !inCheck && !isCapture(pos, m) && m.Type() != chess.Promotion {
			continue
		}
		// SEE pruning: out of check, skip captures that lose material outright.
		if !inCheck && s.params.SEE && isCapture(pos, m) && m.Type() != chess.Promotion &&
			pos.SEE(m) < 0 {
			continue
		}
		// Delta pruning: out of check, skip a capture that even in the best case
		// (winning the victim plus a margin) cannot raise alpha.
		if !inCheck && s.params.DeltaPrune && isCapture(pos, m) && m.Type() != chess.Promotion {
			if standPat+captureGain(pos, m)+deltaMargin <= alpha {
				continue
			}
		}
		var u chess.Undo
		if s.useNNUE {
			s.accPush(pos, m)
		}
		pos.DoMove(m, &u)
		sc := -s.quiescence(pos, ply+1, -beta, -alpha)
		pos.UndoMove(m, &u)
		if s.useNNUE {
			s.accPop()
		}
		if s.stop {
			return 0
		}
		if sc >= beta {
			return beta
		}
		if sc > alpha {
			alpha = sc
		}
	}
	return alpha
}

func (s *Searcher) extractPV(pos *chess.Position, maxLen int) []chess.Move {
	pv := make([]chess.Move, 0, maxLen)
	p := *pos // Position is a value type (arrays only) → cheap copy
	seen := make(map[uint64]bool, maxLen)
	for len(pv) < maxLen {
		e, ok := s.tt.probe(p.Key())
		if !ok || e.move == chess.NullMove || seen[p.Key()] {
			break
		}
		seen[p.Key()] = true
		var ml chess.MoveList
		p.GenerateLegal(&ml)
		legal := false
		for i := 0; i < ml.Len(); i++ {
			if ml.Get(i) == e.move {
				legal = true
				break
			}
		}
		if !legal {
			break
		}
		pv = append(pv, e.move)
		var u chess.Undo
		p.DoMove(e.move, &u)
	}
	return pv
}
