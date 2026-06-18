package auth

import "testing"

func TestSignVerifyRoundTrip(t *testing.T) {
	secret := "shared-secret"
	want := Identity{UserID: "u1", Anon: false, Name: "alice", Rating: 1640}
	got, err := Verify(Sign(want, secret), secret)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
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
