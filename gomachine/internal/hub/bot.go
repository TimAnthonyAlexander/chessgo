package hub

import (
	mrand "math/rand/v2"
	"strconv"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
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
	gameID      string
	ply         int
	fen         string
	history     []uint64
	rating      int           // target Elo (rating-first ladder)
	moveTimeCap time.Duration // >0 overrides the ladder budget (fillers: cheap, cosmetic)
	tc          timeControl   // pacing scales with the time control
	remainingMs int64
	legalCount  int
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
	for pool := range h.pools {
		var kept, promote []*Client
		for _, c := range h.pools[pool] {
			if now.Sub(c.queuedAt) >= h.botDelay {
				promote = append(promote, c)
			} else {
				kept = append(kept, c)
			}
		}
		if len(kept) == 0 {
			delete(h.pools, pool)
		} else {
			h.pools[pool] = kept
		}
		tc, ok := parseTimeControl(pool)
		if !ok {
			continue
		}
		for _, c := range promote {
			c.pool = ""
			h.startBotGame(c, tc, pool)
		}
	}
}

// startBotGame pairs a human with a fresh random bot opponent. To the client it
// looks like any other match (name + rating in the matched payload).
func (h *Hub) startBotGame(human *Client, tc timeControl, pool string) {
	if human.game != nil {
		return
	}
	// Anchor the bot near the human's rating in this category so a one-sided rated
	// game is fair: the bot's displayed rating (what the human's Elo moves against)
	// sits within a small jitter of the human's, and the engine plays at roughly
	// that strength. Anonymous players have no rating, so fall back to the
	// configured default level's nominal rating.
	userRating := human.id.RatingFor(categoryForPool(pool))
	if userRating <= 0 {
		userRating = ratingForLevel(h.botLevel)
	}
	displayed := botDisplayRating(userRating)
	bot := newBotIdentity(displayed)
	pos, _ := chess.ParseFEN(chess.StartFEN)
	g := &game{
		id:   newID(),
		pos:  pos,
		tc:   tc,
		pool: pool,
		// A matchmaking bot fill-in is rated for a logged-in human (one-sided Elo
		// vs the bot). Anonymous players can't be rated. Explicitly chosen /bot
		// games never reach the hub, so they're unaffected.
		rated:     !human.id.Anon,
		clockMs:   [2]int64{tc.Base, tc.Base},
		turnStart: time.Now(),
		online:    [2]bool{true, true},
		startFen:  chess.StartFEN,
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
	bot, botColor, ok := g.botPlayer()
	if !ok || g.pos.SideToMove() != botColor {
		return
	}
	engines := h.engines
	moveTimeCap := time.Duration(0) // human bot-fill: full rating ladder
	if g.filler {
		engines = h.fillerEngines
		moveTimeCap = fillerMoveTimeCap // cosmetic self-play: cheap, capped think time
	}
	if engines == nil {
		return // the relevant pool isn't enabled
	}
	go h.computeBotMove(botSnapshot{
		gameID:      g.id,
		ply:         len(g.moves),
		fen:         g.pos.FEN(),
		history:     append([]uint64(nil), g.history...),
		// Weaken to actual human strength (human scale), then lift onto the engine's
		// native CCRL ladder so the search produces the same play as before the rescale.
		rating:      engine.EngineRatingForHuman(humanizedEngineRating(bot.rating)),
		moveTimeCap: moveTimeCap,
		tc:          g.tc,
		remainingMs: g.remainingMs(botColor),
		legalCount:  len(g.pos.LegalMoveStrings(chess.SqNone)),
	}, engines)
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
	res := eng.BestMoveForRatingTimed(pos, s.rating, s.moveTimeCap, s.history)
	engines <- eng
	if res.Move == chess.NullMove {
		return
	}

	delay := botThinkDelay(s.tc, s.remainingMs, s.legalCount, s.ply)
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
	if _, botColor, ok := g.botPlayer(); !ok || g.pos.SideToMove() != botColor || len(g.moves) != r.ply {
		return
	}
	if _, ok := g.applyMove(r.uci); !ok {
		return
	}
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
	openingFastMoves = 8
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
func botThinkDelay(tc timeControl, remainingMs int64, legalCount, ply int) time.Duration {
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

	// Opening: move fast for the first several full moves, ramping from ~0.35x at
	// the very start up to the full midgame pace by openingFastMoves. ply counts
	// both sides, so divide to get full moves played.
	if moves := ply / 2; moves < openingFastMoves {
		frac := float64(moves) / float64(openingFastMoves) // 0 → ~1
		ms *= 0.35 + 0.65*frac
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
	// Human floor — but in genuine time trouble drop it so the bot can blitz.
	floor := int64(250)
	if remainingMs < panicTimeMs {
		floor = 60
	}
	if out < floor {
		out = floor
	}
	return time.Duration(out) * time.Millisecond
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
