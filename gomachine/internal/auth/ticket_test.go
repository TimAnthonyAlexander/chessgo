package auth

import (
	"reflect"
	"testing"
)

func TestSignVerifyRoundTrip(t *testing.T) {
	secret := "shared-secret"
	want := Identity{UserID: "u1", Anon: false, Name: "alice", Rating: 1640,
		Ratings: map[string]int{"bullet": 1500, "blitz": 1640}}
	got, err := Verify(Sign(want, secret), secret)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func TestRatingForFallsBackToDefault(t *testing.T) {
	id := Identity{Rating: 1500, Ratings: map[string]int{"blitz": 1700}}
	if got := id.RatingFor("blitz"); got != 1700 {
		t.Errorf("blitz: got %d, want 1700", got)
	}
	if got := id.RatingFor("rapid"); got != 1500 { // absent → default
		t.Errorf("rapid fallback: got %d, want 1500", got)
	}
	bot := Identity{Rating: 1234} // no Ratings map (e.g. bot)
	if got := bot.RatingFor("blitz"); got != 1234 {
		t.Errorf("nil map: got %d, want 1234", got)
	}
}

func TestVerifyRejectsTamperedAndWrongSecret(t *testing.T) {
	token := Sign(Identity{Name: "anon", Anon: true}, "secret-a")
	if _, err := Verify(token, "secret-b"); err == nil {
		t.Error("expected failure with wrong secret")
	}
	if _, err := Verify(token+"x", "secret-a"); err == nil {
		t.Error("expected failure on tampered signature")
	}
	if _, err := Verify("nodot", "secret-a"); err == nil {
		t.Error("expected failure on malformed token")
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	token := Sign(Identity{Name: "x", Exp: 1}, "s") // exp in 1970
	if _, err := Verify(token, "s"); err == nil {
		t.Error("expected expired ticket to be rejected")
	}
}
