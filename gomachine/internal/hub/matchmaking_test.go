package hub

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/timanthonyalexander/gomachine/internal/auth"
)

func TestRatingTolerance(t *testing.T) {
	if got := ratingTolerance(0); got != baseRatingGap {
		t.Errorf("tolerance(0) = %d, want %d", got, baseRatingGap)
	}
	if got := ratingTolerance(2 * time.Second); got != baseRatingGap+2*ratingGapPerSec {
		t.Errorf("tolerance(2s) = %d, want %d", got, baseRatingGap+2*ratingGapPerSec)
	}
	if got := ratingTolerance(time.Hour); got != maxRatingGap {
		t.Errorf("tolerance(1h) = %d, want capped %d", got, maxRatingGap)
	}
}

func TestPairAcceptable(t *testing.T) {
	// Fresh arrivals accept only a tight gap.
	if !pairAcceptable(baseRatingGap, 0, 0) {
		t.Error("gap == base should be acceptable for two fresh arrivals")
	}
	if pairAcceptable(baseRatingGap+1, 0, 0) {
		t.Error("gap just over base should not be acceptable for two fresh arrivals")
	}
	// Symmetric consent: one long-waiter is not enough; both must accept.
	if pairAcceptable(300, time.Hour, 0) {
		t.Error("a wide gap must be rejected while the other player is fresh (min, not max)")
	}
	if !pairAcceptable(300, 10*time.Second, 10*time.Second) {
		t.Error("after both wait long enough, a mid gap should be acceptable")
	}
	// Beyond the hard ceiling, no amount of waiting pairs them.
	if pairAcceptable(maxRatingGap+1, time.Hour, time.Hour) {
		t.Error("gap beyond maxRatingGap must never be acceptable")
	}
}

func TestBotDisplayRating(t *testing.T) {
	for _, base := range []int{1200, 1500, 1900} {
		for i := 0; i < 50; i++ {
			r := botDisplayRating(base)
			if r < base-botRatingJitter || r > base+botRatingJitter {
				t.Fatalf("botDisplayRating(%d) = %d, outside ±%d", base, r, botRatingJitter)
			}
		}
	}
	// Clamped to the band at the extremes.
	if r := botDisplayRating(100); r < botRatingMin {
		t.Errorf("botDisplayRating(100) = %d, below floor %d", r, botRatingMin)
	}
	if r := botDisplayRating(5000); r > botRatingMax {
		t.Errorf("botDisplayRating(5000) = %d, above ceiling %d", r, botRatingMax)
	}
}

// dialRated connects with a registered identity carrying a blitz rating.
func dialRated(t *testing.T, srvURL, name, userID string, blitz int) *websocket.Conn {
	t.Helper()
	id := auth.Identity{
		UserID:  userID,
		Anon:    false,
		Name:    name,
		Rating:  blitz,
		Ratings: map[string]int{"blitz": blitz},
	}
	ticket := auth.Sign(id, testSecret)
	url := "ws" + strings.TrimPrefix(srvURL, "http") + "/ws?ticket=" + ticket
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", name, err)
	}
	return c
}

// expectNoMatch fails if a "matched" message arrives within the window.
func expectNoMatch(t *testing.T, c *websocket.Conn, window time.Duration) {
	t.Helper()
	deadline := time.Now().Add(window)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), window)
		var m map[string]any
		err := wsjson.Read(ctx, c, &m)
		cancel()
		if err != nil {
			return // timeout / closed: no match, as expected
		}
		if m["type"] == "matched" {
			t.Fatalf("unexpected match for far-apart ratings: %v", m)
		}
	}
}

func TestFarApartNeverMatch(t *testing.T) {
	h := New(testSecret) // bot fill OFF: a lone player just waits
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialRated(t, srv.URL, "weak", "id-weak", 1000)
	defer a.CloseNow()
	b := dialRated(t, srv.URL, "strong", "id-strong", 2400)
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")

	send(t, a, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, b, map[string]any{"type": "queue", "pool": "3+0"})
	readType(t, a, "queued")
	readType(t, b, "queued")

	// Gap is 1400 Elo, far beyond maxRatingGap — they must never be paired.
	expectNoMatch(t, a, 700*time.Millisecond)
}

func TestCloseRatingsMatch(t *testing.T) {
	h := New(testSecret)
	go h.Run()
	srv := httptest.NewServer(http.HandlerFunc(h.ServeWS))
	defer srv.Close()

	a := dialRated(t, srv.URL, "p1", "id-p1", 1500)
	defer a.CloseNow()
	b := dialRated(t, srv.URL, "p2", "id-p2", 1550) // within baseRatingGap
	defer b.CloseNow()
	readType(t, a, "hello")
	readType(t, b, "hello")

	send(t, a, map[string]any{"type": "queue", "pool": "3+0"})
	send(t, b, map[string]any{"type": "queue", "pool": "3+0"})
	readType(t, a, "matched")
	readType(t, b, "matched")
}
