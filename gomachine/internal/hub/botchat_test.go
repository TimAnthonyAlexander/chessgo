package hub

import (
	"encoding/json"
	"testing"

	"github.com/timanthonyalexander/gomachine/internal/auth"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/variant"
)

// newStdGame builds a minimal standard-chess game from the opening for the chat
// tests (no clocks/hub lifecycle needed — the chat path only reads state + sides).
func newStdGame(t *testing.T, id string, white, black *player) *game {
	t.Helper()
	st, err := variant.New(variantStandard, chess.StartFEN)
	if err != nil {
		t.Fatalf("variant.New: %v", err)
	}
	return &game{id: id, white: white, black: black, state: st, variant: variantStandard}
}

func humanPlayerWithSend(name string, buf int) (*player, chan []byte) {
	ch := make(chan []byte, buf)
	return newPlayer(&Client{send: ch, id: auth.Identity{Name: name}}), ch
}

func botPlayerNamed(name string, rating int) *player {
	return &player{id: auth.Identity{Name: name, Rating: rating}, isBot: true, rating: rating}
}

func TestChatBotSideDistinguishesGames(t *testing.T) {
	human, _ := humanPlayerWithSend("alice", 1)
	human2, _ := humanPlayerWithSend("bob", 1)
	bot := botPlayerNamed("Sneaky_Knight", 1400)

	// human (white) vs bot (black): the bot side is Black.
	g := newStdGame(t, "g1", human, bot)
	if p, col, ok := g.botVsHumanSide(); !ok || col != chess.Black || p != bot {
		t.Errorf("botVsHumanSide(human-vs-bot) = %v,%v,%v; want bot,Black,true", p, col, ok)
	}

	// human vs human: no chat bot.
	g = newStdGame(t, "g2", human, human2)
	if _, _, ok := g.botVsHumanSide(); ok {
		t.Errorf("botVsHumanSide(human-vs-human) ok = true; want false")
	}

	// filler (bot vs bot) is excluded even though both sides are bots.
	g = newStdGame(t, "g3", botPlayerNamed("a", 1), botPlayerNamed("b", 1))
	g.filler = true
	if _, _, ok := g.botVsHumanSide(); ok {
		t.Errorf("botVsHumanSide(filler) ok = true; want false")
	}
}

func TestAppendChatBounds(t *testing.T) {
	g := newStdGame(t, "g", botPlayerNamed("x", 1), botPlayerNamed("y", 1))
	for i := 0; i < botChatMaxHistory+5; i++ {
		g.appendChat(i%2 == 0, "msg")
	}
	if len(g.chatLog) != botChatMaxHistory {
		t.Fatalf("chatLog len = %d, want %d (bounded)", len(g.chatLog), botChatMaxHistory)
	}
}

func TestDeliverBotChatBroadcastsAsOpponent(t *testing.T) {
	h := New(testSecret)
	human, ch := humanPlayerWithSend("alice", 4)
	bot := botPlayerNamed("Frozen_Otter", 1500)
	g := newStdGame(t, "gid", human, bot)
	h.games[g.id] = g

	h.deliverBotChat(botChatResult{gameID: g.id, text: "  gl hf  "})

	select {
	case data := <-ch:
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if m["type"] != "chat" {
			t.Errorf("type = %v, want chat", m["type"])
		}
		if m["by"] != "b" {
			t.Errorf("by = %v, want b (bot is Black)", m["by"])
		}
		if m["name"] != "Frozen_Otter" {
			t.Errorf("name = %v, want Frozen_Otter", m["name"])
		}
		if m["text"] != "gl hf" {
			t.Errorf("text = %q, want %q (sanitized)", m["text"], "gl hf")
		}
	default:
		t.Fatal("no chat message delivered to the human client")
	}

	// The bot's own line is recorded in history (context for later replies).
	if len(g.chatLog) != 1 || !g.chatLog[0].FromBot || g.chatLog[0].Text != "gl hf" {
		t.Errorf("chatLog = %+v, want one bot line 'gl hf'", g.chatLog)
	}
}

func TestDeliverBotChatDropsStale(t *testing.T) {
	h := New(testSecret)

	// Unknown game id: nothing panics, nothing sent.
	h.deliverBotChat(botChatResult{gameID: "missing", text: "hi"})

	// Finished game: delivery is allowed (the game-over farewell path relies on
	// this — a "gg" after the game ends is realistic and the client still shows
	// chat on the result screen).
	human, ch := humanPlayerWithSend("alice", 2)
	g := newStdGame(t, "gid", human, botPlayerNamed("bot", 1))
	g.over = true
	h.games[g.id] = g
	h.deliverBotChat(botChatResult{gameID: g.id, text: "hi"})
	select {
	case data := <-ch:
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if m["text"] != "hi" {
			t.Errorf("text = %v, want hi", m["text"])
		}
	default:
		t.Fatal("chat should be delivered even after game over")
	}

	// Empty-after-sanitize text: no delivery, no history entry.
	g.over = false
	h.deliverBotChat(botChatResult{gameID: g.id, text: "   "})
	if len(g.chatLog) != 1 { // the "hi" above was recorded
		t.Errorf("chatLog = %+v, want one entry from the earlier delivery", g.chatLog)
	}
	select {
	case <-ch:
		t.Fatal("delivered a blank chat line")
	default:
	}
}

func TestMaterialAdvantage(t *testing.T) {
	// Standard opening: even.
	if n := materialAdvantage("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", chess.White); n != 0 {
		t.Errorf("start fen from White = %d, want 0", n)
	}
	if n := materialAdvantage("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", chess.Black); n != 0 {
		t.Errorf("start fen from Black = %d, want 0", n)
	}

	// White up a queen (remove black's queen).
	if n := materialAdvantage("rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", chess.White); n != 900 {
		t.Errorf("White up a queen from White = %d, want 900", n)
	}
	if n := materialAdvantage("rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", chess.Black); n != -900 {
		t.Errorf("White up a queen from Black = %d, want -900", n)
	}

	// Black up a rook (remove white's a1 rook).
	if n := materialAdvantage("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w KQkq - 0 1", chess.Black); n != 500 {
		t.Errorf("Black up a rook from Black = %d, want 500", n)
	}
	if n := materialAdvantage("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/1NBQKBNR w KQkq - 0 1", chess.White); n != -500 {
		t.Errorf("Black up a rook from White = %d, want -500", n)
	}

	// Both sides equal with queens off.
	if n := materialAdvantage("rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1", chess.White); n != 0 {
		t.Errorf("both missing queens from White = %d, want 0", n)
	}
}
