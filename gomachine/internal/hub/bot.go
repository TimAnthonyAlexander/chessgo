package hub

import (
	mrand "math/rand/v2"
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
	history        []uint64
	rating         int           // target Elo (rating-first ladder)
	displayRating  int           // shown Elo (human/CCRL scale) — drives pacing, not search
	moveTimeCap    time.Duration // >0 overrides the ladder budget (fillers: cheap, cosmetic)
	searchDepthCap int           // >0 hard-caps root-rank depth (fillers only; keeps search cheap)
	tc             timeControl   // pacing scales with the time control
	remainingMs    int64
	legalCount     int
}

// EnableBotFill turns on bot backfill: a player waiting longer than `delay` with
// no human match is paired with an engine opponent at `level`. `workers` pooled
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
			if now.Sub(c.queuedAt) >= h.botDelay {
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
		// and Duck feeds its own isolated "duck" pool, but Chess960 stays unrated.
		// Anonymous players can't be rated. Explicit /bot games never reach the hub.
		rated:     !human.id.Anon && (variantID == variantStandard || variantID == variantDuck),
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
		g.white = &player{client: human, id: human.id}
		g.black = &player{id: bot, isBot: true, rating: displayed}
	} else {
		g.white = &player{id: bot, isBot: true, rating: displayed}
		g.black = &player{client: human, id: human.id}
	}

	human.game = g
	h.games[g.id] = g
	h.playerGames[human.id.UserID] = g
	h.markLive(g)
	h.activeGames.Add(1)

	h.sendMatched(g, human, humanColor)
	h.scheduleBotMove(g) // if the bot plays White, it moves first
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
	if g.filler {
		engines = h.fillerEngines
		moveTimeCap = fillerMoveTimeCap // cosmetic self-play: cheap, capped think time
		depthCap = fillerSearchDepth    // ...and a shallow rank so search never dominates the delay
	}
	if engines == nil {
		return // the relevant pool isn't enabled
	}
	go h.computeBotMove(botSnapshot{
		gameID:  g.id,
		ply:     len(g.moves),
		fen:     g.state.FEN(),
		history: append([]uint64(nil), g.state.History()...),
		// Weaken to actual human strength (human scale), then lift onto the engine's
		// native CCRL ladder so the search produces the same play as before the rescale.
		rating:         engine.EngineRatingForHuman(humanizedEngineRating(bot.rating)),
		displayRating:  bot.rating,
		moveTimeCap:    moveTimeCap,
		searchDepthCap: depthCap,
		tc:             g.tc,
		remainingMs:    g.remainingMs(botColor),
		legalCount:     len(g.state.LegalMoves()),
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

	go func() {
		start := time.Now()
		uci, ok := variant.SelfSearchMove(variantID, fen, extras, rating)
		if !ok {
			return
		}
		// Pace with the same variant-agnostic delay as standard bots (real time, so it
		// comes off the bot's clock).
		delay := botThinkDelay(tc, remainingMs, legalCount, ply, rating)
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

// computeBotMove runs OFF the Run goroutine: search for a move (on a leased
// engine from `engines`), pace it to feel human (the delay is real time, so it
// comes off the bot's clock), then hand it back via botMoves for application on
// the Run goroutine.
func (h *Hub) computeBotMove(s botSnapshot, engines chan *engineHandle) {
	pos, err := chess.ParseFEN(s.fen)
	if err != nil {
		return
	}
	start := time.Now()
	eng := <-engines
	var res engine.BestResult
	if s.searchDepthCap > 0 {
		res = eng.BestMoveForRatingCapped(pos, s.rating, s.moveTimeCap, s.searchDepthCap, s.history)
	} else {
		res = eng.BestMoveForRatingTimed(pos, s.rating, s.moveTimeCap, s.history)
	}
	engines <- eng
	if res.Move == chess.NullMove {
		return
	}

	delay := botThinkDelay(s.tc, s.remainingMs, s.legalCount, s.ply, s.displayRating)
	if elapsed := time.Since(start); elapsed < delay {
		time.Sleep(delay - elapsed)
	}

	select {
	case h.botMoves <- botMoveResult{gameID: s.gameID, ply: s.ply, uci: res.Move.String()}:
	case <-time.After(2 * time.Second):
		// Run goroutine wedged/gone; drop rather than leak.
	}
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
// flag. The pause comes off the bot's clock (it's real time), so it's bounded:
// never more than ~30% of the remaining clock (won't flag), never more than
// maxThinkMs absolute (keeps slow controls sane and the untimed first move safely
// under the 30s first-move abort), and never below a human floor (which itself
// drops in real time trouble so the bot can blitz).
func botThinkDelay(tc timeControl, remainingMs int64, legalCount, ply, displayRating int) time.Duration {
	// Rough per-move time budget: assume ~30 moves a side, plus the increment you
	// get back each move. e.g. 1+0 → 2s, 3+0 → 6s, 5+0 → 10s, 10+0 → 20s, 3+2 → 8s.
	perMove := float64(tc.Base)/30.0 + float64(tc.Inc)

	// A typical move spends a varying fraction of that budget.
	ms := perMove * (0.12 + mrand.Float64()*0.40) // ~12%–52%
	// A few moves get a noticeably longer think.
	if mrand.Float64() < 0.12 {
		ms += perMove * (0.3 + mrand.Float64()*0.7)
	}
	// Busier positions take a touch longer.
	if legalCount > 30 {
		ms += perMove * 0.15
	}

	// Strength → speed: stronger players recognise positions faster and spend less
	// time per move; weaker players deliberate more. Scale the whole think from
	// ~1.25x at the low end down to ~0.70x at the top of the ladder.
	ms *= ratingSpeedFactor(displayRating)

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

// --- fake identity ---

// newBotIdentity builds a fill-in bot with a given displayed rating.
func newBotIdentity(rating int) auth.Identity {
	return auth.Identity{
		UserID: "bot-" + newID(),
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

// The engine's rating ladder (engine.configForRating) plays meaningfully STRONGER
// than it advertises through the lower/middle range — a nominal "1100" engine
// outplays a real 1100 human (it feels closer to ~1500: it doesn't blunder like a
// human does). For matchmaking fill-in bots that's a fairness problem: the bot is
// matched to the human's Elo so the one-sided rated game is fair, which only holds
// if the engine actually plays at that human strength. So before searching we remap
// the bot's displayed rating DOWN to a weaker effective ENGINE rating — the human
// still sees (and rates against) the displayed number; only the search is weakened.
//
// The handicap is largest at the weak end and tapers linearly to zero by
// botHandicapFloor, above which the ladder is genuinely at-strength. This applies
// ONLY to the hub's bots — the explicit /bot game picker goes straight through the
// engine and keeps its honest "engine strength" ratings.
//
// Magnitude is a first-draft from play feel ("1100 played like 1500"), not yet
// SPRT-calibrated against a human-anchored ladder — tune botMaxHandicap to taste.
const (
	botMaxHandicap   = 500            // max Elo shaved off the weakest fill-in bots
	botHandicapFloor = ratingCleanTop // at/above this displayed rating, no handicap
	// Human-scale floor above which the ladder is at-strength for a human of that
	// rating. This is a FIDE/human-scale number (backfill matches human Glicko); it is
	// deliberately NOT engine.ratingCleanFloor (which is on the CCRL scale, now 2600).
	ratingCleanTop = 2200
)

// humanizedEngineRating maps a fill-in bot's displayed rating to the (weaker)
// effective engine rating it should actually search at, so it plays like a human of
// that rating rather than like the over-strong engine ladder.
func humanizedEngineRating(displayed int) int {
	if displayed >= botHandicapFloor {
		return displayed
	}
	// Linear taper: full handicap at engine.RatingMin, zero at botHandicapFloor.
	u := float64(botHandicapFloor-displayed) / float64(botHandicapFloor-engine.RatingMin) // 0..1
	eff := displayed - int(float64(botMaxHandicap)*u+0.5)
	if eff < engine.RatingMin {
		eff = engine.RatingMin // configForRating clamps anyway; keep it explicit
	}
	return eff
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
