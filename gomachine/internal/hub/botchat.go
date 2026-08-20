package hub

import (
	mrand "math/rand/v2"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// This file makes a fill-in bot opponent chat like a real person: an occasional
// opening hello, and occasional short replies to what the human types. It is
// deliberately understated — a real online opponent mostly stays quiet. The text
// itself is produced by an injected generator (BotChatFunc, wired to BaseAPI's
// OpenAI endpoint); everything here is the *behaviour* around it — who chats,
// how often, and the human-like pacing.
//
// Concurrency: the trigger points (game start, an incoming human line, game
// over) run on the Run goroutine and only read a snapshot. The generator call +
// typing pauses run on a spawned goroutine (it makes a network request, which
// must never block the hub), and each finished line is handed back over botChats
// for broadcast on the Run goroutine through the SAME chat path a human uses —
// so the frontend never learns the opponent is a bot.

// botChatMaxHistory bounds the recent chat kept per game for reply context.
const botChatMaxHistory = 16

// botChatCooldown is the minimum gap between a fill-in bot's replies. It stops
// the bot from stacking a separate answer onto every line of a fast burst ("are
// you there??" / "!!!" / ":("), which reads as robotic — a real person answers
// the burst once. It comfortably covers one reply's think+type delay.
const botChatCooldown = 7 * time.Second

// botChatTeardownTimeout is how long a finished bot game waits for its farewell
// chat to land before tearing down the game anyway (e.g. OpenAI unreachable).
const botChatTeardownTimeout = 5 * time.Second

// chatPersona is a fill-in bot's chat character, rolled ONCE when its game starts
// and then FIXED for the whole game — so the opponent feels like one consistent
// person (a quiet player stays quiet, a talkative one stays talkative, in a
// steady voice) instead of re-rolling its mood on every message. nil for
// human-vs-human and filler games (they never chat).
type chatPersona struct {
	opens       bool    // did this person open the game with a greeting?
	replyChance float64 // fixed probability they answer a given message
	multiChance float64 // fixed probability an answer is two quick lines
	style       string  // a short voice descriptor, sent to the generator for consistency
}

// There are two kinds of online chess opponent, and both are here. The QUIET one
// (most of them) types "hf" at the start, "gg" at the end, and otherwise treats
// the chat box as furniture — if you pull an answer out of them it's two words
// and defensive. The TALKER answers most lines, but is still terse and a bit odd,
// friendly at the start and quick to sour. Nobody in here is a coach or a fan.
var quietChatStyles = []string{
	"barely chats — hf at the start, gg at the end, and two-word answers at most if pushed",
	"heads-down on the board, treats the chat box as an annoyance",
	"curt and guarded, answers in one or two flat words or not at all",
	"silent type, replies only when directly asked and even then says almost nothing",
}

var talkerChatStyles = []string{
	"friendly at the start but thin-skinned — goes cold and clipped the second they needle you",
	"dry and sarcastic, one-liners only, never earnest",
	"quietly cocky, small jabs when you're ahead, defensive when you're behind",
	"a bit odd — short random remarks that don't quite follow the conversation",
	"over-familiar and blunt, talks like you two have history",
}

// newChatPersona rolls a stable chat character: mostly the quiet archetype (that
// is what online chess actually looks like), sometimes the talker. The bucket
// picks the reply probability AND the voice pool, so a quiet persona never draws
// a chatty voice and vice-versa.
func newChatPersona() *chatPersona {
	if mrand.Float64() < 0.70 { // quiet: hf / gg and little else
		return &chatPersona{
			opens:       mrand.Float64() < 0.70,
			replyChance: 0.14,
			multiChance: 0.02,
			style:       quietChatStyles[mrand.IntN(len(quietChatStyles))],
		}
	}
	return &chatPersona{ // talker: answers most lines, still short
		opens:       mrand.Float64() < 0.85,
		replyChance: 0.75,
		multiChance: 0.12,
		style:       talkerChatStyles[mrand.IntN(len(talkerChatStyles))],
	}
}

// BotChatTurn is one prior chat line handed to the generator as context (oldest
// first). FromBot marks the bot's own lines so the model can hold a thread.
type BotChatTurn struct {
	FromBot bool   `json:"fromBot"`
	Text    string `json:"text"`
}

// BotChatRequest is the immutable context passed to the generator. It runs OFF
// the Run goroutine, so every field is a copy — it touches no live game state.
type BotChatRequest struct {
	Bot      string        `json:"bot"`      // the bot's display name (persona)
	Rating   int           `json:"rating"`   // the bot's displayed rating (flavour only)
	Opponent string        `json:"opponent"` // the human's display name
	Kind     string        `json:"kind"`     // "opening" (unprompted), "reply", or "farewell" (game-over)
	Style    string        `json:"style"`    // the persona's fixed voice, held all game
	History  []BotChatTurn `json:"history"`  // recent chat, oldest first
	Count    int           `json:"count"`    // short lines to produce (1, sometimes 2)

	// Game-state snapshot so the bot can react to checks, captures, and the
	// position instead of just reading chat history. Empty for opening-kind
	// requests (no moves played yet).
	Fen               string `json:"fen"`               // current board FEN
	LastMove          string `json:"lastMove"`          // last move in SAN, "" if none
	InCheck           bool   `json:"inCheck"`           // someone is in check
	Checker           string `json:"checker"`           // "bot" or "opponent" — who is in check, "" if none
	MaterialAdvantage int    `json:"materialAdvantage"` // rough centipawns bot is ahead (>300 = up a piece, <−300 = down), 0 if even or uncomputed
	EndReason         string `json:"endReason"`         // "checkmate" | "stalemate" | "flag" | "resign" | "abort" | "" (ongoing)
	EndResult         string `json:"endResult"`         // "1-0" | "0-1" | "1/2-1/2" | "" (ongoing)
	BotColor          string `json:"botColor"`          // "w" or "b" — which side the bot is playing
}

// BotChatFunc generates up to req.Count short, human-like chat lines for a
// fill-in bot. It may block on I/O (it calls out to BaseAPI/OpenAI). An empty or
// nil result means "say nothing". Injected via Hub.OnBotChat; nil disables bot
// chat entirely (the hub simply stays quiet).
type BotChatFunc func(BotChatRequest) []string

// botChatResult is one generated line, delivered back to the Run goroutine for
// broadcast through the normal chat path.
type botChatResult struct {
	gameID   string
	text     string
	farewell bool // game-over farewell; teardown the game after this line is delivered
}

// OnBotChat registers the text generator for fill-in bot chat. Call before Run.
func (h *Hub) OnBotChat(fn BotChatFunc) { h.botChatFn = fn }

// botVsHumanSide returns the fill-in bot opponent and its color in a human-vs-bot
// game. ok=false for human-vs-human games and for engine-vs-engine fillers (no
// human to chat with) — so chat only ever animates a real backfill opponent.
func (g *game) botVsHumanSide() (*player, chess.Color, bool) {
	if g.filler {
		return nil, 0, false
	}
	if g.white.isBot == g.black.isBot {
		return nil, 0, false // both human (or, defensively, both bot)
	}
	if g.white.isBot {
		return g.white, chess.White, true
	}
	return g.black, chess.Black, true
}

// maybeOpeningChat opens the game with a greeting IF this bot's persona is one
// that opens (decided once, when the persona was rolled). Run-goroutine entry;
// the work is off-loop.
func (h *Hub) maybeOpeningChat(g *game) {
	bot, _, ok := g.botVsHumanSide()
	if !ok || h.botChatFn == nil || g.chat == nil || !g.chat.opens {
		return
	}
	h.generateBotChat(g.id, BotChatRequest{
		Bot:      bot.id.Name,
		Rating:   bot.rating,
		Opponent: g.humanName(),
		Kind:     "opening",
		Style:    g.chat.style,
		Count:    1,
	}, botChatOpeningDelay(), false)
}

// maybeReplyChat gives a fill-in bot a chance to answer the human's latest line,
// using its FIXED persona reply probability (so a quiet opponent stays quiet and
// a chatty one stays chatty for the whole game). Called on the Run goroutine
// right after the human's message is recorded, so g.chatLog already includes it.
// A cooldown keeps it from answering every line of a fast burst.
func (h *Hub) maybeReplyChat(g *game) {
	bot, botColor, ok := g.botVsHumanSide()
	if !ok || h.botChatFn == nil || g.chat == nil || g.over {
		return
	}
	if time.Now().Before(g.chatCooldownUntil) {
		return // just answered / a reply is in flight — don't stack another
	}
	if mrand.Float64() >= g.chat.replyChance {
		return
	}
	count := 1
	if mrand.Float64() < g.chat.multiChance {
		count = 2
	}
	g.chatCooldownUntil = time.Now().Add(botChatCooldown)

	req := BotChatRequest{
		Bot:      bot.id.Name,
		Rating:   bot.rating,
		Opponent: g.humanName(),
		Kind:     "reply",
		Style:    g.chat.style,
		History:  append([]BotChatTurn(nil), g.chatLog...),
		Count:    count,
	}
	req.Fen = g.boardFEN()
	if len(g.sans) > 0 {
		req.LastMove = g.sans[len(g.sans)-1]
	}
	st := g.status()
	req.InCheck = st.Check
	if st.Check {
		if g.sideToMove() == botColor {
			req.Checker = "bot"
		} else {
			req.Checker = "opponent"
		}
	}
	req.MaterialAdvantage = materialAdvantage(g.boardFEN(), botColor)

	h.generateBotChat(g.id, req, botChatReplyDelay(), false)
}

// maybeGameOverChat is the bot's one-shot farewell when the game ends — a "gg",
// "well played", or commiseration depending on how it ended. Called from finish()
// BEFORE g.over flips to true (so botVsHumanSide still sees a live game). Every
// persona fires one (the game IS ending — staying silent here reads as abandoned,
// not "quiet"), but the wording fits the voice. The farewell is delivered
// asynchronously; teardown is deferred until it lands (or a 5s timeout).
func (h *Hub) maybeGameOverChat(g *game, result, reason string) {
	bot, botColor, ok := g.botVsHumanSide()
	if !ok || h.botChatFn == nil || g.chat == nil {
		return
	}
	h.generateBotChat(g.id, BotChatRequest{
		Bot:      bot.id.Name,
		Rating:   bot.rating,
		Opponent: g.humanName(),
		Kind:     "farewell",
		Style:    g.chat.style,
		Count:    1,
		// Game-over context.
		Fen:               g.boardFEN(),
		MaterialAdvantage: materialAdvantage(g.boardFEN(), botColor),
		EndReason:         reason,
		EndResult:         result,
		BotColor:          colorStr(botColor),
	}, botChatFarewellDelay(), true)
}

// materialAdvantage returns a rough material score (centipawns) from the bot's
// perspective — positive means the bot is ahead. Piece values are intentionally
// coarse (a pawn is 100, a knight ~320, a queen 900) because the goal is a rough
// "up a piece / down a piece / roughly even" signal for chat flavour. Zero for a
// FEN that doesn't parse.
func materialAdvantage(fen string, botColor chess.Color) int {
	// Walk the piece-placement field only (up to the first space).
	var w, b int
	done := false
	for _, r := range fen {
		if r == ' ' {
			done = true
		}
		if done {
			continue
		}
		switch r {
		case 'P':
			w += 100
		case 'N':
			w += 320
		case 'B':
			w += 330
		case 'R':
			w += 500
		case 'Q':
			w += 900
		case 'p':
			b += 100
		case 'n':
			b += 320
		case 'b':
			b += 330
		case 'r':
			b += 500
		case 'q':
			b += 900
		}
	}
	diff := w - b
	if botColor == chess.Black {
		diff = -diff
	}
	return diff
}

// generateBotChat runs the generator OFF the Run goroutine (it makes a network
// call), paces the output like a person typing, and hands each finished line back
// over botChats for broadcast. Silently drops everything if the generator returns
// nothing. When farewell is true, the delivered result carries a teardown signal
// so the game is cleaned up once the farewell lands.
func (h *Hub) generateBotChat(gameID string, req BotChatRequest, initialDelay time.Duration, farewell bool) {
	fn := h.botChatFn
	if fn == nil {
		return
	}
	go func() {
		time.Sleep(initialDelay)
		lines := fn(req)
		sent := 0
		for _, line := range lines {
			if sent >= req.Count {
				break
			}
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if sent > 0 {
				time.Sleep(botChatBetweenDelay(line)) // a beat, as if typing the follow-up
			}
			select {
			case h.botChats <- botChatResult{gameID: gameID, text: line, farewell: farewell && sent == 0}:
				sent++
			case <-time.After(2 * time.Second):
				return // Run goroutine wedged/gone; drop rather than leak
			}
		}
	}()
}

// deliverBotChat broadcasts a generated bot line on the Run goroutine. A game
// that ended by the time this line was written is still delivered (the opponent
// may be on the result screen, and a "gg" is just as appropriate there). If the
// result is a farewell, teardown the game afterward — the farewell was the last
// thing the bot said, and the deferred cleanup can now run.
func (h *Hub) deliverBotChat(r botChatResult) {
	g := h.games[r.gameID]
	if g == nil {
		return
	}
	bot, botColor, ok := g.botVsHumanSide()
	if !ok {
		return
	}
	text := sanitizeChat(r.text)
	if text == "" {
		return
	}
	g.appendChat(true, text)
	h.broadcastPlayers(g, mustJSON(out("chat", map[string]any{
		"gameId": g.id,
		"by":     colorStr(botColor),
		"name":   bot.id.Name,
		"text":   text,
	})))
	if r.farewell && g.over {
		// The farewell landed — clean up the game now (it was kept in h.games
		// past finish() specifically so this delivery could find it).
		h.teardown(g)
	}
}

// --- human-like pacing (all real time; unrelated to the game clock) ---

// botChatOpeningDelay: a few seconds after the game opens, like someone settling
// in before typing "hi".
func botChatOpeningDelay() time.Duration {
	return time.Duration(1500+mrand.IntN(3500)) * time.Millisecond // 1.5s–5.0s
}

// botChatReplyDelay: read the message, then start typing a reply.
func botChatReplyDelay() time.Duration {
	return time.Duration(1200+mrand.IntN(2600)) * time.Millisecond // 1.2s–3.8s
}

// botChatFarewellDelay: a quick "gg" or "wp" right after the game ends — shorter
// than a mid-game reply because the outcome is already known.
func botChatFarewellDelay() time.Duration {
	return time.Duration(200+mrand.IntN(800)) * time.Millisecond // 0.2s–1.0s
}

// botChatBetweenDelay: the pause before a follow-up line, scaled a little by how
// long the line is (a longer line "takes longer to type").
func botChatBetweenDelay(line string) time.Duration {
	base := 700 + mrand.IntN(1200)          // 0.7s–1.9s
	base += min(len([]rune(line)), 40) * 25 // + up to ~1s for length
	return time.Duration(base) * time.Millisecond
}
