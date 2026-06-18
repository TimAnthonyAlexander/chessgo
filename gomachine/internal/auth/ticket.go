// Package auth verifies the short-lived HMAC tickets minted by BaseAPI that
// authenticate a WebSocket connection (SPEC: signed ticket from BaseAPI). The
// token format is `base64url(payloadJSON).base64url(HMAC-SHA256(payloadB64))`,
// signed with a shared secret. Anonymous players get a ticket with Anon=true and
// no UserID; rated play requires UserID.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Identity is the authenticated player behind a connection.
type Identity struct {
	UserID string `json:"sub"`    // empty for anonymous
	Anon   bool   `json:"anon"`   // true if not a registered account
	Name   string `json:"name"`   // display name
	Rating int    `json:"rating"` // current Elo (0 if unrated/anon)
	Exp    int64  `json:"exp"`    // unix seconds; 0 = no expiry
}

var b64 = base64.RawURLEncoding

// Sign produces a ticket for the identity (used by tests; BaseAPI mints these in
// production with the same algorithm).
func Sign(id Identity, secret string) string {
	payload, _ := json.Marshal(id)
	p := b64.EncodeToString(payload)
	return p + "." + b64.EncodeToString(mac(p, secret))
}

// Verify checks the signature and expiry and returns the embedded identity.
func Verify(token, secret string) (Identity, error) {
	var id Identity
	dot := strings.IndexByte(token, '.')
	if dot < 0 {
		return id, errors.New("malformed ticket")
	}
	p, sig := token[:dot], token[dot+1:]

	got, err := b64.DecodeString(sig)
	if err != nil || !hmac.Equal(got, mac(p, secret)) {
		return id, errors.New("bad ticket signature")
	}
	payload, err := b64.DecodeString(p)
	if err != nil {
		return id, errors.New("bad ticket payload")
	}
	if err := json.Unmarshal(payload, &id); err != nil {
		return id, errors.New("bad ticket json")
	}
	if id.Exp != 0 && time.Now().Unix() > id.Exp {
		return id, errors.New("ticket expired")
	}
	return id, nil
}

func mac(msg, secret string) []byte {
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(msg))
	return h.Sum(nil)
}
