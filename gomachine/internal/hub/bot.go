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
	// A bot backfill always starts from the standard opening (960/mid-game seeds are
	// human-only); variant.New builds the right ruleset (Duck begins duck-unplaced).
	st, err := variant.New(variantID, chess.StartFEN)
	if err != nil {
		return // defensive: the standard start always parses
	}
	g := &game{
		id:    newID(),
		state: st,
		tc:    tc,
		pool:  pool,
		// A matchmaking bot fill-in is rated for a logged-in human (one-sided Elo
		// vs the bot), mirroring startGameWith: standard feeds the time-control pools
		// and Duck/Crazyhouse/Antichess each feed their own isolated pool, but
		// Chess960 stays unrated. Anonymous players can't be rated. Explicit /bot
		// games never reach the hub.
		rated: !human.id.Anon && (variantID == variantStandard || variantID == variantDuck ||
			variantID == variantCrazyhouse || variantID == variantAntichess),
		clockMs:   [2]int64{tc.Base, tc.Base},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  chess.StartFEN,
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

	h.sendMatched(g, human, humanColor)
	h.joinOtherSessions(g, human) // open it on this account's other devices too
	h.scheduleBotMove(g)          // if the bot plays White, it moves first
	h.maybeOpeningChat(g)         // ...and it might open with a friendly "hi"
}

// scheduleBotMove starts async move computation when it is a bot's turn. Works
// for human-vs-bot (one bot) and filler bot-vs-bot (both sides bots); a filler
// game uses its own dedicated engine pool so it can't starve human bot-fill.
func (h *Hub) scheduleBotMove(g *game) {
	if g.over {
		return
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
	// A Watch-lobby filler OR an arena bot-vs-bot game both use the same cheap,
	// dedicated filler engine pool so neither can ever starve human bot-fill —
	// the only difference between the two is g.filler, which additionally
	// skips persistence/Elo (an arena bot-vs-bot game IS persisted, so both
	// bots score; see arena.go's topUpArenaBotVsBot).
	if g.filler || (g.arenaID != "" && g.white.isBot && g.black.isBot) {
		engines = h.fillerEngines
		moveTimeCap = fillerMoveTimeCap // cosmetic self-play: cheap, capped think time
		depthCap = fillerSearchDepth    // ...and a shallow rank so search never dominates the delay
	}
	if engines == nil {
		return // the relevant pool isn't enabled
	}
	go h.computeBotMove(botSnapshot{
		gameID:     g.id,
		ply:        len(g.moves),
		fen:        g.state.FEN(),
		history:    append([]uint64(nil), g.state.History()...),
		fenHistory: g.fenHistory(),
		// zugzwang's rating ladder is human/FIDE-scale end-to-end (RatingMin=700..
		// RatingMax=2900, full strength at the top) — forward the display rating as-is.
		rating:         bot.rating,
		displayRating:  bot.rating,
		moveTimeCap:    moveTimeCap,
		searchDepthCap: depthCap,
		tc:             g.tc,
		remainingMs:    g.remainingMs(botColor),
		legalCount:     len(g.state.LegalMoves()),
		pieceCount:     boardPieceCount(g.state.FEN()),
		lastMoveTo:     uciDest(g.lastUci()),
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

	go func() {
		start := time.Now()
		uci, ok := h.selfSearchMove(variantID, fen, extras, rating)
		if !ok {
			return
		}
		// Pace with the same variant-agnostic delay as standard bots (real time, so it
		// comes off the bot's clock).
		obvious := isObviousMove(uci, lastMoveTo, legalCount)
		delay := botThinkDelay(tc, remainingMs, legalCount, ply, rating, pieceCount, obvious)
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

	obvious := isObviousMove(res.Move.String(), s.lastMoveTo, s.legalCount)
	delay := botThinkDelay(s.tc, s.remainingMs, s.legalCount, s.ply, s.displayRating, s.pieceCount, obvious)
	if elapsed := time.Since(start); elapsed < delay {
		time.Sleep(delay - elapsed)
	}

	select {
	case h.botMoves <- botMoveResult{gameID: s.gameID, ply: s.ply, uci: res.Move.String()}:
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
	if _, ok := g.applyMove(r.uci); !ok {
		return
	}
	h.refreshLive(g) // keep the anti-cheat live-board FEN current
	h.broadcast(g, mustJSON(out("state", g.snapshot())))
	if st := g.status(); st.State != "ongoing" {
		h.finish(g, st.Result, st.State)
		return
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
)

// botThinkDelay returns a randomized, human-ish pause before a bot's move, SCALED
// to the time control AND to the live state of the game: a slow control thinks
// longer than a fast one, the opening is rattled off quickly, and the bot speeds
// up sharply as its own clock runs low so it can actually win on time rather than
// flag. It also speeds up as material comes off — an eight-piece endgame is
// rattled out far quicker than a full-board middlegame, like a real player — and
// SNAPS out `obvious` moves (forced or a recapture) near-instantly. Every move
// gets an independent, fat-tailed tempo jitter (occasional near-instant snaps and
// occasional long tanks) so the cadence looks hand-played rather than a smooth
// function of the state. The pause comes off the bot's clock (it's real time), so
// it's bounded: never more than ~30% of the remaining clock (won't flag), never
// more than maxThinkMs absolute (keeps slow controls sane and the untimed first
// move safely under the 30s first-move abort), and never below a human floor
// (which itself drops in real time trouble so the bot can blitz).
func botThinkDelay(tc timeControl, remainingMs int64, legalCount, ply, displayRating, pieceCount int, obvious bool) time.Duration {
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
	// long tank. An `obvious` move (forced or a recapture) instead gets a dedicated
	// snap band — fast, but still varied so it isn't robotically identical.
	if obvious {
		ms *= 0.15 + mrand.Float64()*0.25 // 0.15–0.40x: played almost at once
	} else {
		ms *= humanTempoJitter()
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

	out := int64(ms)

	if cap := remainingMs * 3 / 10; out > cap {
		out = cap
	}
	const maxThinkMs = 12_000
	if out > maxThinkMs {
		out = maxThinkMs
	}
	// Human floor — lower in the opening (theory comes out quick), and lower still
	// in genuine time trouble so the bot can blitz.
	floor := int64(250)
	if inOpening {
		floor = 90
	}
	if remainingMs < panicTimeMs {
		floor = 60
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

// isObviousMove reports whether a move is the kind a human plays almost without
// thinking, so the bot should snap it out: a forced move (only one legal reply) or
// a recapture (landing on the very square the opponent just moved to, i.e. taking
// the piece they just placed there). Both are computed from state the hub already
// has — no extra engine work — and hold for standard and self-search variants
// alike. A true eval-based "only one good move" would need a per-move candidates
// pass, deliberately not paid for here.
func isObviousMove(moveUCI, lastMoveTo string, legalCount int) bool {
	if legalCount <= 1 {
		return true // forced: nothing to think about
	}
	if lastMoveTo != "" && uciDest(moveUCI) == lastMoveTo {
		return true // recapture on the opponent's last-touched square
	}
	return false
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
