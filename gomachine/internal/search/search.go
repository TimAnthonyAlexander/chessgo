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

// lmrTable1024[depth][moveCount] is the SAME log(d)·log(m) surface as lmrTable but
// stored in ×1024 fixed-point (the SF18/Stormphrax representation): the reduction in
// 1024ths of a ply rather than truncated whole plies. Used only by the default-off
// Params.LMRFixedPoint path, where a fine-grained table lets SPSA move lmrbase/lmrdiv
// meaningfully (an integer table flips only a handful of cells per small perturbation).
var lmrTable1024 [64][64]int

func init() {
	for d := 1; d < 64; d++ {
		for m := 1; m < 64; m++ {
			lmrTable[d][m] = int(0.7844 + math.Log(float64(d))*math.Log(float64(m))/2.4696)
			lmrTable1024[d][m] = int(1024.0 * (0.7844 + math.Log(float64(d))*math.Log(float64(m))/2.4696))
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
	singularMinDepth = 5 // re-tuned 6→5 (2026-07-08 mirror-KB SPSA snapshot, adopted as new base) — tracks DefaultParams.SingularMinDepth (guarded by TestSingularParamsPreserveDefault)
	singularMargin   = 2
	// Internal iterative reduction (Params.IIR): at a node this deep with no TT
	// move to guide ordering, search a ply shallower (seeds the TT, cheaper redo).
	iirMinDepth = 4
	// Frontier futility pruning (Params.Futility): max depth it applies at. A late
	// quiet is skipped when staticEval + FutilityBase + FutilitySlope·depth ≤ alpha
	// (it almost surely can't raise alpha). The margin is now the tunable
	// base+slope pair Params.FutilityBase/FutilitySlope (defaults 0/100, so it
	// reproduces the historical futilityMargin·depth = 100·depth exactly).
	futilityMaxDepth = 6
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
func (s *Searcher) statBonus(depth int) int {
	b := s.params.HistBonusScale * depth * depth
	if b > s.params.HistBonusMax {
		b = s.params.HistBonusMax
	}
	return b
}

// statMalus is the depth-scaled history MALUS magnitude (capped), decoupled from
// statBonus so the penalty applied to searched-but-not-cutoff quiets can be tuned
// separately (SF18/Stormphrax both do). Mirrors statBonus but off HistMalusScale/
// HistMalusMax. DEFAULT: HistMalus{Scale,Max} == HistBonus{Scale,Max}, so
// statMalus == statBonus exactly → the malus sites are byte-identical until tuned.
func (s *Searcher) statMalus(depth int) int {
	b := s.params.HistMalusScale * depth * depth
	if b > s.params.HistMalusMax {
		b = s.params.HistMalusMax
	}
	return b
}

// updateHistory applies the "history gravity" update: the entry is nudged toward
// ±maxHistory by bonus, with a pull proportional to the current magnitude, so the
// table self-ages (old evidence decays as new arrives) and stays bounded.
func (s *Searcher) updateHistory(pc chess.Piece, to chess.Square, bonus int) {
	maxHist := s.params.MaxHistory
	if bonus > maxHist {
		bonus = maxHist
	} else if bonus < -maxHist {
		bonus = -maxHist
	}
	e := &s.history[pc][to]
	*e += bonus - (*e)*absInt(bonus)/maxHist
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
	bonus := s.statBonus(depth)
	malus := s.statMalus(depth)
	s.updateHistory(pos.PieceOn(best.From()), best.To(), bonus)
	for _, q := range tried {
		if q != best {
			s.updateHistory(pos.PieceOn(q.From()), q.To(), -malus)
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
	maxHist := s.params.MaxHistory
	if bonus > maxHist {
		bonus = maxHist
	} else if bonus < -maxHist {
		bonus = -maxHist
	}
	pc := pos.PieceOn(m.From())
	e := &s.captureHist[pc][m.To()][captureVictim(pos, m)]
	*e += bonus - (*e)*absInt(bonus)/maxHist
}

// updateCaptureStats credits a capture that caused a beta cutoff (+bonus) and
// penalizes the captures tried before it that did not (−bonus), using the gravity
// scheme. pos must be restored to the node position (after UndoMove).
func (s *Searcher) updateCaptureStats(pos *chess.Position, best chess.Move, tried []chess.Move, depth int) {
	bonus := s.statBonus(depth)
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
	MoveTime time.Duration // fixed time budget (0 → none); used when no clock info
	Nodes    uint64        // optional node cap (0 → none)

	// Clock-aware time management: when TimeLeft>0, the search computes adaptive
	// soft/hard limits from the game clock instead of using the flat MoveTime.
	TimeLeft  time.Duration // remaining time on our clock (0 → use MoveTime)
	Increment time.Duration // per-move increment (0 → none)
	MovesToGo int           // moves until next time control (0 → sudden death)
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
	tt     *TT
	params Params
	ec     eval.Config // evaluation config derived from params
	// lmr is the late-move reduction table this searcher reads (log·log surface). It
	// points at the shared package default (lmrTable) when the LMR params are default,
	// or a per-searcher table built from Params.LMRBaseX10k/LMRDivX10k otherwise. Read-
	// only after construction, so it is safe to share across Lazy SMP workers.
	lmr *[64][64]int
	// lmr1024 is the ×1024 fixed-point LMR table read only by the default-off
	// Params.LMRFixedPoint path; nil/unused on the integer OFF path. Read-only after
	// construction, so it is safe to share across Lazy SMP workers.
	lmr1024 *[64][64]int
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
	tm          timeManager
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

	rootBest      chess.Move
	rootScore     int
	rootBestNodes uint64 // nodes spent in the best root move's subtree this iteration (NodeTM)

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

	// Per-searcher NNUE net overrides. When ANY is non-nil, nnueBegin uses these
	// three (with the usual enriched>multi>single precedence) INSTEAD of the process
	// globals — so the self-play harness gives each side its own net and a net A/B
	// runs at Concurrency>1 without a shared global swap (each engine's searcher
	// carries its own net; globals become read-only after startup). All three nil ⇒
	// read the globals (prod serve/hub, and param-only A/B share one startup default).
	// Set via SetNetOverride before search; propagated to Lazy-SMP workers.
	netOverride      *nnue.Net
	multiOverride    *nnue.MultiNet
	enrichedOverride *nnue.EnrichedNet

	// Diagnostic counters (cheap, like nodes) — used by tests to confirm the
	// accumulator gate actually covered null-move and quiescence nodes, and that the
	// singular-extension paths fire.
	dbgNullMoves uint64
	dbgQNodes    uint64
	dbgSingular  uint64 // singular extensions applied (TT move extended a ply)
	dbgTTMFFires uint64 // TTMoveFirst: TT move found in move list (pre-search attempted)
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

	// Stormphrax-style continuation history (Params.ContHist2). cont2 holds the four
	// keyed tables (offsets 1/2/4/6; allocated only when ContHist2 is on) and reuses
	// the shared contMove path stack above. Per-Searcher (per SMP worker), cleared
	// per-search in reset() — same ownership/lifecycle as cont. See conthist2.go.
	cont2 *contHist2

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

	// capBuf / quietBuf are the staged move-picker's per-ply scratch buffers
	// (Params.DeferredQuiets only). scoreCaptures fills capBuf[ply] with the
	// scored captures/promotions; stage 3 fills quietBuf[ply] with the scored
	// quiets. Per-ply indexing means recursion never clobbers a live buffer, and
	// Searcher ownership means no per-node heap allocation (the alloc that made
	// the deferred path slower with no ordering win). Lazily allocated on the
	// first deferred node so the OFF path (the shipping default) never touches
	// them — they stay two nil pointers and cost nothing.
	capBuf   *[maxPly][256]capEntry
	quietBuf *[maxPly][256]capEntry
}

// DbgNullMoves and DbgQNodes report how many null-move and quiescence nodes the
// last search executed (test/diagnostic only).
func (s *Searcher) DbgNullMoves() uint64 { return s.dbgNullMoves }
func (s *Searcher) DbgQNodes() uint64    { return s.dbgQNodes }

// DbgSingular and DbgMultiCut report how many singular extensions and singular
// multi-cuts the last search performed (test/diagnostic only).
func (s *Searcher) DbgSingular() uint64  { return s.dbgSingular }
func (s *Searcher) DbgTTMFFires() uint64 { return s.dbgTTMFFires }
func (s *Searcher) DbgMultiCut() uint64  { return s.dbgMultiCut }

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
	shift := params.TTBucketShift
	if shift < 0 {
		shift = 0
	}
	return &Searcher{
		tt:       NewTT(ttSizeMB, uint(shift)),
		params:   params,
		ec:       evalConfig(params),
		lmr:      lmrTableFor(params),
		lmr1024:  lmrTable1024For(params),
		keyStack: make([]uint64, 0, 1024),
	}
}

// lmrTableFor returns the LMR reduction table for these params: the shared package
// default when LMR base/divisor are at their defaults (zero alloc, byte-identical),
// else a freshly built per-searcher table. base/div are stored ×10000 so the default
// (7844/24696) reproduces int(0.7844 + ln·ln/2.4696) exactly.
func lmrTableFor(p Params) *[64][64]int {
	if p.LMRBaseX10k == 7844 && p.LMRDivX10k == 24696 {
		return &lmrTable
	}
	base := float64(p.LMRBaseX10k) / 10000
	div := float64(p.LMRDivX10k) / 10000
	t := new([64][64]int)
	for d := 1; d < 64; d++ {
		for m := 1; m < 64; m++ {
			t[d][m] = int(base + math.Log(float64(d))*math.Log(float64(m))/div)
		}
	}
	return t
}

// lmrTable1024For is lmrTableFor's ×1024 fixed-point twin (SF/Stormphrax): the shared
// package default when base/div are default, else a per-searcher table. Read only by the
// default-off Params.LMRFixedPoint path.
func lmrTable1024For(p Params) *[64][64]int {
	if p.LMRBaseX10k == 7844 && p.LMRDivX10k == 24696 {
		return &lmrTable1024
	}
	base := float64(p.LMRBaseX10k) / 10000
	div := float64(p.LMRDivX10k) / 10000
	t := new([64][64]int)
	for d := 1; d < 64; d++ {
		for m := 1; m < 64; m++ {
			t[d][m] = int(1024.0 * (base + math.Log(float64(d))*math.Log(float64(m))/div))
		}
	}
	return t
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
	var e int
	if s.useNNUE {
		e = s.accEval(pos)
	} else {
		e = eval.Evaluate(pos, s.ec)
	}
	// Aggression style knob (Params.Aggr): add a scaled fraction of the king-attack
	// pressure term onto the static eval. Aggr==50 (default) skips this entirely, so
	// the engine stays byte-identical; >50 biases toward attacking play, <50 solid.
	if s.params.Aggr != 50 {
		e += eval.AggressionTerm(pos) * (s.params.Aggr - 50) / 50
	}
	return e
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

// SetNetOverride installs this searcher's per-side NNUE nets, used by nnueBegin
// INSTEAD of the process globals (enriched>multi>single precedence; all-nil ⇒ read
// the globals). The self-play harness sets each engine's own net so a net A/B runs
// at Concurrency>1 without a shared global swap. Idempotent; propagated to Lazy-SMP
// workers when they spawn.
func (s *Searcher) SetNetOverride(n *nnue.Net, m *nnue.MultiNet, en *nnue.EnrichedNet) {
	s.netOverride, s.multiOverride, s.enrichedOverride = n, m, en
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
	// Prefer this searcher's per-side net overrides (set by the A/B harness); when it
	// carries none, read the process globals (prod serve/hub, param-only A/B). This is
	// the ONLY net read in search — the harness never swaps a global mid-run, so nets
	// stay effectively read-only and concurrent games can't race.
	en, m, net := s.enrichedOverride, s.multiOverride, s.netOverride
	if en == nil && m == nil && net == nil {
		en, m, net = nnue.DefaultEnriched(), nnue.DefaultMulti(), nnue.Default()
	}
	// An enriched (threats) net, if installed, takes precedence and drives its own
	// incremental accumulator (enrichedStack), shadowing accStack at the push/pop
	// sites. enrichedStackCache keeps the allocation across searches.
	if en != nil {
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
	if m != nil {
		if s.multiStackCache == nil || s.multiStackCache.Net() != m {
			s.multiStackCache = m.NewStack(maxPly + 8)
		}
		s.multiStack = s.multiStackCache
		s.multiStack.Reset(pos)
		s.useNNUE = true
		return
	}
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
		lmr:      lmrTableFor(params),
		lmr1024:  lmrTable1024For(params),
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
	s.dbgTTMFFires = 0
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
	s.contBegin()  // continuation history: clear tables + path, per-search like butterfly
	s.cont2Begin() // Stormphrax-style continuation history: clear its tables (after contBegin resets the shared path)
	s.tm = tmFromLimits(limits)
	s.useTime = s.tm.hasTime()
	s.nodeCap = limits.Nodes
	s.keyStack = append(s.keyStack[:0], gameHistory...)
	s.rootBest = chess.NullMove
	s.rootScore = 0
}

func (s *Searcher) pushKey(k uint64) {
	if s.params.Prefetch && s.tt != nil {
		s.tt.prefetch(k)
	}
	s.keyStack = append(s.keyStack, k)
}
func (s *Searcher) popKey() { s.keyStack = s.keyStack[:len(s.keyStack)-1] }

func (s *Searcher) checkStop() {
	if s.stop {
		return
	}
	if s.useTime && s.nodes&2047 == 0 && s.tm.hardExpired() {
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
			// Inherit the coordinator's per-side net overrides so every SMP worker
			// evaluates with the same net (worker 0 is s, already has them).
			worker.netOverride, worker.multiOverride, worker.enrichedOverride = s.netOverride, s.multiOverride, s.enrichedOverride
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
	prevScore := 0
	for d := 1; d <= maxDepth; d++ {
		iterStartNodes := s.nodes
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
			break
		}
		if s.useTime {
			// Track best-move stability and score drops for adaptive time.
			s.tm.updateBestMove(uint32(s.rootBest))
			if d > 1 {
				drop := prevScore - s.rootScore
				if drop > 0 {
					s.tm.scoreDropExtend(drop)
				}
			}
			prevScore = s.rootScore
			// Node-based time scaling: redistribute time by how concentrated the
			// search was on the best root move (composes on top of stability /
			// score-drop). Inert unless NodeTM is on.
			if s.params.NodeTM && s.rootBestNodes > 0 {
				if iterNodes := s.nodes - iterStartNodes; iterNodes > 0 {
					s.tm.applyNodeTm(float64(s.rootBestNodes) / float64(iterNodes))
				}
			}
			if s.tm.softExpired() {
				break
			}
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
		s.negamax(pos, depth, 0, -infinity, infinity, false) // root is a PV node → non-cut
		return
	}
	delta := s.params.AspInitDelta
	if s.params.AspVariance {
		// base + |prevScore|²·scale/2²⁰ (Stormphrax aspSqScoreScale form; SF sizes
		// the window by meanSquaredScore/10588). int64 square: prevScore is bounded
		// below mateThreshold here, but prevScore²·scale overflows int32.
		delta = s.params.AspBaseDelta + int((int64(prevScore)*int64(prevScore)*int64(s.params.AspVarScale))>>20)
		if delta > aspMaxDelta {
			delta = aspMaxDelta
		}
	}
	alpha := maxInt(prevScore-delta, -infinity)
	beta := minInt(prevScore+delta, infinity)
	failHighCnt := 0 // fail-highs so far this iteration (AspFailHighReduce only)
	for {
		searchDepth := depth
		if s.params.AspFailHighReduce && failHighCnt > 0 {
			searchDepth = maxInt(depth-failHighCnt, 1) // SF adjustedDepth: reduce re-search by the fail-high count
		}
		score := s.negamax(pos, searchDepth, 0, alpha, beta, false) // root is a PV node → non-cut
		if s.stop {
			return
		}
		switch {
		case score <= alpha: // fail low: lower alpha, pull beta toward center
			beta = (alpha + beta) / 2
			alpha = maxInt(score-delta, -infinity)
			if s.params.AspFailHighReduce {
				failHighCnt = 0 // SF: a fail-low clears the fail-high count
			}
		case score >= beta: // fail high: raise beta
			beta = minInt(score+delta, infinity)
			if s.params.AspFailHighReduce && failHighCnt < 3 {
				failHighCnt++ // capped at 3 (Stormphrax aspReduction cap)
			}
		default:
			return // score inside the window
		}
		if s.params.AspWidenGrow {
			delta = delta * s.params.AspWidenNum / s.params.AspWidenDen
			if delta > aspMaxDelta {
				delta = aspMaxDelta
			}
		} else {
			delta += delta
		}
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
		score := -s.negamax(pos, depth-1, 1, -infinity, infinity, false) // full-window root child → non-cut
		s.popKey()
		pos.UndoMove(m, &u)
		if s.useNNUE {
			s.accPop()
		}
		out = append(out, RootMove{Move: m, Score: score})
	}
	return out
}

// RootNearBest powers the FAST weakened-bot ranking (the opt-in rating path used
// by Guess-the-Elo generation). Instead of RootScores' full-window search of EVERY
// root move at the rating's depth — which is O(moves × depth) and balloons to
// seconds per move at high-but-still-weakened ratings — it does two cheap steps:
//
//  1. One normal search to limits.Depth (honoring MoveTime) for the best move + its
//     score at the depth actually reached. Single-PV, warms the TT.
//  2. A margin scan: null-window-test every OTHER root move against
//     (bestScore - margin) at that same depth. The many clearly-worse moves fail
//     low cheaply (and are dropped); only genuine near-best alternatives clear the
//     window and get an exact re-search. `margin` should track the rating's eval
//     noise, so exactly the moves the noise could plausibly promote survive.
//
// The result is the best move plus the near-best alternatives (best at index 0),
// each with a score at the reached depth — enough for the caller to jitter + pick.
// weakenedSearch suppresses the WDL probe throughout, like RootScores, so a leveled
// bot doesn't suddenly convert ≤MaxPieces endings perfectly. Scores are from the
// root side-to-move's perspective.
func (s *Searcher) RootNearBest(pos *chess.Position, limits Limits, margin int, gameHistory []uint64) []RootMove {
	s.weakenedSearch = true
	defer func() { s.weakenedSearch = false }()

	// Step 1: full-strength best move + score at the target budget (ID; warms TT).
	res := s.Search(pos, limits, gameHistory)
	if res.BestMove == chess.NullMove {
		return nil
	}
	best := RootMove{Move: res.BestMove, Score: res.Score}
	if margin <= 0 {
		return []RootMove{best}
	}

	// Scan at the depth actually reached in step 1, so best + alternatives are
	// scored consistently (and the scan cost tracks the same depth).
	depth := res.Depth
	if depth < 1 {
		depth = 1
	}

	// Step 2: margin scan over the remaining root moves, reusing the now-warm TT.
	// Depth-bounded and cheap (few candidates clear the window), so run it without a
	// clock so a partial iteration can't leave a candidate with an unreliable score.
	s.reset(limits, gameHistory)
	s.useTime = false
	s.nodeCap = 0
	s.pushKey(pos.Key())
	s.nnueBegin(pos)

	threshold := res.Score - margin
	alts := make([]RootMove, 0, 8)
	alts = append(alts, best)

	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		if m == best.Move {
			continue
		}
		var u chess.Undo
		if s.useNNUE {
			s.accPush(pos, m)
		}
		pos.DoMove(m, &u)
		s.pushKey(pos.Key())
		// Null-window test: is our score for m above the threshold? Search the child
		// around (threshold, threshold+1) from our perspective; re-search exact only
		// if it clears the bar (a real near-best alternative).
		score := -s.negamax(pos, depth-1, 1, -(threshold + 1), -threshold, false)
		if score > threshold {
			score = -s.negamax(pos, depth-1, 1, -infinity, infinity, false)
		}
		s.popKey()
		pos.UndoMove(m, &u)
		if s.useNNUE {
			s.accPop()
		}
		if score > threshold {
			alts = append(alts, RootMove{Move: m, Score: score})
		}
	}
	return alts
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
			score := -s.negamax(pos, depth-1, 1, -infinity, infinity, false) // full-window root child → non-cut
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

// multicutFailFirmT mirrors Stormphrax's multicutFailFirmT tunable (503 of 1024):
// the blend weight used by the SOFTENED singular multicut return (Params.NegExt).
const multicutFailFirmT = 503

// ilerpToBeta blends a (non-decisive) singular-verification score toward beta with
// weight multicutFailFirmT/1024, mirroring Stormphrax's
// util::ilerp<1024>(score, beta, multicutFailFirmT()) softened-multicut return
// ((a*(kOne-t) + b*t)/kOne with a=score, b=beta, t=503, kOne=1024). Used only by
// the NegExt-gated soft multicut, so it is inert when NegExt is off.
func ilerpToBeta(score, beta int) int {
	return ilerpT(score, beta, multicutFailFirmT)
}

// rfpFailFirmT mirrors Stormphrax's rfpFailFirmT tunable (711 of 1024): the blend
// weight for the SOFT reverse-futility return (Params.RFPSoft), so the pruned
// score is nudged toward beta instead of a hard staticEval-margin.
const rfpFailFirmT = 711

// ilerpT blends score toward beta with weight t/1024 (Stormphrax util::ilerp<1024>).
func ilerpT(score, beta, t int) int {
	return (score*(1024-t) + beta*t) / 1024
}

// negamax is the core alpha-beta search. cutnode is the expected-node-type flag
// (Stormphrax-style): true at a node we expect to fail high (a zero-window scout
// child of a PV/all node), false at the root, PV nodes, and full-window
// re-searches. It is COMPUTED and threaded at every recursive call site but only
// CONSUMED by the Params.NegExt-gated negative-extension / soft-multicut logic, so
// with NegExt off the whole cutnode plumbing is behavior-neutral (byte-identical).
func (s *Searcher) negamax(pos *chess.Position, depth, ply, alpha, beta int, cutnode bool) int {
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
		// TTCutoffNonPV (SF search.cpp:760): gate the early TT cutoff RETURN to non-PV
		// nodes (isPV == beta-alpha > 1). We still keep the probed move/eval/bound for
		// ordering, TTRefinesEval and singular; only the early return is suppressed at PV.
		if ply > 0 && excludedMove == chess.NullMove && int(e.depth) >= depth &&
			(!s.params.TTCutoffNonPV || beta-alpha <= 1) {
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
	iirPV := beta-alpha > 1
	iirTrig := ttMove == chess.NullMove
	if s.params.IIRCutnode {
		// Broaden IIR to cut-nodes and to shallow TT hits (Stormphrax search.cpp:769):
		// fire at PV OR cutnode, when the TT move is missing OR too shallow to trust.
		iirPV = iirPV || cutnode
		iirTrig = ttMove == chess.NullMove || (ttHit && ttDepth+3 < depth)
	}
	if s.params.IIR && iirPV && depth >= iirMinDepth && iirTrig &&
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
	if s.params.ImprovingRich {
		// Richer improving (Stormphrax/SF): ply-2 comparison, then a ply-4 fallback we
		// currently lack, defaulting TRUE when neither ancestor eval is known, plus the
		// SF `improving |= eval>=beta` upgrade. In check stays false (unchanged).
		if inCheck {
			improving = false
		} else if ply >= 2 && s.staticEvals[ply-2] != evalNone {
			improving = staticEval > s.staticEvals[ply-2]
		} else if ply >= 4 && s.staticEvals[ply-4] != evalNone {
			improving = staticEval > s.staticEvals[ply-4]
		} else {
			improving = true
		}
		if !inCheck {
			improving = improving || staticEval >= beta
		}
	} else if !inCheck && ply >= 2 && s.staticEvals[ply-2] != evalNone {
		improving = staticEval > s.staticEvals[ply-2]
	}
	impInt := 0
	if improving {
		impInt = 1
	}

	// TTRefinesEval (SF search.cpp:730-732): when the TT bound is consistent, the
	// stored search score is a sharper position estimate than the static eval — use
	// it as the `staticEval` that RFP / null-move / futility key off. Placed AFTER the
	// improving computation (which keeps using the un-refined corrhist-corrected eval,
	// matching SF's ss->staticEval vs eval split) and s.staticEvals[ply] is left as the
	// corrected value, so future plies' improving is unaffected. Off-path byte-identical.
	if s.params.TTRefinesEval && !inCheck && ttHit &&
		((ttFlag == ttLower && ttScore > staticEval) ||
			(ttFlag == ttUpper && ttScore < staticEval) ||
			ttFlag == ttExact) {
		staticEval = ttScore
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
	rfpCap := s.params.RFPMaxDepth
	rfpM := s.params.RFPMargin * rfpDepth
	if s.params.RFPQuad {
		rfpCap = 12
		rfpM = 85*depth + 7*depth*depth - 75*impInt // Stormphrax quadratic margin
	}
	if s.params.RFP && !inCheck && !isPV && ply > 0 && depth <= rfpCap &&
		absInt(beta) < mateThreshold && staticEval-rfpM >= beta {
		if s.params.RFPSoft {
			// Soft fail-firm: nudge the returned score toward beta (Stormphrax
			// rfpFailFirmT) instead of returning the full static margin.
			return ilerpT(staticEval-rfpM, beta, rfpFailFirmT)
		}
		return staticEval - rfpM
	}

	// Null-move pruning. The NmpGate threshold is normally beta; NmpMargin raises
	// it to beta + a depth/improving-scaled margin (Stormphrax nmpBetaMargin) so
	// null-move only fires when the static eval clears beta by a real margin.
	nmpThresh := beta
	if s.params.NmpMargin {
		nmpThresh = beta + s.params.NmpMarginBase - depth*10 - impInt*41
	}
	if s.params.NullMove && !inCheck && depth >= 3 && ply > 0 && beta < mateThreshold &&
		(!s.params.NmpGate || staticEval >= nmpThresh) &&
		(!s.params.NMPNonPV || !isPV) && // SF search.cpp:893: NMP only at non-PV (cut) nodes
		pos.NonPawnMaterial(pos.SideToMove()) {
		s.dbgNullMoves++
		var u chess.Undo
		if s.useNNUE {
			s.accPushNull()
		}
		pos.DoNullMove(&u)
		s.pushKey(pos.Key())
		s.contMove[ply] = contEntry{} // null move: child has no continuation parent
		r := s.params.NullMoveR + depth/s.params.NMPDepthDiv
		if s.params.NmpGate {
			add := (staticEval - beta) / s.params.NmpEvalDivisor
			if add > s.params.NMPEvalCap {
				add = s.params.NMPEvalCap
			}
			if add < 0 {
				add = 0
			}
			r += add
		}
		sc := -s.negamax(pos, depth-1-r, ply+1, -beta, -beta+1, !cutnode) // null-move child: opposite node type (Stormphrax search.cpp:890)
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

	// Declared before scoreMoves so TTMoveFirst can pre-search the TT move
	// and record its result here (skipped in the main loop on non-cutoff).
	var ttFirstSearched bool
	var ttFirstIdx int = -1
	var alphaRaises int
	var bestScore int = -infinity
	var bestMove chess.Move = chess.NullMove
	origAlpha := alpha
	var searched int
	var triedQuiets [256]chess.Move
	var nQuiets int
	var triedCaptures [256]chess.Move
	var nCaptures int

	// ttMoveNoisy is used by quiet-stage LMR terms; declared here so both
	// the DeferredQuiets=on and off paths can read it.
	ttMoveNoisy := ttMove != chess.NullMove && isCapture(pos, ttMove)
	flag := ttExact

	// TTMoveFirst: try the TT move before scoring any other moves.
	// NOT byte-identical: searching the TT move here mutates history tables
	// that scoreMoves reads → different move-order scores → different tree.
	// Kept behind the flag as scaffolding for deferred quiet scoring (#4).
	// On a beta cutoff (the common α-β case) we skip scoreMoves entirely.
	// On a non-cutoff, record the result so the main loop skips this move.
	if s.params.TTMoveFirst && ttMove != chess.NullMove && excludedMove == chess.NullMove {
		s.dbgTTMFFires++
		for i := 0; i < ml.Len(); i++ {
			if ml.Get(i) == ttMove {
				ttFirstIdx = i
				break
			}
		}
	}
	if ttFirstIdx >= 0 {
		// Compute singular extension (duplicated from the main-loop
		// computation below — identical inputs give identical results).
		extTT := 0
		if s.params.Singular && !inCheck && ply > 0 &&
			ttHit && depth >= s.params.SingularMinDepth &&
			ttDepth >= depth-3 && (ttFlag == ttLower || ttFlag == ttExact) &&
			absInt(ttScore) < tbThreshold {
			singularBeta := ttScore - s.params.SingularMargin*depth
			rDepth := (depth - 1) / 2
			s.excluded[ply] = ttMove
			prevVerify := s.inSingularVerify
			s.inSingularVerify = true
			singScore := s.negamax(pos, rDepth, ply, singularBeta-1, singularBeta, cutnode)
			s.inSingularVerify = prevVerify
			s.excluded[ply] = chess.NullMove
			if s.stop {
				return 0
			}
			if singScore < singularBeta {
				if s.params.DoubleExt && !isPV && singScore < singularBeta-s.params.DoubleExtMargin {
					extTT = 2
				} else {
					extTT = 1
				}
			} else if s.params.NegExt {
				if !isPV && singScore >= beta {
					if absInt(singScore) < tbThreshold {
						return ilerpToBeta(singScore, beta)
					}
					return singScore
				} else if ttScore >= beta {
					extTT = -3
				} else if cutnode {
					extTT = -2
				}
			} else if s.params.MultiCut && singularBeta >= beta {
				return singularBeta
			}
		}

		m := ttMove
		captureTT := isCapture(pos, m)
		quietTT := !captureTT && m.Type() != chess.Promotion
		moverTT := pos.PieceOn(m.From())

		var u chess.Undo
		if s.useNNUE {
			s.accPush(pos, m)
		}
		pos.DoMove(m, &u)
		s.pushKey(pos.Key())
		s.contMove[ply] = contEntry{pc: moverTT, to: m.To(), ok: true}

		newDepthTT := depth - 1
		if extTT != 0 {
			newDepthTT += extTT
		}
		childCut := cutnode
		if extTT < 0 {
			childCut = true
		}
		fc := !childCut
		if isPV {
			fc = false
		}
		sc := -s.negamax(pos, newDepthTT, ply+1, -beta, -alpha, fc)

		s.popKey()
		pos.UndoMove(m, &u)
		if s.useNNUE {
			s.accPop()
		}
		if s.stop {
			return 0
		}

		if sc >= beta {
			if quietTT {
				s.recordKiller(ply, m)
				s.history[moverTT][m.To()] += depth * depth
			}
			if s.params.UseTT {
				ev := ttEvalNone
				if !inCheck && rawEval > -32000 && rawEval < 32000 {
					ev = int16(rawEval)
				}
				s.tt.store(pos.Key(), m, sc, depth, ply, ttLower, ev)
			}
			return sc
		}

		bestScore = sc
		bestMove = m
		searched = 1
		if sc > alpha {
			alpha = sc
			alphaRaises = 1
		}
		if quietTT {
			triedQuiets[0] = m
			nQuiets = 1
		} else if s.params.CaptHist && captureTT {
			triedCaptures[0] = m
			nCaptures = 1
		}
		ttFirstSearched = true
	}

	if s.params.DeferredQuiets {
		// === Staged move picking (Stormphrax/SF pattern) ===
		// Lazily allocate the per-ply scratch buffers on the first deferred node
		// (keeps the OFF path at nil pointers). Searcher-owned ⇒ no per-node alloc.
		if s.capBuf == nil {
			s.capBuf = new([maxPly][256]capEntry)
			s.quietBuf = new([maxPly][256]capEntry)
		}
		// Stage 1: TT move — search immediately, skip scoring.
		// Reuses the TTMoveFirst scaffolding (ttFirstIdx, ttFirstSearched).
		ttIdx := -1
		if ttMove != chess.NullMove && excludedMove == chess.NullMove {
			for i := 0; i < ml.Len(); i++ {
				if ml.Get(i) == ttMove {
					ttIdx = i
					break
				}
			}
		}
		if ttIdx >= 0 {
			s.dbgTTMFFires++
			// Singular extension for the TT move (same as the existing
			// computation below — identical inputs, identical result).
			extTT := 0
			if s.params.Singular && !inCheck && ply > 0 &&
				ttHit && depth >= s.params.SingularMinDepth &&
				ttDepth >= depth-3 && (ttFlag == ttLower || ttFlag == ttExact) &&
				absInt(ttScore) < tbThreshold {
				singularBeta := ttScore - s.params.SingularMargin*depth
				rDepth := (depth - 1) / 2
				s.excluded[ply] = ttMove
				prevVerify := s.inSingularVerify
				s.inSingularVerify = true
				singScore := s.negamax(pos, rDepth, ply, singularBeta-1, singularBeta, cutnode)
				s.inSingularVerify = prevVerify
				s.excluded[ply] = chess.NullMove
				if s.stop {
					return 0
				}
				if singScore < singularBeta {
					if s.params.DoubleExt && !isPV && singScore < singularBeta-s.params.DoubleExtMargin {
						extTT = 2
					} else {
						extTT = 1
					}
				} else if s.params.NegExt {
					if !isPV && singScore >= beta {
						if absInt(singScore) < tbThreshold {
							return ilerpToBeta(singScore, beta)
						}
						return singScore
					} else if ttScore >= beta {
						extTT = -3
					} else if cutnode {
						extTT = -2
					}
				} else if s.params.MultiCut && singularBeta >= beta {
					return singularBeta
				}
			}

			m := ttMove
			captureTT := isCapture(pos, m)
			quietTT := !captureTT && m.Type() != chess.Promotion
			moverTT := pos.PieceOn(m.From())

			var u chess.Undo
			if s.useNNUE {
				s.accPush(pos, m)
			}
			pos.DoMove(m, &u)
			s.pushKey(pos.Key())
			s.contMove[ply] = contEntry{pc: moverTT, to: m.To(), ok: true}

			newDepthTT := depth - 1
			if extTT != 0 {
				newDepthTT += extTT
			}
			childCut := cutnode
			if extTT < 0 {
				childCut = true
			}
			fc := !childCut
			if isPV {
				fc = false
			}
			sc := -s.negamax(pos, newDepthTT, ply+1, -beta, -alpha, fc)

			s.popKey()
			pos.UndoMove(m, &u)
			if s.useNNUE {
				s.accPop()
			}
			if s.stop {
				return 0
			}

			if sc >= beta {
				if quietTT {
					s.recordKiller(ply, m)
					s.history[moverTT][m.To()] += depth * depth
				}
				if s.params.UseTT {
					ev := ttEvalNone
					if !inCheck && rawEval > -32000 && rawEval < 32000 {
						ev = int16(rawEval)
					}
					s.tt.store(pos.Key(), m, sc, depth, ply, ttLower, ev)
				}
				return sc
			}

			bestScore = sc
			bestMove = m
			searched = 1
			if sc > alpha {
				alpha = sc
				alphaRaises = 1
			}
			if quietTT {
				triedQuiets[0] = m
				nQuiets = 1
			} else if s.params.CaptHist && captureTT {
				triedCaptures[0] = m
				nCaptures = 1
			}
		}

		// === Stage 2: Captures and promotions ===
		nCaps := s.scoreCaptures(pos, &ml, ttMove, excludedMove, ply)
		caps := s.capBuf[ply][:nCaps]

		// ProbCut (unchanged — scans the move list, needs no scores).
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
					continue
				}
				mover := pos.PieceOn(m.From())
				var u chess.Undo
				if s.useNNUE {
					s.accPush(pos, m)
				}
				pos.DoMove(m, &u)
				s.pushKey(pos.Key())
				s.contMove[ply] = contEntry{pc: mover, to: m.To(), ok: true}
				score := -s.quiescence(pos, ply+1, -probcutBeta, -probcutBeta+1)
				if score >= probcutBeta {
					score = -s.negamax(pos, probcutDepth, ply+1, -probcutBeta, -probcutBeta+1, !cutnode)
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
					return probcutBeta
				}
			}
		}

		// LMP limit (shared by quiet stage). LMPBase + LMPMultX10·depth²/10 (defaults
		// 3 / 10 → 3+depth²; ×10 lets SPSA tune the depth² coefficient fractionally).
		lmpBase := s.params.LMPBase + (s.params.LMPMultX10*depth*depth)/10
		lmpLimitDQ := lmpBase
		if s.params.Improving {
			lmpLimitDQ = lmpBase / (2 - impInt)
		}

		// Search good captures (score ≥ scoreCapture = winning/equal).
		for _, ce := range caps {
			if ce.score < scoreCapture {
				continue
			}
			m := ce.Move
			capture := isCapture(pos, m)
			mover := pos.PieceOn(m.From())

			if s.params.CaptSEE && capture && m.Type() != chess.Promotion && !isPV &&
				!inCheck && searched > 0 && depth <= s.params.CaptSEEMaxDepth &&
				bestScore > -mateThreshold {
				if !pos.SEEGE(m, -s.params.CaptSEEMargin*depth) {
					s.dbgCaptSEE++
					continue
				}
			}

			seeWinning := false
			if s.params.LMR2 && s.params.SEE && capture {
				seeWinning = pos.SEEGE(m, 0)
			}

			var u chess.Undo
			if s.useNNUE {
				s.accPush(pos, m)
			}
			pos.DoMove(m, &u)
			s.pushKey(pos.Key())
			s.contMove[ply] = contEntry{pc: mover, to: m.To(), ok: true}
			givesCheck := pos.InCheck()

			newDepth := depth - 1
			childCutnode := cutnode

			var sc int
			if searched == 0 {
				firstCut := !childCutnode
				if isPV {
					firstCut = false
				}
				sc = -s.negamax(pos, newDepth, ply+1, -beta, -alpha, firstCut)
			} else {
				reduction := 0
				if s.params.LMR2 && !(s.params.CleanVerify && s.inSingularVerify) {
					minSearched := 2
					if !isPV {
						minSearched = 1
					}
					if depth >= 2 && !inCheck && !givesCheck && searched >= minSearched {
						r := s.lmr[minInt(depth, 63)][minInt(searched, 63)]
						r--
						if capture && seeWinning {
							r--
						}
						if isPV {
							r--
						} else {
							r++
						}
						if !improving {
							r++
						}
						if s.params.LMRCutnode && childCutnode {
							r += s.params.LMRCutnodeRed
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
				}
				scoutCut := true
				if reduction == 0 {
					scoutCut = !childCutnode
				}
				sc = -s.negamax(pos, newDepth-reduction, ply+1, -alpha-1, -alpha, scoutCut)
				if sc > alpha && reduction > 0 {
					rd := newDepth
					if s.params.LMRDoDeeper {
						if sc > bestScore+44+4*newDepth {
							rd = newDepth + 1
						} else if sc < bestScore+newDepth {
							rd = newDepth - 1
							if rd < 1 {
								rd = 1
							}
						}
					}
					sc = -s.negamax(pos, rd, ply+1, -alpha-1, -alpha, !childCutnode)
				}
				if sc > alpha && sc < beta {
					sc = -s.negamax(pos, newDepth, ply+1, -beta, -alpha, false)
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
			if s.params.CaptHist && capture {
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
					alphaRaises++
					if alpha >= beta {
						if s.params.CaptHist && capture {
							s.updateCaptureStats(pos, m, triedCaptures[:nCaptures], depth)
						}
						goto postLoopDeferred
					}
				}
			}
		}

		// === Stage 3: Quiets — history+killer ordered ===
		// Collect the quiets NOW (after stage-2 captures have mutated
		// s.history/s.cont — that timing is the point of deferral) into the
		// per-ply buffer, scoring each with the SAME quiet score the
		// non-deferred path uses (killer bonus 900k/800k for killers[ply][0/1],
		// else butterfly history + any continuation history). selectCap then
		// picks highest-first, so the search order over these quiets matches
		// what the non-deferred path's selectMove would produce for the same
		// quiets — killers regain their just-below-captures priority, and the
		// pruning gates below (LMP/futility/histprune/SEEQuiet) now fire on the
		// ORDERED list. Appends into the Searcher-owned array (cap 256 ≥ max
		// legal moves) so no reallocation / heap escape.
		//
		// Block-scoped so `quiets` is not live at postLoopDeferred (the stage-2
		// cutoff gotos jump past this point; a decl in scope at the label is a
		// compile error).
		{
			quiets := s.quietBuf[ply][:0]
			for i := 0; i < ml.Len(); i++ {
				m := ml.Get(i)
				if m == ttMove || m == excludedMove {
					continue
				}
				if isCapture(pos, m) || m.Type() == chess.Promotion {
					continue
				}
				quiets = append(quiets, capEntry{i, s.moveScore(pos, m, chess.NullMove, ply), m})
			}
			for qi := 0; qi < len(quiets); qi++ {
				selectCap(quiets, qi) // one selection step: highest-scored quiet to slot qi
				m := quiets[qi].Move
				mover := pos.PieceOn(m.From())

				histVal := s.history[mover][m.To()]
				if s.params.ContHist && s.cont != nil {
					histVal += s.contScore(ply, mover, m.To())
				}
				if s.params.ContHist2 && s.cont2 != nil {
					histVal += s.contScore2(ply, mover, m.To())
				}

				lmpLim := lmpLimitDQ
				if s.params.LMPHist {
					lmpLim += histVal / 4096
				}
				if s.params.LMP && !isPV && !inCheck && searched > 0 &&
					depth <= s.params.LMPMaxDepth && bestScore > -mateThreshold &&
					searched >= lmpLim {
					continue
				}

				futMargin := s.params.FutilityBase + s.params.FutilitySlope*depth
				if s.params.FutHist {
					futMargin += histVal / 128
				}
				if s.params.Futility && !isPV && !inCheck && searched > 0 &&
					depth <= s.params.FutilityMaxDepth && bestScore > -mateThreshold &&
					staticEval+futMargin <= alpha {
					continue
				}

				if s.params.HistPrune && !isPV && !inCheck && searched > 0 &&
					depth <= s.params.HistPruneMaxDepth && bestScore > -mateThreshold {
					if histVal < s.params.HistPruneMargin*depth {
						s.dbgHistPrune++
						continue
					}
				}

				if s.params.SEEQuiet && !isPV && !inCheck && searched > 0 &&
					depth <= s.params.SEEQuietMaxDepth && bestScore > -mateThreshold {
					if !pos.SEEGE(m, -s.params.SEEQuietMargin*depth) {
						s.dbgSEEQuiet++
						continue
					}
				}

				var u chess.Undo
				if s.useNNUE {
					s.accPush(pos, m)
				}
				pos.DoMove(m, &u)
				s.pushKey(pos.Key())
				s.contMove[ply] = contEntry{pc: mover, to: m.To(), ok: true}
				givesCheck := pos.InCheck()

				newDepth := depth - 1
				childCutnode := cutnode

				var sc int
				reduction := 0
				if s.params.LMR2 && !(s.params.CleanVerify && s.inSingularVerify) {
					minSearched := 2
					if !isPV {
						minSearched = 1
					}
					if depth >= 2 && !inCheck && !givesCheck && searched >= minSearched {
						r := s.lmr[minInt(depth, 63)][minInt(searched, 63)]
						r -= histVal / s.params.LMRHistDiv
						if isPV {
							r--
						} else {
							r++
						}
						if !improving {
							r++
						}
						if s.params.LMRCutnode && childCutnode {
							r += s.params.LMRCutnodeRed
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
				} else if s.params.LMR && depth >= 3 && !inCheck && (!givesCheck || s.params.LMRCheckReduce) && searched >= s.params.LMRMinMoves {
					if s.params.LMRFormula {
						r := s.lmr[minInt(depth, 63)][minInt(searched, 63)]
						r -= histVal / s.params.LMRHistDiv
						if s.params.LMRCutnode && childCutnode {
							r += s.params.LMRCutnodeRed
						}
						if s.params.LMRImproving && !improving {
							r++
						}
						if s.params.LMRTtNoisy && ttMoveNoisy {
							r += s.params.LMRTtNoisyRed
						}
						if s.params.LMRAlpha {
							r += alphaRaises * s.params.LMRAlphaScale / 1024
						}
						if s.params.LMRCheckReduce && givesCheck {
							r -= s.params.LMRCheckRed
						}
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
				scoutCut := true
				if reduction == 0 {
					scoutCut = !childCutnode
				}
				sc = -s.negamax(pos, newDepth-reduction, ply+1, -alpha-1, -alpha, scoutCut)
				if sc > alpha && reduction > 0 {
					rd := newDepth
					if s.params.LMRDoDeeper {
						if sc > bestScore+44+4*newDepth {
							rd = newDepth + 1
						} else if sc < bestScore+newDepth {
							rd = newDepth - 1
							if rd < 1 {
								rd = 1
							}
						}
					}
					sc = -s.negamax(pos, rd, ply+1, -alpha-1, -alpha, !childCutnode)
				}
				if sc > alpha && sc < beta {
					sc = -s.negamax(pos, newDepth, ply+1, -beta, -alpha, false)
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
				triedQuiets[nQuiets] = m
				nQuiets++

				if sc > bestScore {
					bestScore = sc
					bestMove = m
					if ply == 0 {
						s.rootBest = m
						s.rootScore = sc
					}
					if sc > alpha {
						alpha = sc
						alphaRaises++
						if alpha >= beta {
							s.recordKiller(ply, m)
							s.updateQuietStats(pos, m, triedQuiets[:nQuiets], depth)
							s.updateContHist(pos, m, triedQuiets[:nQuiets], depth, ply)
							s.updateContHist2(pos, m, triedQuiets[:nQuiets], depth, ply)
							goto postLoopDeferred
						}
					}
				}
			} // end stage-3 block scope
		}

		// === Stage 4: Losing captures ===
		for _, ce := range caps {
			if ce.score >= scoreCapture {
				continue
			}
			m := ce.Move
			capture := isCapture(pos, m)
			mover := pos.PieceOn(m.From())

			var u chess.Undo
			if s.useNNUE {
				s.accPush(pos, m)
			}
			pos.DoMove(m, &u)
			s.pushKey(pos.Key())
			s.contMove[ply] = contEntry{pc: mover, to: m.To(), ok: true}

			newDepth := depth - 1
			childCutnode := cutnode

			reduction := 0
			if s.params.LMR2 && !(s.params.CleanVerify && s.inSingularVerify) && depth >= 2 && !inCheck {
				r := s.lmr[minInt(depth, 63)][minInt(searched, 63)]
				r--
				if !isPV {
					r++
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
			scoutCut := true
			if reduction == 0 {
				scoutCut = !childCutnode
			}
			sc := -s.negamax(pos, newDepth-reduction, ply+1, -alpha-1, -alpha, scoutCut)
			if sc > alpha && reduction > 0 {
				sc = -s.negamax(pos, newDepth, ply+1, -alpha-1, -alpha, !childCutnode)
			}
			if sc > alpha && sc < beta {
				sc = -s.negamax(pos, newDepth, ply+1, -beta, -alpha, false)
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
			if s.params.CaptHist && capture {
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
					alphaRaises++
					if alpha >= beta {
						if s.params.CaptHist && capture {
							s.updateCaptureStats(pos, m, triedCaptures[:nCaptures], depth)
						}
						goto postLoopDeferred
					}
				}
			}
		}

	postLoopDeferred:
	} else {
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
					score = -s.negamax(pos, probcutDepth, ply+1, -probcutBeta, -probcutBeta+1, !cutnode) // probcut child: opposite node type (Stormphrax search.cpp:954)
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

		// Late-move-pruning move-count limit. Improving lets more late quiets through
		// (2−improving halves the budget when the position is not trending our way).
		// LMPBase + LMPMultX10·depth²/10 (defaults 3 / 10 → 3+depth²).
		lmpBase := s.params.LMPBase + (s.params.LMPMultX10*depth*depth)/10
		lmpLimit := lmpBase
		if s.params.Improving {
			lmpLimit = lmpBase / (2 - impInt)
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
			// Singular verification preserves the parent's cutnode (Stormphrax
			// search.cpp:1093 passes `cutnode` unchanged into the verification search).
			singScore := s.negamax(pos, rDepth, ply, singularBeta-1, singularBeta, cutnode)
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
			} else if s.params.NegExt {
				// NegExt (Params.NegExt, DEFAULT OFF): the TT move is NOT singular. Mirror
				// Stormphrax's softened multicut + negative extensions (search.cpp:1113-1119),
				// which is exactly the machinery our own notes blame for the lmr2+singular
				// −67 (the HARD `return singularBeta` early-return).
				//   - !isPV && singScore >= beta  → SOFT multicut: don't hard-return
				//     singularBeta; blend the verification score toward beta (ilerp, T=503/1024)
				//     unless it is a mate/TB score, in which case return it raw.
				//   - else if ttScore >= beta      → extension = -3 (TT entry itself fails high:
				//     search the TT move SHALLOWER).
				//   - else if cutnode              → extension = -2 (expected cut node: shallower).
				// A negative extension feeds newDepth = depth + extension - 1 (can drop the
				// move toward qsearch) and flips the child cutnode (see childCutnode below,
				// Stormphrax's `cutnode |= extension < 0`).
				if !isPV && singScore >= beta {
					s.dbgMultiCut++
					if absInt(singScore) < tbThreshold {
						return ilerpToBeta(singScore, beta)
					}
					return singScore
				} else if ttScore >= beta {
					extension = -3
				} else if cutnode {
					extension = -2
				}
			} else if s.params.MultiCut && singularBeta >= beta {
				s.dbgMultiCut++
				return singularBeta // multi-cut: another move also beats beta
			}
		}

		// LMR term inputs (Stormphrax): ttMoveNoisy = the TT move is a capture (a
		// tactical node); alphaRaises = how many moves have already raised alpha at
		// this node (recomputed as the loop advances). Both feed the additive LMR
		// reduction terms below; cheap and byte-inert unless their flags are on.

		for i := 0; i < ml.Len(); i++ {
			selectMove(&ml, &scores, i)
			m := ml.Get(i)
			if ttFirstSearched && i == ttFirstIdx {
				continue // already searched above
			}
			if m == excludedMove { // singular verification: skip the move under test
				continue
			}
			rootNodesBefore := uint64(0)
			if ply == 0 {
				rootNodesBefore = s.nodes // attribute this root move's subtree for NodeTM
			}
			capture := isCapture(pos, m) // before DoMove, while the victim is still on m.To()
			quiet := !capture && m.Type() != chess.Promotion
			mover := pos.PieceOn(m.From()) // captured before DoMove empties m.From()

			// History-adjusted pruning margins (Stormphrax): a good-history quiet survives
			// LMP longer and clears futility easier; a bad-history one is pruned sooner.
			histVal := 0
			if quiet && (s.params.LMPHist || s.params.FutHist) {
				histVal = s.history[mover][m.To()]
				if s.params.ContHist && s.cont != nil {
					histVal += s.contScore(ply, mover, m.To())
				}
			}

			// Late move pruning: at a non-PV node near the leaves, once enough quiet
			// moves have been searched, skip the remaining late quiets (move ordering
			// puts them last, so they are almost never the best move). Never when in
			// check or when escaping a mate.
			lmpLim := lmpLimit
			if s.params.LMPHist {
				lmpLim += histVal / 4096 // ±~2 moves of slack from history
			}
			if s.params.LMP && quiet && !isPV && !inCheck && searched > 0 &&
				depth <= s.params.LMPMaxDepth && bestScore > -mateThreshold &&
				searched >= lmpLim {
				continue
			}

			// Frontier futility pruning: at a shallow non-PV node, skip a late quiet whose
			// static eval plus a depth-scaled margin still can't reach alpha — it almost
			// surely won't raise it. The fail-low counterpart to RFP. Quiet only (captures
			// /promotions excluded), never the first move, never when getting mated.
			futMargin := s.params.FutilityBase + s.params.FutilitySlope*depth
			if s.params.FutHist {
				futMargin += histVal / 128 // ±~64cp from history
			}
			if s.params.Futility && quiet && !isPV && !inCheck && searched > 0 &&
				depth <= s.params.FutilityMaxDepth && bestScore > -mateThreshold &&
				staticEval+futMargin <= alpha {
				continue
			}

			// History pruning: at a shallow non-PV node, skip a late quiet whose history
			// score is strongly negative — move ordering already ranked it last, and a very
			// negative history means it almost never raises alpha. Mirrors the LMR history
			// computation (butterfly + continuation history). The threshold grows more
			// negative with depth, so deeper nodes prune only the very worst quiets.
			if s.params.HistPrune && quiet && !isPV && !inCheck && searched > 0 &&
				depth <= s.params.HistPruneMaxDepth && bestScore > -mateThreshold {
				hist := s.history[mover][m.To()]
				if s.params.ContHist && s.cont != nil {
					hist += s.contScore(ply, mover, m.To())
				}
				if s.params.ContHist2 && s.cont2 != nil {
					hist += s.contScore2(ply, mover, m.To())
				}
				if hist < s.params.HistPruneMargin*depth {
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

			// Pre-move SEE for the LMR2 noisy-move reduction below: it must be read
			// before DoMove empties m.From() and flips the side to move. Only computed
			// when the LMR2 capture path will actually consult it, so non-LMR2 / non-
			// capture nodes pay nothing.
			seeWinning := false
			if s.params.LMR2 && s.params.SEE && capture {
				seeWinning = pos.SEEGE(m, 0)
			}

			var u chess.Undo
			if s.useNNUE {
				s.accPush(pos, m)
			}
			pos.DoMove(m, &u)
			s.pushKey(pos.Key())
			// Record the move played to descend into the child, so the child can key its
			// continuation history off this (and its grandparent) move.
			s.contMove[ply] = contEntry{pc: mover, to: m.To(), ok: true, quiet: quiet}
			givesCheck := pos.InCheck()

			// Singular extension applies to the TT move only (extension is 0 otherwise,
			// so newDepth == depth-1 and the off-path is byte-identical). A NEGATIVE
			// extension (NegExt) drops the TT move's depth (can fall toward qsearch).
			newDepth := depth - 1
			if extension != 0 && m == ttMove {
				newDepth += extension
			}

			// Stormphrax's `cutnode |= extension < 0` (search.cpp:1131): a negatively-
			// extended move — only ever the TT move here — is searched as an expected cut
			// node. Kept as a PER-MOVE local (childCutnode), not a mutation of the shared
			// `cutnode` parameter, so the flip never leaks to sibling moves or the next
			// loop iteration. extension < 0 only occurs when NegExt is on, so childCutnode
			// == cutnode on the off-path (and cutnode is behavior-neutral there anyway).
			childCutnode := cutnode
			if extension < 0 && m == ttMove {
				childCutnode = true
			}

			var sc int
			if searched == 0 {
				// First searched move. At a PV node this is the PV child (full window,
				// never a cut node → false, Stormphrax search.cpp:1250). At a non-PV
				// (zero-window) node the same call is the first scout child, which is the
				// opposite node type from the parent (!childCutnode, Stormphrax's non-LMR
				// first-move zero-window search.cpp:1240).
				firstCut := !childCutnode
				if isPV {
					firstCut = false
				}
				sc = -s.negamax(pos, newDepth, ply+1, -beta, -alpha, firstCut)
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
						r := s.lmr[minInt(depth, 63)][minInt(searched, 63)]
						if quiet {
							hist := s.history[mover][m.To()]
							if s.params.ContHist && s.cont != nil {
								hist += s.contScore(ply, mover, m.To())
							}
							if s.params.ContHist2 && s.cont2 != nil {
								hist += s.contScore2(ply, mover, m.To())
							}
							r -= hist / s.params.LMRHistDiv
						} else {
							r-- // noisy move: reduce less than a quiet
							if capture && seeWinning {
								r-- // winning/equal capture (pre-move SEE): reduce even less
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
						if s.params.LMRCutnode && childCutnode {
							r += s.params.LMRCutnodeRed // cut-node: reduce late moves harder
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
				} else if s.params.LMR && depth >= 3 && quiet && !inCheck && (!givesCheck || s.params.LMRCheckReduce) && searched >= s.params.LMRMinMoves {
					if s.params.LMRFormula {
						if s.params.LMRFixedPoint {
							// ×1024 fixed-point reduction (SF18/Stormphrax): accumulate the
							// reduction in 1024ths of a ply off the fine-grained lmr1024 table,
							// so lmrbase/lmrdiv perturbations move it smoothly (an SPSA lever the
							// integer table can't give). Same terms as the integer path below,
							// each scaled to 1024ths; the default-off Stormphrax sub-terms are
							// intentionally omitted here (this is scaffolding — under SPRT).
							r1024 := s.lmr1024[minInt(depth, 63)][minInt(searched, 63)]
							hist := s.history[mover][m.To()]
							if s.params.ContHist && s.cont != nil {
								hist += s.contScore(ply, mover, m.To())
							}
							if s.params.ContHist2 && s.cont2 != nil {
								hist += s.contScore2(ply, mover, m.To())
							}
							r1024 -= hist * 1024 / s.params.LMRHistDiv
							if s.params.LMRCutnode && childCutnode {
								r1024 += s.params.LMRCutnodeRed * 1024
							}
							// Whole-ply reduction, then the same [1, depth-1] clamp as OFF.
							r := r1024 / 1024
							// PV relief: reduce PV nodes one ply LESS (SF/Stormphrax apply this
							// unconditionally). DEFAULT OFF → byte-identical; applied identically
							// in both LMRFixedPoint branches, before the shared clamp.
							if s.params.LMRPvRelief && isPV && r > 1 {
								r--
							}
							if r < 1 {
								r = 1
							}
							if r > depth-1 {
								r = depth - 1
							}
							reduction = r
						} else {
							// Smooth log(d)·log(m) base in place of the flat 1/2; reduce
							// less for good-history quiets, more for malus'd ones. Clamped
							// to [1, depth-1] so a reduced move still searches ≥1 ply.
							r := s.lmr[minInt(depth, 63)][minInt(searched, 63)]
							hist := s.history[mover][m.To()]
							if s.params.ContHist && s.cont != nil {
								hist += s.contScore(ply, mover, m.To())
							}
							if s.params.ContHist2 && s.cont2 != nil {
								hist += s.contScore2(ply, mover, m.To())
							}
							r -= hist / s.params.LMRHistDiv
							// Cut-node: a node expected to fail high orders its best move first,
							// so a late move here almost never raises alpha — reduce it harder
							// (Stormphrax search.cpp:1173, r += cutnode). childCutnode is the
							// current node's type.
							if s.params.LMRCutnode && childCutnode {
								r += s.params.LMRCutnodeRed
							}
							// Individual Stormphrax LMR terms (each independent, additive; the
							// aggressive LMR2 *bundle* was rejected at movetime — these are not
							// that). Only fire when their flag is on, so off is byte-identical.
							if s.params.LMRImproving && !improving {
								r++ // not improving ⇒ reduce late quiets a ply more
							}
							if s.params.LMRTtNoisy && ttMoveNoisy {
								r += s.params.LMRTtNoisyRed // TT move is a capture ⇒ tactical node
							}
							if s.params.LMRAlpha {
								r += alphaRaises * s.params.LMRAlphaScale / 1024
							}
							if s.params.LMRCheckReduce && givesCheck {
								r -= s.params.LMRCheckRed // reduce a checking quiet LESS (don't skip it)
							}
							// PV relief: reduce PV nodes one ply LESS (SF/Stormphrax apply this
							// unconditionally). DEFAULT OFF → byte-identical; applied identically
							// in both LMRFixedPoint branches, before the shared clamp.
							if s.params.LMRPvRelief && isPV && r > 1 {
								r--
							}
							if r < 1 {
								r = 1
							}
							if r > depth-1 {
								r = depth - 1
							}
							reduction = r
						}
					} else {
						reduction = 1
						if searched >= 8 {
							reduction = 2
						}
					}
				}
				// Zero-window scout. A REDUCED (LMR) child is searched as an expected cut
				// node (true, matching Stormphrax's hardcoded `true` on the reduced search
				// search.cpp:1186); an UNREDUCED scout is the opposite node type from the
				// parent (!childCutnode, Stormphrax non-LMR zero-window search.cpp:1240).
				scoutCut := true
				if reduction == 0 {
					scoutCut = !childCutnode
				}
				sc = -s.negamax(pos, newDepth-reduction, ply+1, -alpha-1, -alpha, scoutCut)
				rd := newDepth // doDeeper/doShallower-adjusted depth; stays newDepth if unreduced
				if sc > alpha && reduction > 0 {
					// LMR re-search (zero window), opposite node type (Stormphrax
					// search.cpp:1205). doDeeper/doShallower: adapt the re-search depth
					// to how far the reduced scout beat alpha — a big overshoot searches
					// deeper, a bare pass shallower (Stormphrax search.cpp:1190-1193).
					if s.params.LMRDoDeeper {
						if sc > bestScore+44+4*newDepth {
							rd = newDepth + 1
						} else if sc < bestScore+newDepth {
							rd = newDepth - 1
							if rd < 1 {
								rd = 1
							}
						}
					}
					sc = -s.negamax(pos, rd, ply+1, -alpha-1, -alpha, !childCutnode)
				}
				if sc > alpha && sc < beta {
					// PV full-window re-search: a PV child, never a cut node (false,
					// Stormphrax search.cpp:1250). LMRResearchFix carries the
					// doDeeper/doShallower depth (rd) into this re-search too, matching SF's
					// mutated newDepth (search.cpp:1253); default off reproduces the old
					// unadjusted-newDepth behavior byte-for-byte.
					pvReDepth := newDepth
					if s.params.LMRResearchFix {
						pvReDepth = rd
					}
					sc = -s.negamax(pos, pvReDepth, ply+1, -beta, -alpha, false)
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
					s.rootBestNodes = s.nodes - rootNodesBefore
				}
				if sc > alpha {
					alpha = sc
					alphaRaises++ // feeds the LMRAlpha reduction term for later moves
					if alpha >= beta {
						if quiet {
							s.recordKiller(ply, m)
							s.updateQuietStats(pos, m, triedQuiets[:nQuiets], depth)
							s.updateContHist(pos, m, triedQuiets[:nQuiets], depth, ply)
							s.updateContHist2(pos, m, triedQuiets[:nQuiets], depth, ply)
						} else if s.params.CaptHist && capture {
							s.updateCaptureStats(pos, m, triedCaptures[:nCaptures], depth)
						}
						break
					}
				}
			}
		}

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
	} // end else (DeferredQuiets=off, existing code path)

	// Parent counter-move (PCM) fail-low bonus: on a PURE fail-low (flag==ttUpper — no
	// move raised alpha) with a quiet parent move, credit that parent move a positive
	// continuation+butterfly bonus. It "caused the fail low" so it was good for the side
	// that played it (SF search.cpp:1423 / Stormphrax search.cpp:1398). flag==ttUpper (not
	// bestMove==nil) is the pure-fail-low signal because our search is fail-soft. Reached by
	// both paths; excludedMove==NullMove is guaranteed (excluded nodes returned above).
	if s.params.ParentContHistBonus && flag == ttUpper &&
		ply >= 1 && s.contMove[ply-1].ok && s.contMove[ply-1].quiet {
		s.pcmCreditParent(ply, depth, bestScore, staticEval, inCheck)
	}

	// Shared post-loop: corrhist update, TT store (both paths reach here).
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

	// FIX 1 — QSearchTT (SF search.cpp:1542-1728): give quiescence a TT probe. On a
	// bound-consistent stored score at a non-PV node, take an early cutoff; otherwise
	// seed move ordering (ttMove) and refine the stand-pat floor with the TT value.
	// The stored form (ttLower/ttUpper/ttExact) + mate ply-adjust are handled by tt.go
	// exactly as in the main search — this only reuses probe/store/scoreFromTT.
	qtt := s.params.QSearchTT && s.params.UseTT
	isPVq := beta-alpha > 1
	ttMove := chess.NullMove
	ttHit := false
	var ttFlagQ ttFlag = ttNone
	ttScoreQ := 0
	if qtt {
		if e, ok := s.tt.probe(pos.Key()); ok {
			ttHit = true
			ttMove = e.move
			ttFlagQ = e.flag
			ttScoreQ = e.scoreFromTT(ply)
			// Non-PV early cutoff (SF search.cpp:1550-1553). Every stored entry is at
			// depth ≥ the QS sentinel (0), so no depth guard is needed. A LOWER/EXACT
			// bound ≥ beta or an UPPER/EXACT bound < beta is consistent to return.
			if !isPVq &&
				((ttScoreQ >= beta && (ttFlagQ == ttLower || ttFlagQ == ttExact)) ||
					(ttScoreQ < beta && (ttFlagQ == ttUpper || ttFlagQ == ttExact))) {
				return ttScoreQ
			}
		}
	}

	inCheck := pos.InCheck()
	standPat := 0           // un-refined static eval; the delta / qsfut futility base
	bestScore := -mateScore // fail-soft floor (only consulted when qtt is on)
	bestMove := chess.NullMove
	qFailHigh := false
	if !inCheck {
		standPat = s.evaluate(pos)
		bestScore = standPat
		// ttValue refines the stand-pat FLOOR (bestScore) but NOT the futility base
		// `standPat` — SF keeps futilityBase off the un-refined ss->staticEval and only
		// refines bestValue (SF search.cpp:1575-1578). Non-mate + bound-consistent only.
		if qtt && ttHit && absInt(ttScoreQ) < mateThreshold &&
			((ttFlagQ == ttLower && ttScoreQ > bestScore) ||
				(ttFlagQ == ttUpper && ttScoreQ < bestScore) ||
				ttFlagQ == ttExact) {
			bestScore = ttScoreQ
		}
		if bestScore >= beta {
			if qtt {
				s.tt.store(pos.Key(), chess.NullMove, bestScore, 0, ply, ttLower, ttEvalNone)
				return bestScore
			}
			return beta
		}
		if bestScore > alpha {
			alpha = bestScore
		}
	}

	// In check, every evasion (quiet ones included) must be searched, so use the
	// full legal generator; out of check, only noisy moves matter, so generate
	// just those — the pin/check-mask machinery is identical, we skip the legality
	// work for the quiet majority. GenerateCaptures is a byte-identical subsequence
	// of the filtered legal list (movegen_captures_test.go), so this changes NPS,
	// not which moves are searched.
	var ml chess.MoveList
	if inCheck {
		pos.GenerateLegal(&ml)
		if ml.Len() == 0 {
			return -mateScore + ply
		}
	} else if s.params.QCaps {
		pos.GenerateCaptures(&ml)
		if ml.Len() == 0 {
			if qtt {
				s.tt.store(pos.Key(), chess.NullMove, bestScore, 0, ply, ttUpper, ttEvalNone)
				return bestScore
			}
			return alpha
		}
	} else {
		// QCaps=off: the pre-optimization path (generate all legal, filter to noisy
		// in the loop) — kept as a flag purely so the captures-only NPS win can be
		// A/B'd at movetime (its Elo is invisible at fixed nodes; see §26.3).
		pos.GenerateLegal(&ml)
		if ml.Len() == 0 {
			if qtt {
				s.tt.store(pos.Key(), chess.NullMove, bestScore, 0, ply, ttUpper, ttEvalNone)
				return bestScore
			}
			return alpha
		}
	}

	// Seed ordering with the TT move when qtt is on (byte-identical NullMove when off).
	ttArg := chess.NullMove
	if qtt {
		ttArg = ttMove
	}
	var scores [256]int
	s.scoreMoves(pos, &ml, ttArg, ply, &scores)

	qSearched := 0
	for i := 0; i < ml.Len(); i++ {
		selectMove(&ml, &scores, i)
		m := ml.Get(i)
		// Castling slips through the noisy filter (its rook-origin destination is
		// occupied → isCapture true) but is a genuinely quiet move. QSCastling=off
		// drops it from quiescence; default-on preserves the historical behavior.
		if !inCheck && !s.params.QSCastling && m.Type() == chess.Castling {
			continue
		}
		// Out of check, search only captures/promotions; in check, all evasions.
		if !inCheck && !isCapture(pos, m) && m.Type() != chess.Promotion {
			continue
		}
		// SEE pruning: out of check, skip captures that lose material outright.
		// SEEReuseQS reuses the SEE sign already encoded in the ordering score
		// (captureScore tiered SEE<0 as scoreLosingCapture at THIS position) instead
		// of a second pos.SEE(m) call. Every move reaching this prune (a genuine
		// capture or en-passant; promotions are excluded, castling routes through
		// captureScore's victim branch identically) was scored via captureScore, so
		// scores[i]≤seeLosingScoreThreshold ⟺ SEE<0 — node-count-identical.
		if !inCheck && s.params.SEE && isCapture(pos, m) && m.Type() != chess.Promotion {
			losing := false
			if s.params.QSCaptSEEMargin != 0 {
				// SF search.cpp:1665: keep captures losing up to QSCaptSEEMargin cp
				// (`if (!see_ge(move, -80)) continue`). Only reachable when the margin is
				// non-zero, so the default-0 path below stays byte-identical (a threshold
				// can't be read from the reused ordering-score sign, so this calls SEEGE).
				losing = !pos.SEEGE(m, -s.params.QSCaptSEEMargin)
			} else if s.params.SEEReuseQS {
				losing = scores[i] <= seeLosingScoreThreshold
			} else {
				losing = pos.SEE(m) < 0
			}
			if losing {
				continue
			}
		}
		// Delta pruning: out of check, skip a capture that even in the best case
		// (winning the victim plus a margin) cannot raise alpha.
		if !inCheck && s.params.DeltaPrune && isCapture(pos, m) && m.Type() != chess.Promotion {
			if standPat+captureGain(pos, m)+s.params.DeltaMargin <= alpha {
				// DeltaExemptChecks: don't prune a recapture on the square the previous
				// move moved to — an in-progress exchange the stand-pat can't see resolve
				// (SF search.cpp `to != prevSq` exemption). prevSq comes from the shared
				// continuation-move path (contMove[ply-1]), which for this feature is also
				// maintained ACROSS qsearch recursion (recorded at DoMove below when the
				// flag is on) so deep recapture chains keep the exemption.
				// TODO(DeltaExemptChecks): the gives-check exemption (SF `givesCheck`) is
				// NOT wired — gomachine has no cheap pre-move gives-check primitive (the
				// main search derives givesCheck only AFTER DoMove via pos.InCheck()), and
				// a real one needs direct+discovered+ep/castle/promo machinery; a
				// make/InCheck/unmake purely to test the exemption would defeat the prune.
				// Left for a follow-up. Only the recapture exemption ships in this scaffold.
				exempt := s.params.DeltaExemptChecks && ply >= 1 &&
					s.contMove[ply-1].ok && m.To() == s.contMove[ply-1].to
				if !exempt {
					continue
				}
			}
		}
		// Qsearch node-level futility (QSFutility; Stormphrax qsearchFp, DEFAULT OFF):
		// out of check, if the node floor (standPat + a small margin) can't reach
		// alpha AND this capture wins no material (SEE < 1), it's futile — skip it.
		// ADDITIVE to the per-move delta prune above, not a duplicate: delta subtracts
		// THIS move's optimistic victim value (standPat + captureGain + deltaMargin),
		// whereas this is a node-level floor with NO victim term, gated instead on the
		// capture not being a SEE-winning exchange. `continue` (not `break`) because our
		// captures aren't strictly SEE-ordered — a later SEE-winning capture must still
		// be searched even once the floor fails.
		if s.params.QSFutility && !inCheck && isCapture(pos, m) && m.Type() != chess.Promotion {
			if standPat+s.params.QSFutilityMargin <= alpha && !pos.SEEGE(m, 1) {
				continue
			}
		}
		var u chess.Undo
		if s.useNNUE {
			s.accPush(pos, m)
		}
		// DeltaExemptChecks: record this qsearch move on the shared continuation-move
		// path so the child qsearch node's recapture exemption sees the correct prevSq
		// (negamax normally maintains this path, but plain qsearch does not). Flag-gated
		// so the off-path is byte-identical; negamax overwrites contMove[ply] before it
		// reads it, so this stale write never leaks into the main search.
		if s.params.DeltaExemptChecks {
			s.contMove[ply] = contEntry{pc: pos.PieceOn(m.From()), to: m.To(), ok: true}
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
		if qtt {
			// Fail-soft (SF search.cpp): track bestScore/bestMove; on a fail-high break
			// out and store a LOWER bound at the end (SF never early-returns from qs).
			if sc > bestScore {
				bestScore = sc
				if sc > alpha {
					bestMove = m
					if sc >= beta {
						qFailHigh = true
						break
					}
					alpha = sc
				}
			}
		} else {
			if sc >= beta {
				return beta
			}
			if sc > alpha {
				alpha = sc
			}
		}
		// Qsearch move-count cap (Stormphrax search.cpp:1579): out of check, the good
		// captures are searched first, so after a few the rest almost never raise
		// alpha — stop to bound the qnode explosion. DEFAULT OFF (QSMaxMoves=0).
		qSearched++
		if s.params.QSMaxMoves > 0 && !inCheck && qSearched >= s.params.QSMaxMoves {
			break
		}
	}
	if qtt {
		// Store the qsearch result at the fixed QS depth (0): a fail-high is a LOWER
		// bound, otherwise an UPPER bound (qsearch's move set is incomplete, so never
		// EXACT — matches SF search.cpp:1720). eval field is ttEvalNone: the qsearch
		// score is corrhist-corrected, so caching it as a raw eval would pollute TTEval.
		flag := ttUpper
		if qFailHigh {
			flag = ttLower
		}
		s.tt.store(pos.Key(), bestMove, bestScore, 0, ply, flag, ttEvalNone)
		return bestScore
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
