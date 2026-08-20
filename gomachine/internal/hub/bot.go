package hub

import (
	"context"
	"fmt"
	mrand "math/rand/v2"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// engineHandle is a pooled search engine used to compute bot moves.
type engineHandle = engine.Engine

// botMoveResult is a bot move computed off the Run goroutine, ready to apply.
type botMoveResult struct {
	gameID string
	ply    int // move count when the bot started thinking (staleness guard)
	uci    string

	// evalCp is the search's own score for the position it just moved in,
	// centipawns from the BOT's point of view (zugzwang reports side-to-move
	// relative, and the side to move IS the bot here). It rides along for free
	// with every move, which is what lets a bot offer a draw or resign without
	// the hub ever running a second search.
	//
	// evalKnown separates "the bot evaluated this at 0.00" from "no score came
	// back" — the self-search variants (Duck, Crazyhouse, Antichess, Secret
	// Queen) return a move and nothing else. Without the flag their silence
	// would read as dead equal, and every one of their bots would start
	// offering draws on move one.
	evalCp    int
	evalKnown bool
}

// botSnapshot is an immutable copy of everything a worker needs to pick a move,
// so it never touches live game state from another goroutine.
type botSnapshot struct {
	gameID         string
	ply            int
	fen            string
	history        []uint64      // prior-position Zobrist keys (emergency in-process fallback only)
	fenHistory     []string      // prior-position FENs, same positions as `history` (zugzwang HTTP; game.fenHistory())
	rating         int           // target Elo (rating-first ladder)
	displayRating  int           // shown Elo (human/CCRL scale) — drives pacing, not search
	moveTimeCap    time.Duration // >0 overrides the ladder budget (fillers: cheap, cosmetic)
	searchDepthCap int           // >0 hard-caps root-rank depth (fillers only; keeps search cheap)
	tc             timeControl   // pacing scales with the time control
	remainingMs    int64
	legalCount     int
	pieceCount     int    // pieces left on the board — fewer ⇒ faster moves (endgame pace)
	lastMoveTo     string // dest square of the opponent's last move ("" if none) — for recapture snap

	// floors is this game's think-floor ladder (scheduleFloors) — a filler's is
	// far higher than a human-facing backfill bot's, so a Watch-lobby game can
	// genuinely be decided on the clock. See thinkFloors' doc.
	floors thinkFloors
	// criticalMult is >1 when this bot's own eval just swung ≥criticalSwingCp
	// and this move owes a "just noticed" hard think (armCriticalThink,
	// game.criticalThinksOwed) — 1 means no effect. Consumed (decremented) at
	// schedule time, never read live off the Run goroutine here.
	criticalMult float64
	// inCheck is whether the BOT (the side about to move) is in check in the
	// position it's about to move in — read once via g.status().Check at
	// schedule time. See botThinkDelay's inCheck handling.
	inCheck bool
}

// thinkFloors bundles the three floor tiers (normal / opening / time-trouble)
// botThinkDelay picks a per-move minimum from, so a filler and a human-facing
// backfill bot can run entirely different floor ladders through the same
// function — see scheduleFloors, backfillFloor* below and the filler-floor
// bands in filler.go.
type thinkFloors struct {
	normal, opening, panic int64 // milliseconds
}

// backfillFloor* are the human-facing bot's per-move minimum think — unchanged
// from before this feature existed. This feature is about making the WATCH-
// lobby filler clock genuinely burn down, not about touching how a bot paces
// against a real human, so a backfill bot's floors stay exactly what they were.
const (
	backfillFloorMs        int64 = 250
	backfillOpeningFloorMs int64 = 90
	backfillPanicFloorMs   int64 = 60
)

// scheduleFloors picks the floor ladder for a game's next bot move: a filler
// gets the much higher, randomized-per-move bands in filler.go's fillerFloors
// (so the Watch lobby can genuinely decide a game on the clock); everything
// else — a human-facing backfill bot, and arena/other bot-vs-bot games — keeps
// the original fixed floors, untouched by this feature.
func scheduleFloors(filler bool) thinkFloors {
	if filler {
		return fillerFloors()
	}
	return thinkFloors{normal: backfillFloorMs, opening: backfillOpeningFloorMs, panic: backfillPanicFloorMs}
}

// randRangeMs returns a uniformly random int64 in [lo, hi] — the shared jitter
// helper for the filler floor bands (filler.go), which need a fresh random pick
// per move rather than a fixed constant so the pacing doesn't read as a
// metronome.
func randRangeMs(lo, hi int64) int64 {
	if hi <= lo {
		return lo
	}
	return lo + mrand.Int64N(hi-lo+1)
}

// Bot-backfill wait is randomized per queued player (rather than a fixed delay)
// so fill-in bots don't always appear at the same beat — it reads as a real
// opponent happening to be found sooner or later.
const (
	botFillDelayMin = 2 * time.Second
	botFillDelayMax = 10 * time.Second
)

// randomBotFillDelay returns a uniformly random backfill wait in
// [botFillDelayMin, botFillDelayMax], assigned when a client enters a pool.
func randomBotFillDelay() time.Duration {
	span := botFillDelayMax - botFillDelayMin
	return botFillDelayMin + time.Duration(mrand.Int64N(int64(span)+1))
}

// EnableBotFill turns on bot backfill: a lone waiting player with no human match
// is paired with an engine opponent at `level`. The wait before backfill is
// randomized per player (see randomBotFillDelay) for realism, so `delay` is
// retained only as an on/off signal and a legacy default — it no longer sets the
// threshold. `workers` pooled
// engines (each `ttMB` of transposition table) bound concurrent bot thinking;
// each engine runs `searchThreads` Lazy SMP workers per move (only the top,
// full-strength levels are time-bounded, so SMP helps there — weakened levels
// rank moves serially). Keep workers*searchThreads under the host's cores so bot
// search can't starve the hub goroutine. Call before Run.
func (h *Hub) EnableBotFill(level int, delay time.Duration, workers, ttMB, searchThreads int) {
	if workers < 1 {
		workers = 1
	}
	h.botFill = true
	h.botLevel = level
	h.botDelay = delay
	h.engines = make(chan *engineHandle, workers)
	for range workers {
		e := engine.NewWithThreads(ttMB, searchThreads)
		e.SetTablebase(h.tb) // probe endgames at the root (nil = inert)
		h.engines <- e
	}
}

// checkBotFill promotes any player who has waited past botDelay into a bot game.
// Humans are always preferred: two waiting players pair instantly in queue(), so
// only a lone, long-waiting player is ever backfilled. Runs on the ticker.
func (h *Hub) checkBotFill() {
	if !h.botFill {
		return
	}
	now := time.Now()
	for key := range h.pools {
		var kept, promote []*Client
		for _, c := range h.pools[key] {
			if now.Sub(c.queuedAt) >= c.botFillDelay {
				promote = append(promote, c)
			} else {
				kept = append(kept, c)
			}
		}
		if len(kept) == 0 {
			delete(h.pools, key)
		} else {
			h.pools[key] = kept
		}
		tcPool, variant := splitQueueKey(key)
		tc, ok := parseTimeControl(tcPool)
		if !ok {
			continue
		}
		for _, c := range promote {
			c.pool = ""
			h.startBotGame(c, tc, tcPool, variant)
		}
	}
}

// startBotGame pairs a human with a fresh random bot opponent. To the client it
// looks like any other match (name + rating in the matched payload).
func (h *Hub) startBotGame(human *Client, tc timeControl, pool, variantID string) {
	if human.game != nil {
		return
	}
	// The account may have started a game on another device while this connection
	// waited in the pool — back it out rather than backfilling a second game.
	if g := h.activeGameFor(human); g != nil {
		h.attachToGame(human, g) // also drops it from the pool
		return
	}
	variantID = normalizeVariant(variantID)
	// Anchor the bot near the human's rating in this category so a one-sided rated
	// game is fair: the bot's displayed rating (what the human's Elo moves against)
	// sits within a small jitter of the human's, and the engine plays at roughly
	// that strength. Anonymous players have no rating, so fall back to the
	// configured default level's nominal rating.
	userRating := human.id.RatingFor(categoryFor(pool, variantID))
	if userRating <= 0 {
		userRating = ratingForLevel(h.botLevel)
	}
	displayed := botDisplayRating(userRating)
	bot := newBotIdentity(displayed)
	// A bot backfill starts from the variant's own start position: the standard
	// opening for everything except Chess960, which MUST get a real shuffled back
	// rank — a 960 game started from chess.StartFEN is just plain chess wearing a
	// 960 label. Custom mid-game seeds stay human-only. variant.New builds the right
	// ruleset (Duck begins duck-unplaced).
	startFen := chess.StartFEN
	if variantID == variantChess960 {
		startFen = chess.RandomChess960FEN()
	}
	st, err := variant.New(variantID, startFen)
	if err != nil {
		return // defensive: our start FENs always parse
	}
	g := &game{
		id:    newID(),
		state: st,
		tc:    tc,
		pool:  pool,
		// A matchmaking bot fill-in is rated for a logged-in human (one-sided Elo
		// vs the bot), mirroring startGameWith: standard feeds the time-control pools
		// and Chess960/Duck/Crazyhouse/Antichess/Secret Queen each feed their own
		// isolated pool. Anonymous players can't be rated. Explicit /bot games never
		// reach the hub.
		rated: !human.id.Anon && (variantID == variantStandard || variantID == variantChess960 ||
			variantID == variantDuck || variantID == variantCrazyhouse ||
			variantID == variantAntichess || variantID == variantSecretQueen),
		clockMs:   [2]int64{tc.Base, tc.Base},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  startFen,
		variant:   variantID,
	}

	humanColor := chess.White
	if mrand.IntN(2) == 1 {
		humanColor = chess.Black
	}
	if humanColor == chess.White {
		g.white = newPlayer(human)
		g.black = newBotPlayer(bot, displayed)
	} else {
		g.white = newBotPlayer(bot, displayed)
		g.black = newPlayer(human)
	}

	g.chat = newChatPersona() // one fixed chat character for this game

	human.game = g
	h.games[g.id] = g
	h.playerGames[human.id.UserID] = g
	h.markLive(g)
	h.activeGames.Add(1)
	h.armBotDrop(g) // presence.go: schedule this bot's one absence, if its disposition rolled one

	// Secret Queen: designate the bot's side immediately (see
	// beginSecretQueenDesignation's doc) and arm the human's 15s deadline,
	// BEFORE sendMatched so its payload already reflects needsDesignation.
	if variantID == variantSecretQueen {
		h.beginSecretQueenDesignation(g)
	}
	h.sendMatched(g, human, humanColor)
	h.joinOtherSessions(g, human) // open it on this account's other devices too
	h.scheduleBotMove(g)          // if the bot plays White, it moves first
	h.maybeOpeningChat(g)         // ...and it might open with a friendly "hi"
}

// fullStrengthRating is the value scheduleBotMove forwards as the search
// `rating` (never displayRating) for the one move consumeFullStrengthReplay
// overrides. Both backends' own top-of-ladder constant sits at 3500 — zugzwang's
// RatingMax (zugzwang/src/weakening.h; RatingFull=2850 is where it already stops
// weakening, so anything at or above that is clean, but RatingMax is the actual
// documented ceiling and leaves no ambiguity about clamping) and gomachine's own
// in-process emergency fallback's engine.RatingMax (internal/engine/rating.go) —
// the two aren't wired together, just numerically re-anchored to the same CCRL
// ceiling on 2026-07-01, which is what makes one constant here correct for both
// the normal zugzwang-HTTP path and the emergency in-process path. NOT the same
// number as a bot's normal displayed rating (bot.rating, capped at botRatingMax
// = 2600 below) — that one is deliberately weak so a bot's everyday play matches
// its advertised strength; this one exists solely to escape the ladder for a
// single replayed move.
const fullStrengthRating = 3500

// consumeFullStrengthReplay resolves and clears game.botFullStrengthReplay,
// returning the rating scheduleBotMove should actually search at: `normal`
// unless the bot is redoing a move the human just handed back, in which case
// fullStrengthRating.
//
// applyTakeback (hub.go) sets the flag, and it knows precisely when to: it has
// the requesting colour in hand, so "the side getting its move back is a bot"
// is a fact there rather than something to infer here. A declined request never
// reaches applyTakeback at all, so nothing needs to distinguish the two after
// the fact. One-shot: cleared on read, so it can only ever affect the single
// replacement move.
//
// Called once per scheduled move on the Run goroutine, before the snapshot
// crosses to a worker — same convention as consumeCriticalThink. Workers only
// ever see the resolved rating in botSnapshot, never the flag.
func consumeFullStrengthReplay(g *game, normal int) int {
	if !g.botFullStrengthReplay {
		return normal
	}
	g.botFullStrengthReplay = false
	return fullStrengthRating
}

// scheduleBotMove starts async move computation when it is a bot's turn. Works
// for human-vs-bot (one bot) and filler bot-vs-bot (both sides bots); a filler
// game uses its own dedicated engine pool so it can't starve human bot-fill.
func (h *Hub) scheduleBotMove(g *game) {
	if g.over {
		return
	}
	// Secret Queen: a bot must never move before BOTH sides have designated —
	// its own side may already be picked (beginSecretQueenDesignation
	// designates a bot side immediately at creation), but the position isn't
	// playable until the human side is too, and LegalMoves() is deliberately
	// empty until then (secretqueen.go's newSecretQueenState/Designate). Every
	// call site that might reach here mid-designation (startBotGame's own
	// trailing call, the designation handlers once the SECOND side completes)
	// relies on this guard rather than each remembering to check first.
	if g.variant == variantSecretQueen && !g.secretQueenReady() {
		return
	}
	// presence.go's Feature B, gated to a genuine bot-vs-human, non-arena game
	// (botVsHumanSide already excludes fillers; arenaID excludes arena bot-fill
	// — see armBotDrop's doc for why arena must never see this at all).
	if bot, botColor, ok := g.botVsHumanSide(); ok && g.arenaID == "" {
		// A bot mid-"drop"/"leaves" (g.online flipped false by fireBotDrop) is
		// scheduled NOTHING until it's back online — fireBotReturn re-calls
		// scheduleBotMove the instant it flips online again, so a move that
		// came due during the outage is suppressed, not lost.
		if !g.online[botColor] {
			return
		}
		// presenceNoShow: never plays a first move at all, White or Black —
		// this falls through to the SAME 30s stall guard (firstMoveTimeout /
		// checkClocks) that already aborts any game whose clock never
		// started, so there is no separate "no result" path to get wrong for
		// this disposition. clocksRunning() needs two plies, so this single
		// check covers a White bot that never opens AND a Black bot that
		// never answers White's first move.
		if bot.presence == presenceNoShow && !g.clocksRunning() {
			return
		}
	}
	if variant.SelfSearches(g.variant) {
		h.scheduleSelfSearchBotMove(g)
		return
	}
	bot, botColor, ok := g.botPlayer()
	if !ok || g.state.Side() != botColor {
		return
	}
	engines := h.engines
	moveTimeCap := time.Duration(0) // human bot-fill: full rating ladder
	depthCap := 0                   // human bot-fill: honest strength (SPRT-gated, untouched)
	switch {
	case g.filler:
		// Watch-lobby cosmetic self-play: cheap, on its own dedicated pool so
		// it can never starve (or be starved by) anything else.
		engines = h.fillerEngines
		moveTimeCap = fillerMoveTimeCap
		depthCap = fillerSearchDepth
	case g.arenaID != "" && g.white.isBot && g.black.isBot:
		// Arena bot-vs-bot: also cheap, but its OWN dedicated pool
		// (h.arenaBotEngines, never h.fillerEngines) — see arena.go's
		// EnableArenaBotEngines doc for why the two must never share one. A
		// notch deeper/longer than a cosmetic filler since this game is real,
		// persisted, and rated (moves the standings) — see
		// arenaBotMoveTimeCap/arenaBotSearchDepth's doc.
		engines = h.arenaBotEngines
		moveTimeCap = arenaBotMoveTimeCap
		depthCap = arenaBotSearchDepth
	}
	if engines == nil {
		return // the relevant pool isn't enabled
	}
	// Normally the search rating IS the bot's own displayed rating (zugzwang's
	// ladder is human/FIDE-scale end-to-end — forward the display rating as-is).
	// consumeFullStrengthReplay overrides just this one search, and only the
	// exact move immediately after the human grants this bot's own takeback
	// request — see its doc and botAskTakeback's for why. displayRating stays
	// bot.rating either way: it drives botThinkDelay's pacing, not the search,
	// and the bot should still LOOK like itself even on the one move it plays
	// at full strength.
	rating := consumeFullStrengthReplay(g, bot.rating)
	go h.computeBotMove(botSnapshot{
		gameID:         g.id,
		ply:            len(g.moves),
		fen:            g.state.FEN(),
		history:        append([]uint64(nil), g.state.History()...),
		fenHistory:     g.fenHistory(),
		rating:         rating,
		displayRating:  bot.rating,
		moveTimeCap:    moveTimeCap,
		searchDepthCap: depthCap,
		tc:             g.tc,
		remainingMs:    g.remainingMs(botColor),
		legalCount:     len(g.state.LegalMoves()),
		pieceCount:     boardPieceCount(g.state.FEN()),
		lastMoveTo:     uciDest(g.lastUci()),
		floors:         scheduleFloors(g.filler),
		criticalMult:   g.consumeCriticalThink(botColor),
		inCheck:        g.status().Check,
	}, engines)
}

// scheduleSelfSearchBotMove computes a bot reply for a Tier-2 variant (its own
// search, e.g. Duck) OFF the Run goroutine and hands it back via botMoves — the
// same channel the engine-pool path uses, so the move is applied on the Run
// goroutine (never mutating game state off it). It leases no engine (the variant
// search is self-contained). Snapshots every value it needs here, then reads
// nothing shared in the goroutine.
func (h *Hub) scheduleSelfSearchBotMove(g *game) {
	bot, botColor, ok := g.botPlayer()
	if !ok || g.state.Side() != botColor {
		return
	}
	gameID := g.id
	ply := len(g.moves)
	variantID := g.variant
	fen := g.state.FEN() // canonical (self-describing) FEN for reconstruction
	extras := g.state.Extras()
	rating := bot.rating
	tc := g.tc
	remainingMs := g.remainingMs(botColor)
	legalCount := len(g.state.LegalMoves())
	pieceCount := boardPieceCount(fen)
	lastMoveTo := uciDest(g.lastUci())
	// Self-search variants never run as a Watch-lobby filler (filler.go's
	// startFillerGame only ever seeds standard chess), so this is always the
	// backfill floor ladder today — scheduleFloors(g.filler) rather than a
	// hardcoded backfill call so that stays true automatically if that ever
	// changes. Evals aren't reported for these variants (selfSearchMove returns
	// a move and nothing else — computeBotMove's doc), so criticalThinksOwed is
	// never armed here and consumeCriticalThink is always a no-op; the read is
	// kept for symmetry with the engine-pool path, not because it currently does
	// anything.
	floors := scheduleFloors(g.filler)
	criticalMult := g.consumeCriticalThink(botColor)
	inCheck := g.status().Check

	go func() {
		start := time.Now()
		uci, ok := h.selfSearchMove(variantID, fen, extras, rating)
		if !ok {
			return
		}
		// Pace with the same variant-agnostic delay as standard bots (real time, so it
		// comes off the bot's clock).
		mv := classifyMove(fen, uci, lastMoveTo, legalCount)
		delay := botThinkDelay(tc, remainingMs, legalCount, ply, rating, pieceCount, mv, floors, criticalMult, inCheck)
		if elapsed := time.Since(start); elapsed < delay {
			time.Sleep(delay - elapsed)
		}
		select {
		case h.botMoves <- botMoveResult{gameID: gameID, ply: ply, uci: uci}:
		case <-time.After(2 * time.Second):
			// Run goroutine wedged/gone; drop rather than leak.
		}
	}()
}

// selfSearchMove computes a bot move for a Tier-2 (self-search) variant,
// called off the Run goroutine by scheduleSelfSearchBotMove's goroutine.
// Crazyhouse, Duck and Antichess all routinely ask zugzwang's self-contained
// engines (Crazyhouse: pockets/drops/pocket-aware eval,
// zugzwang/src/crazyhouse.h; Duck: its own board/hand-eval/search,
// zugzwang/src/duck.h; Antichess: forced-capture rules/eval/search,
// zugzwang/src/antichess.h), mirroring the standard-chess zugzwangBestMove
// retry + emergency-fallback pattern (computeBotMove's doc) so a live game
// never freezes if zugzwang is down.
//
// ok=false means "no legal move" (mirrors variant.SelfSearchMove's own
// contract) OR "zugzwang unreachable and the emergency fallback is
// disabled" — either way the caller just skips posting a botMoveResult.
func (h *Hub) selfSearchMove(variantID, fen string, extras map[string]string, rating int) (string, bool) {
	if variantID == variant.Antichess && h.zugzwang != nil {
		const retries = 1
		var lastErr error
		for attempt := 0; attempt <= retries; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), h.zugzwang.Timeout())
			uci, err := h.zugzwang.AntichessBestMove(ctx, fen, rating)
			cancel()
			if err == nil {
				return uci, uci != "" // "" + nil error = genuinely no legal move
			}
			lastErr = err
		}
		if !h.emergencyInProc {
			fmt.Fprintf(os.Stderr, "hub: zugzwang antichess unreachable (%v) — emergency in-process fallback disabled, dropping bot move\n", lastErr)
			return "", false
		}
		fmt.Fprintf(os.Stderr, "hub: zugzwang antichess unreachable — emergency in-process move (%v)\n", lastErr)
		// fall through to the in-process path below
	}
	if variantID == variant.Crazyhouse && h.zugzwang != nil {
		const retries = 1
		var lastErr error
		for attempt := 0; attempt <= retries; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), h.zugzwang.Timeout())
			uci, err := h.zugzwang.CrazyhouseBestMove(ctx, fen, rating)
			cancel()
			if err == nil {
				return uci, uci != "" // "" + nil error = genuinely no legal move
			}
			lastErr = err
		}
		if !h.emergencyInProc {
			fmt.Fprintf(os.Stderr, "hub: zugzwang crazyhouse unreachable (%v) — emergency in-process fallback disabled, dropping bot move\n", lastErr)
			return "", false
		}
		fmt.Fprintf(os.Stderr, "hub: zugzwang crazyhouse unreachable — emergency in-process move (%v)\n", lastErr)
		// fall through to the in-process path below
	}
	if variantID == variant.SecretQueen && h.zugzwang != nil {
		const retries = 1
		var lastErr error
		for attempt := 0; attempt <= retries; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), h.zugzwang.Timeout())
			uci, err := h.zugzwang.SecretQueenBestMove(ctx, fen, rating)
			cancel()
			if err == nil {
				return uci, uci != "" // "" + nil error = genuinely no legal move
			}
			lastErr = err
		}
		// No emergency in-process fallback for this variant — it never had a
		// Go rules implementation (internal/variant/secretqueen.go's package
		// doc). emergencyInProc is irrelevant here; the move is simply
		// dropped, loudly.
		fmt.Fprintf(os.Stderr, "hub: zugzwang secretqueen unreachable (%v) — no emergency fallback exists for this variant, dropping bot move\n", lastErr)
		return "", false
	}
	if variantID == variant.Duck && h.zugzwang != nil {
		duck := extras["duck"]
		const retries = 1
		var lastErr error
		for attempt := 0; attempt <= retries; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), h.zugzwang.Timeout())
			uci, err := h.zugzwang.DuckBestMove(ctx, fen, duck, rating)
			cancel()
			if err == nil {
				return uci, uci != "" // "" + nil error = genuinely no legal move
			}
			lastErr = err
		}
		if !h.emergencyInProc {
			fmt.Fprintf(os.Stderr, "hub: zugzwang duck unreachable (%v) — emergency in-process fallback disabled, dropping bot move\n", lastErr)
			return "", false
		}
		fmt.Fprintf(os.Stderr, "hub: zugzwang duck unreachable — emergency in-process move (%v)\n", lastErr)
		// fall through to the in-process path below
	}
	return variant.SelfSearchMove(variantID, fen, extras, rating)
}

// computeBotMove runs OFF the Run goroutine: get a move — routinely from
// zugzwang over HTTP, with gomachine's in-process engine as an
// emergency-only last resort (see the Hub.zugzwang field doc) — pace it to
// feel human (the delay is real time, so it comes off the bot's clock), then
// hand it back via botMoves for application on the Run goroutine. `engines`
// is BOTH a concurrency permit bounding in-flight zugzwang requests AND,
// while held, a warm in-process engine ready for the emergency fallback. It
// is released as soon as the move is decided — BEFORE the human-pacing
// sleep below — so a slow/long-thinking bot doesn't tie up a pool slot other
// bot moves need; only the compute step itself holds the permit.
func (h *Hub) computeBotMove(s botSnapshot, engines chan *engineHandle) {
	pos, err := chess.ParseFEN(s.fen)
	if err != nil {
		return
	}
	start := time.Now()
	eng := <-engines

	var res engine.BestResult
	if h.zugzwang == nil {
		// No zugzwang backend configured (dev/test) — compute in-process
		// directly, exactly like before this backend existed.
		res = localBestMove(eng, pos, s)
	} else {
		res, err = h.zugzwangBestMove(s)
		if err != nil {
			if !h.emergencyInProc {
				engines <- eng
				fmt.Fprintf(os.Stderr, "hub: zugzwang unreachable (%v) — emergency in-process fallback disabled, dropping bot move for game %s\n", err, s.gameID)
				return
			}
			fmt.Fprintf(os.Stderr, "hub: zugzwang unreachable — emergency in-process move for game %s (%v)\n", s.gameID, err)
			res = localBestMove(eng, pos, s)
		}
	}
	engines <- eng
	if res.Move == chess.NullMove {
		return
	}

	mv := classifyMove(s.fen, res.Move.String(), s.lastMoveTo, s.legalCount)
	delay := botThinkDelay(s.tc, s.remainingMs, s.legalCount, s.ply, s.displayRating, s.pieceCount, mv, s.floors, s.criticalMult, s.inCheck)
	if elapsed := time.Since(start); elapsed < delay {
		time.Sleep(delay - elapsed)
	}

	select {
	case h.botMoves <- botMoveResult{
		gameID:    s.gameID,
		ply:       s.ply,
		uci:       res.Move.String(),
		evalCp:    res.Score,
		evalKnown: true,
	}:
	case <-time.After(2 * time.Second):
		// Run goroutine wedged/gone; drop rather than leak.
	}
}

// localBestMove computes a bot move with gomachine's in-process engine —
// EITHER because no zugzwang backend is configured (dev/test) OR as the
// emergency last resort when zugzwang didn't answer. Identical to the logic
// that ran unconditionally here before zugzwang existed.
func localBestMove(eng *engineHandle, pos *chess.Position, s botSnapshot) engine.BestResult {
	if s.searchDepthCap > 0 {
		return eng.BestMoveForRatingCapped(pos, s.rating, s.moveTimeCap, s.searchDepthCap, s.history)
	}
	return eng.BestMoveForRatingTimed(pos, s.rating, s.moveTimeCap, s.history)
}

// zugzwangBestMove asks zugzwang for a move, retrying once on failure (each
// attempt gets its own fresh deadline, h.zugzwang.Timeout() — the same
// per-attempt timeout SetZugzwangClient was configured with, so there's one
// timeout knob, not a second hardcoded one that could disagree with it). A
// nil error with a zero Move means "no legal move" (not a failure — see
// zugzwangClient.BestMove's doc) and is returned as-is without retrying.
func (h *Hub) zugzwangBestMove(s botSnapshot) (engine.BestResult, error) {
	const retries = 1
	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), h.zugzwang.Timeout())
		res, err := h.zugzwang.BestMove(ctx, s.fen, s.fenHistory, s.rating, s.moveTimeCap, s.searchDepthCap)
		cancel()
		if err == nil {
			return res, nil
		}
		lastErr = err
	}
	return engine.BestResult{}, lastErr
}

// applyBotMove plays a computed bot move on the Run goroutine, guarding against a
// stale game (ended, resigned, or already advanced while the bot was thinking).
func (h *Hub) applyBotMove(r botMoveResult) {
	g := h.games[r.gameID]
	if g == nil || g.over {
		return
	}
	// sideToMove()/botPlayer() read g.state, so this is variant-agnostic.
	if _, botColor, ok := g.botPlayer(); !ok || g.sideToMove() != botColor || len(g.moves) != r.ply {
		return
	}
	botColor := g.sideToMove()
	if _, ok := g.applyMove(r.uci); !ok {
		return
	}
	h.refreshLive(g) // keep the anti-cheat live-board FEN current
	h.broadcastState(g)
	if st := g.status(); st.State != "ongoing" {
		h.finish(g, st.Result, st.State)
		return
	}
	// The move carried the bot's own read of the position — record it, and let it
	// decide whether this is a game worth offering a draw in or giving up on.
	if r.evalKnown {
		g.recordBotEval(botColor, r.evalCp)
		h.considerBotConcession(g, botColor)
	}
	// In a filler (bot-vs-bot) game the other side is also a bot, so keep it
	// going. In a human-vs-bot game it is now the human's turn and this no-ops
	// (the next bot move is scheduled from move() when the human replies).
	h.scheduleBotMove(g)
}

const (
	// Snap out roughly the first this-many full moves quickly, ramping up to the
	// normal midgame pace — like rattling off an opening you know by heart.
	openingFastMoves = 10
	// Below this much clock the bot starts hurrying so it can flag-race instead of
	// thinking itself into a lost-on-time game...
	lowTimeMs int64 = 30_000
	// ...and below this it plays essentially as fast as it can.
	panicTimeMs int64 = 10_000

	// inCheckMult inflates both the central think budget and the floor when the
	// bot is the one in check. A human this often has a premove or a half-
	// decided reply already queued up; a check makes that illegal, so they have
	// to actually stop and look rather than just executing what they'd planned —
	// a genuine slowdown, not a paced-in flourish, which is why it scales the
	// WHOLE budget rather than adding a fixed pause.
	inCheckMult = 1.6
)

// botThinkDelay returns a randomized, human-ish pause before a bot's move, SCALED
// to the time control AND to the live state of the game: a slow control thinks
// longer than a fast one, the opening is rattled off quickly, and the bot speeds
// up sharply as its own clock runs low so it can actually win on time rather than
// flag. It also speeds up as material comes off — an eight-piece endgame is
// rattled out far quicker than a full-board middlegame, like a real player — and
// it paces by the KIND of move it settled on (`mv`): forced replies and
// recaptures SNAP out near-instantly, other captures come out clearly quicker
// than a quiet move, and pawn moves are a touch quicker again. Every move
// gets an independent, fat-tailed tempo jitter (occasional near-instant snaps and
// occasional long tanks) so the cadence looks hand-played rather than a smooth
// function of the state.
//
// Two more signals feed in, both real and both new: `inCheck` (the bot itself is
// in check — see inCheckMult's doc) inflates the whole budget AND the floor, and
// `criticalMult` (>1 when this move owes a "just noticed" think — see
// armCriticalThink / game.criticalThinksOwed) overrides the budget with a hard
// 2.5x-5x multiplier and pulls the floor up to at least the normal tier, so a
// bot that just watched its own eval swing hard doesn't blitz the reply the way
// a quiet move would.
//
// `floors` is the per-game floor ladder (scheduleFloors): a Watch-lobby filler
// runs a far higher one than a human-facing backfill bot, so a filler game can
// genuinely be decided on the clock instead of always reaching mate.
//
// The pause comes off the bot's clock (it's real time), so it's bounded: never
// more than ~30% of the remaining clock (won't flag), never more than
// maxThinkMs absolute (keeps slow controls sane and the untimed first move
// safely under the 30s first-move abort). Both the floor AND the in-check/
// critical-moment inflation are applied BEFORE those caps, not after — a raised
// floor must never be able to push the think past them; the caps get the last
// word, always.
func botThinkDelay(tc timeControl, remainingMs int64, legalCount, ply, displayRating, pieceCount int, mv moveTraits, floors thinkFloors, criticalMult float64, inCheck bool) time.Duration {
	// Rough per-move time budget: assume ~30 moves a side, plus the increment you
	// get back each move. e.g. 1+0 → 2s, 3+0 → 6s, 5+0 → 10s, 10+0 → 20s, 3+2 → 8s.
	perMove := float64(tc.Base)/30.0 + float64(tc.Inc)

	// A central per-move budget; the irregularity comes from the fat-tailed tempo
	// jitter applied below, not from this base.
	ms := perMove * 0.30
	// Busier positions take a touch longer.
	if legalCount > 30 {
		ms += perMove * 0.15
	}

	// Strength → speed: stronger players recognise positions faster and spend less
	// time per move; weaker players deliberate more. Scale the whole think from
	// ~1.25x at the low end down to ~0.70x at the top of the ladder.
	ms *= ratingSpeedFactor(displayRating)

	// Material → speed: fewer pieces means fewer candidate lines and more known
	// technique, so a sparse endgame is played much faster than a full board — the
	// "the less pieces, the faster they get" pacing. ~1.0x at a full board down to
	// ~0.40x once it's a bare-bones endgame.
	ms *= materialSpeedFactor(pieceCount)

	// Human irregularity: an independent per-move tempo multiplier so no two moves
	// take a similar time even in the same kind of position — mostly a moderate
	// spread, but deliberately fat-tailed with the odd near-instant snap and the odd
	// long tank. A snap move (forced or a recapture) instead gets a dedicated
	// snap band — fast, but still varied so it isn't robotically identical.
	if mv.snap() {
		ms *= 0.15 + mrand.Float64()*0.25 // 0.15–0.40x: played almost at once
	} else {
		ms *= humanTempoJitter()
		// A capture that isn't a recapture is still mostly pre-decided: you saw
		// the piece hanging (or the trade coming) while the opponent was moving,
		// so the hand goes out well before it would on a quiet move. Not as fast
		// as a recapture — there's usually still a "do I want this trade" beat.
		if mv.capture {
			ms *= 0.55 + mrand.Float64()*0.20 // 0.55–0.75x
		}
		// Pawn moves are the cheapest to read: few destinations, and the ones that
		// matter (a push you'd already planned, a recapture with a pawn) come out
		// almost by reflex. A small nudge, not a snap.
		if mv.pawnMove {
			ms *= 0.80 + mrand.Float64()*0.15 // 0.80–0.95x
		}
	}

	inOpening := ply/2 < openingFastMoves
	// Opening: rattle off known theory. Move MUCH faster for the first several full
	// moves, ramping on a quadratic curve so the very first moves are near-instant
	// and the pace only catches up to the midgame by openingFastMoves. ply counts
	// both sides, so divide to get full moves played.
	if inOpening {
		frac := float64(ply/2) / float64(openingFastMoves) // 0 → ~1
		ms *= 0.10 + 0.90*frac*frac                        // ~0.10x at move 1, ~full by move 10
	}

	// Time pressure: as the clock drops below lowTimeMs, shrink the think time
	// (quadratically, so it bites hardest right at the end) toward instant. By the
	// time we're under panicTimeMs the bot is essentially pre-moving to flag-race.
	if remainingMs < lowTimeMs {
		frac := float64(remainingMs) / float64(lowTimeMs) // 1 → 0
		ms *= frac * frac
	}

	// In check: see inCheckMult's doc. Applied after the time-pressure shrink so
	// it still shows up even in a fast-clock game, not swallowed by it.
	if inCheck {
		ms *= inCheckMult
	}

	// Critical moment: this bot's own eval just swung hard (armCriticalThink), so
	// this move gets a real "wait, what happened" think rather than its ordinary
	// pace — a final override on top of everything above, not a nudge, because
	// the whole point is that the move visibly stands out from the ones around it.
	if criticalMult > 1 {
		ms *= criticalMult
	}

	out := int64(ms)

	// The caps bound the COMPUTED think: no single move may eat 30% of what's left
	// or run past maxThinkMs (which also keeps the untimed first move safely under
	// the 30s abort).
	if cap := remainingMs * 3 / 10; out > cap {
		out = cap
	}
	const maxThinkMs = 12_000
	if out > maxThinkMs {
		out = maxThinkMs
	}

	// Floor LAST, deliberately outranking the caps above — this is the only path by
	// which any bot ever loses on time, and it is load-bearing for the filler.
	// Clamping the floor to 30% of the remaining clock instead makes the clock decay
	// geometrically and never reach zero, so a Watch-lobby game could not be decided
	// on the clock however low the flag floor was set. The floor is bounded and
	// small (a filler's is at most ~1.2s, a backfill bot's 250ms), so it can only
	// bite in the last fraction of a second, which is exactly when a real player
	// flags. A backfill bot keeps the original 250/90/60 ladder, so this does not
	// start gifting wins to humans.
	floor := floors.normal
	if inOpening {
		floor = floors.opening
	}
	if remainingMs < panicTimeMs {
		floor = floors.panic
	}
	if criticalMult > 1 && floor < floors.normal {
		// A critical-moment think must never collapse to the opening/panic
		// floor — a real player doesn't blitz the move right after a blunder
		// just because it's still early theory or the clock is low.
		floor = floors.normal
	}
	if inCheck {
		floor = int64(float64(floor) * inCheckMult)
	}
	if out < floor {
		out = floor
	}
	return time.Duration(out) * time.Millisecond
}

// ratingSpeedFactor maps a displayed rating to a pace multiplier: stronger players
// move faster. ~1.25x at 800 and below, tapering linearly to ~0.70x at 2400 and up.
func ratingSpeedFactor(displayRating int) float64 {
	const lo, hi = 800.0, 2400.0
	f := (float64(displayRating) - lo) / (hi - lo)
	if f < 0 {
		f = 0
	}
	if f > 1 {
		f = 1
	}
	return 1.25 - 0.55*f // 1.25 → 0.70
}

// materialSpeedFactor maps the number of pieces left on the board to a pace
// multiplier: a full board deliberates, a sparse endgame flies. ~1.0x at 32
// pieces (game start), tapering linearly to ~0.40x at 8-or-fewer pieces (a
// bare-bones endgame). Combined with the low-clock speed-up this makes a bot rip
// through K+P and R+P endings the way a human does, instead of pondering a
// three-piece position as long as the opening middlegame.
func materialSpeedFactor(pieceCount int) float64 {
	const full, sparse = 32.0, 8.0
	f := (float64(pieceCount) - sparse) / (full - sparse) // 0 at ≤8, 1 at ≥32
	if f < 0 {
		f = 0
	}
	if f > 1 {
		f = 1
	}
	return 0.40 + 0.60*f // 0.40 → 1.0
}

// boardPieceCount counts the pieces standing on the board in a FEN — the first
// (piece-placement) field — so bots can speed up as material comes off. Empty-run
// digits and rank separators are skipped; a Crazyhouse pocket suffix ("[...]") and
// the trailing FEN fields are cut off at the first '[' or space, so only real
// on-board pieces are counted. Variant-agnostic: standard/960/Duck place no extra
// glyphs in this field (the duck rides in Extras), and Crazyhouse's pocket is
// excluded by design — a full board is what should slow a bot down.
func boardPieceCount(fen string) int {
	n := 0
	for _, r := range fen {
		if r == ' ' || r == '[' {
			break // end of the placement field (space) or start of the pocket ('[')
		}
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			n++
		}
	}
	return n
}

// humanTempoJitter returns a per-move tempo multiplier that breaks the "smooth
// gradient" feel: even two moves in the same kind of position take visibly
// different times. It's fat-tailed on purpose — ~12% of moves are near-instant
// "snaps" (a move seen at a glance), ~10% are long "tanks" (a deep think), and the
// rest spread moderately around 1x — which reads as hand-played rather than a
// function of the game state.
func humanTempoJitter() float64 {
	switch r := mrand.Float64(); {
	case r < 0.12:
		return 0.20 + mrand.Float64()*0.35 // snap: 0.20–0.55x
	case r < 0.22:
		return 1.7 + mrand.Float64()*1.6 // tank: 1.7–3.3x
	default:
		return 0.55 + mrand.Float64()*0.95 // normal spread: 0.55–1.50x
	}
}

// moveTraits describes the KIND of move a bot settled on, so botThinkDelay can
// pace it the way a human's hand actually moves: some moves are decided long
// before it is your turn, and sitting on them for the full think budget is one
// of the strongest tells that nobody is really there. Every trait is derived
// from state the hub already has (the pre-move FEN, the UCI, the opponent's last
// destination) — no extra engine work — and holds for standard chess and the
// self-search variants alike. A true eval-based "only one good move" would need
// a per-move candidates pass, deliberately not paid for here.
type moveTraits struct {
	forced    bool // only one legal reply — nothing to think about
	recapture bool // lands on the square the opponent just moved to
	capture   bool // takes something (including en passant)
	pawnMove  bool // a pawn is doing the moving
}

// snap reports whether the move is the kind played almost without thinking, so
// the bot should rattle it out rather than pause: a forced reply or a recapture.
func (t moveTraits) snap() bool { return t.forced || t.recapture }

// classifyMove reads a move's traits off the position it is played in. `fen` is
// the pre-move FEN, `lastMoveTo` the destination square of the opponent's last
// move ("" if none). Crazyhouse drops ("P@e4") carry no from-square, so they
// classify as neither a capture nor a pawn move; Duck's composite UCI encodes
// the piece move first, so its from/to read normally.
func classifyMove(fen, moveUCI, lastMoveTo string, legalCount int) moveTraits {
	t := moveTraits{forced: legalCount <= 1}
	if len(moveUCI) < 4 {
		return t
	}
	if lastMoveTo != "" && uciDest(moveUCI) == lastMoveTo {
		t.recapture = true
	}
	from, to := moveUCI[0:2], moveUCI[2:4]
	mover := pieceAtFEN(fen, from)
	if mover == 0 {
		return t // a drop, or a from-square we can't read: no further traits
	}
	t.pawnMove = mover == 'P' || mover == 'p'
	victim := pieceAtFEN(fen, to)
	switch {
	case victim != 0:
		// Only an ENEMY piece is a capture — Chess960 encodes castling as
		// king-takes-own-rook (e1h1), which is not one.
		t.capture = isUpperPiece(mover) != isUpperPiece(victim)
	case t.pawnMove && from[0] != to[0]:
		t.capture = true // a pawn changing file onto an empty square: en passant
	}
	return t
}

// isUpperPiece reports whether a FEN piece glyph is White's (uppercase).
func isUpperPiece(c byte) bool { return c >= 'A' && c <= 'Z' }

// pieceAtFEN returns the FEN piece glyph standing on `sq` ("e4") in the
// placement field of `fen`, or 0 if the square is empty or unreadable. It walks
// the placement field textually rather than parsing the position, so it works
// for every variant that shares that field: the trailing FEN fields and a
// Crazyhouse pocket are cut off at the first space or '[', and Crazyhouse's
// promoted-piece marker ('~') is skipped without consuming a file.
func pieceAtFEN(fen, sq string) byte {
	if len(sq) < 2 {
		return 0
	}
	file, rank := int(sq[0]-'a'), int(sq[1]-'1')
	if file < 0 || file > 7 || rank < 0 || rank > 7 {
		return 0
	}
	wantRow := 7 - rank // the placement field runs rank 8 first
	row, col := 0, 0
	for i := 0; i < len(fen); i++ {
		switch c := fen[i]; {
		case c == ' ' || c == '[':
			return 0 // past the placement field
		case c == '/':
			row++
			col = 0
		case c >= '1' && c <= '8':
			col += int(c - '0')
		case c == '~':
			// promoted marker, belongs to the piece just read
		default:
			if row == wantRow && col == file {
				return c
			}
			col++
		}
		if row > wantRow {
			return 0
		}
	}
	return 0
}

// uciDest returns the destination square of a UCI move ("e2e4" → "e4", "e7e8q" →
// "e8"), or "" if the string is too short to carry one. Duck's composite move
// encodes the piece UCI first, so its primary destination reads the same way.
func uciDest(uci string) string {
	if len(uci) < 4 {
		return ""
	}
	return uci[2:4]
}

// --- fake identity ---

// syntheticBotIDPrefix marks a bot identity the hub invented itself (ordinary
// matchmaking backfill, Watch-lobby fillers) rather than one seated from a
// real BaseAPI account (arena bot participants — see arena.go's
// startArenaBotFillGame/topUpArenaBotVsBot, which use the roster's own sub
// verbatim and never this prefix). See isRealAccountSide in hub.go: a bot
// side is only registered in the live-player index when it does NOT carry
// this prefix, i.e. there's an actual account for a profile page to show.
const syntheticBotIDPrefix = "bot-"

// newBotIdentity builds a fill-in bot with a given displayed rating. No real
// account backs this identity — see syntheticBotIDPrefix.
func newBotIdentity(rating int) auth.Identity {
	return auth.Identity{
		UserID: syntheticBotIDPrefix + newID(),
		Anon:   false, // rendered like an account so the rating shows
		Name:   fakeUsername(),
		Rating: rating,
	}
}

// Bot strength matching. The fill-in bot's displayed rating wobbles around the
// human's by botRatingJitter, clamped to a sane band, and the engine level is
// derived from that displayed rating so the bot plays at roughly the strength it
// advertises.
const (
	botRatingJitter = 120  // ± Elo wobble around the human's rating
	botRatingMin    = 600  // floor for a displayed bot rating
	botRatingMax    = 2600 // ceiling for a displayed bot rating
)

// botDisplayRating picks the bot's shown rating near the human's, so a one-sided
// rated game is fair — the human's Elo moves against a number close to their own.
func botDisplayRating(userRating int) int {
	r := userRating + (mrand.IntN(2*botRatingJitter+1) - botRatingJitter)
	if r < botRatingMin {
		r = botRatingMin
	}
	if r > botRatingMax {
		r = botRatingMax
	}
	return r
}

// ratingForLevel converts the configured `-bot-level` flag (0..10, the anonymous
// fallback) into a nominal displayed Elo, since bots are now rating-driven
// (engine.BestMoveForRating / configForRating) rather than level-driven. Only the
// CLI fallback level still needs this bridge; logged-in players supply a real Elo.
func ratingForLevel(level int) int {
	return 600 + 180*level
}

var (
	botAdjs = []string{
		"Swift", "Silent", "Iron", "Lazy", "Cosmic", "Mad", "Quiet", "Turbo",
		"Sneaky", "Royal", "Frozen", "Hyper", "Grim", "Lucky", "Vivid", "Rusty",
		"Brave", "Sly", "Noble", "Wild", "Solar", "Crimson", "Velvet", "Atomic",
	}
	botNouns = []string{
		"Knight", "Pawn", "Rook", "Bishop", "Gambit", "Castle", "Falcon", "Otter",
		"Endgame", "Blitz", "Zugzwang", "Patzer", "Walrus", "Penguin", "Mongoose",
		"Tactician", "Capybara", "Comet", "Viper", "Badger", "Phoenix", "Raven",
	}
)

// fakeUsername builds a believable, varied handle (no external faker dependency).
func fakeUsername() string {
	a := botAdjs[mrand.IntN(len(botAdjs))]
	n := botNouns[mrand.IntN(len(botNouns))]
	switch mrand.IntN(5) {
	case 0:
		return strings.ToLower(a + "_" + n)
	case 1:
		return a + n + strconv.Itoa(mrand.IntN(99))
	case 2:
		return strings.ToLower(n) + strconv.Itoa(1985+mrand.IntN(25)) // looks like a birth year
	case 3:
		return a + n
	default:
		return n + strconv.Itoa(mrand.IntN(9999))
	}
}
