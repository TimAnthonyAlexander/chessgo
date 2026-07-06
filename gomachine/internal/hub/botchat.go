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
// Concurrency: the trigger points (game start, an incoming human line) run on the
// Run goroutine and only read a snapshot. The generator call + typing pauses run
// on a spawned goroutine (it makes a network request, which must never block the
// hub), and each finished line is handed back over botChats for broadcast on the
// Run goroutine through the SAME chat path a human uses — so the frontend never
// learns the opponent is a bot.

// botChatMaxHistory bounds the recent chat kept per game for reply context.
const botChatMaxHistory = 16

// botChatCooldown is the minimum gap between a fill-in bot's replies. It stops
// the bot from stacking a separate answer onto every line of a fast burst ("are
// you there??" / "!!!" / ":("), which reads as robotic — a real person answers
// the burst once. It comfortably covers one reply's think+type delay.
const botChatCooldown = 7 * time.Second

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

// chatStyles are the voices a fill-in bot can be given. One is picked per game
// and held for its whole duration, so the persona (and its phrasing) stays
// consistent — and so different games don't all sound identical.
var chatStyles = []string{
	"friendly and relaxed, easygoing",
	"quiet and focused on the game, says little",
	"dry and a bit sarcastic",
	"upbeat and talkative",
	"chill, low energy, casual",
	"competitive and lightly cocky, but not rude",
	"polite and sportsmanlike",
	"goofy, likes a bad joke",
}

// newChatPersona rolls a stable chat character. Talkativeness is bucketed and
// weighted toward the quiet/normal middle (most online opponents barely chat);
// each bucket sets a FIXED reply probability for the rest of the game.
func newChatPersona() *chatPersona {
	var reply, multi, openChance float64
	switch r := mrand.Float64(); {
	case r < 0.35: // quiet: rarely says anything
		reply, multi, openChance = 0.15, 0.04, 0.20
	case r < 0.80: // normal
		reply, multi, openChance = 0.45, 0.10, 0.45
	default: // chatty
		reply, multi, openChance = 0.80, 0.18, 0.75
	}
	return &chatPersona{
		opens:       mrand.Float64() < openChance,
		replyChance: reply,
		multiChance: multi,
		style:       chatStyles[mrand.IntN(len(chatStyles))],
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
	Kind     string        `json:"kind"`     // "opening" (unprompted) or "reply"
	Style    string        `json:"style"`    // the persona's fixed voice, held all game
	History  []BotChatTurn `json:"history"`  // recent chat, oldest first
	Count    int           `json:"count"`    // short lines to produce (1, sometimes 2)
}

// BotChatFunc generates up to req.Count short, human-like chat lines for a
// fill-in bot. It may block on I/O (it calls out to BaseAPI/OpenAI). An empty or
// nil result means "say nothing". Injected via Hub.OnBotChat; nil disables bot
// chat entirely (the hub simply stays quiet).
type BotChatFunc func(BotChatRequest) []string

// botChatResult is one generated line, delivered back to the Run goroutine for
// broadcast through the normal chat path.
type botChatResult struct {
	gameID string
	text   string
}

// OnBotChat registers the text generator for fill-in bot chat. Call before Run.
func (h *Hub) OnBotChat(fn BotChatFunc) { h.botChatFn = fn }

// chatBotSide returns the fill-in bot opponent and its color in a human-vs-bot
// game. ok=false for human-vs-human games and for engine-vs-engine fillers (no
// human to chat with) — so chat only ever animates a real backfill opponent.
func (g *game) chatBotSide() (*player, chess.Color, bool) {
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
	bot, _, ok := g.chatBotSide()
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
	}, botChatOpeningDelay())
}

// maybeReplyChat gives a fill-in bot a chance to answer the human's latest line,
// using its FIXED persona reply probability (so a quiet opponent stays quiet and
// a chatty one stays chatty for the whole game). Called on the Run goroutine
// right after the human's message is recorded, so g.chatLog already includes it.
// A cooldown keeps it from answering every line of a fast burst.
func (h *Hub) maybeReplyChat(g *game) {
	bot, _, ok := g.chatBotSide()
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
	h.generateBotChat(g.id, BotChatRequest{
		Bot:      bot.id.Name,
		Rating:   bot.rating,
		Opponent: g.humanName(),
		Kind:     "reply",
		Style:    g.chat.style,
		History:  append([]BotChatTurn(nil), g.chatLog...),
		Count:    count,
	}, botChatReplyDelay())
}

// generateBotChat runs the generator OFF the Run goroutine (it makes a network
// call), paces the output like a person typing, and hands each finished line back
// over botChats for broadcast. Silently drops everything if the generator returns
// nothing or the game has gone away.
func (h *Hub) generateBotChat(gameID string, req BotChatRequest, initialDelay time.Duration) {
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
			case h.botChats <- botChatResult{gameID: gameID, text: line}:
				sent++
			case <-time.After(2 * time.Second):
				return // Run goroutine wedged/gone; drop rather than leak
			}
		}
	}()
}

// deliverBotChat broadcasts a generated bot line on the Run goroutine, guarding
// against a game that ended or vanished while the line was being written. It goes
// out via broadcastPlayers as the bot's color/name — identical on the wire to a
// human opponent's chat.
func (h *Hub) deliverBotChat(r botChatResult) {
	g := h.games[r.gameID]
	if g == nil || g.over {
		return
	}
	bot, botColor, ok := g.chatBotSide()
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

// botChatBetweenDelay: the pause before a follow-up line, scaled a little by how
// long the line is (a longer line "takes longer to type").
func botChatBetweenDelay(line string) time.Duration {
	base := 700 + mrand.IntN(1200)        // 0.7s–1.9s
	base += min(len([]rune(line)), 40) * 25 // + up to ~1s for length
	return time.Duration(base) * time.Millisecond
}
