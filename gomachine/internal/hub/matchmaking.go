package hub

import (
	"strings"
	"time"
)

// queueKey composes the matchmaking-pool map key from a time-control pool and a
// board variant. Standard chess keeps the BARE pool key (so standard matchmaking
// is byte-identical to before variants); a non-standard variant prefixes
// "<variant>|" so, e.g., Duck players only ever pair with other Duck players in
// the same time control.
func queueKey(pool, variant string) string {
	if variant == "" || variant == variantStandard {
		return pool
	}
	return variant + "|" + pool
}

// splitQueueKey is the inverse of queueKey: it recovers the time-control pool and
// the variant from a composite key. A bare key (no "|") is a standard pool, so the
// time-control pool and rating category are always derived from the tc part.
func splitQueueKey(key string) (pool, variant string) {
	if i := strings.IndexByte(key, '|'); i >= 0 {
		return key[i+1:], key[:i]
	}
	return key, variantStandard
}

// Rating-aware matchmaking. Two players are paired only when their ratings (in
// the pool's category) are close enough. The acceptable gap starts tight and
// widens the longer a player waits — but never past maxRatingGap. So a close
// match is found fast when possible, a near match after a short wait, and wildly
// mismatched players (e.g. 800 vs 2400) are NEVER paired as humans: they wait out
// the bot-fill delay and get a rating-matched fill-in bot instead.
const (
	startRating     = 1500 // fallback rating for anonymous/unrated players (EloService::START)
	baseRatingGap   = 100  // acceptable Elo gap at queue time
	ratingGapPerSec = 50   // how fast the acceptable gap widens per second waited
	maxRatingGap    = 400  // hard ceiling: two players further apart never pair as humans
)

// ratingTolerance is the largest Elo gap a player who has waited `wait` will
// accept. Grows linearly from baseRatingGap, capped at maxRatingGap.
func ratingTolerance(wait time.Duration) int {
	tol := baseRatingGap + int(wait.Seconds())*ratingGapPerSec
	if tol > maxRatingGap {
		tol = maxRatingGap
	}
	return tol
}

// poolRating is the client's rating in the pool's category, falling back to the
// default start rating for anonymous/unrated players so they still match fairly.
func (h *Hub) poolRating(c *Client, pool string) int {
	r := c.id.RatingFor(categoryForPool(pool))
	if r <= 0 {
		r = startRating
	}
	return r
}

// pairAcceptable reports whether two players can be paired now: the rating gap
// must be within BOTH players' current tolerance (symmetric consent), so neither
// is forced into a mismatch they haven't waited long enough to accept.
func pairAcceptable(gap int, waitA, waitB time.Duration) bool {
	return gap <= ratingTolerance(waitA) && gap <= ratingTolerance(waitB)
}

// bestOpponent returns the waiting client under queue `key` that best matches c
// (smallest acceptable rating gap right now), or nil if none is acceptable. The
// key may be composite (variant|pool); ratings/category are derived from the tc
// part. c is assumed not yet in the pool.
func (h *Hub) bestOpponent(c *Client, key string, now time.Time) *Client {
	tcPool, _ := splitQueueKey(key)
	rc := h.poolRating(c, tcPool)
	waitC := now.Sub(c.queuedAt)
	var best *Client
	bestGap := maxRatingGap + 1
	for _, other := range h.pools[key] {
		if other == c {
			continue
		}
		gap := absInt(rc - h.poolRating(other, tcPool))
		if gap < bestGap && pairAcceptable(gap, waitC, now.Sub(other.queuedAt)) {
			best, bestGap = other, gap
		}
	}
	return best
}

// matchWaiting re-pairs already-waiting players whose widening tolerances have
// made them acceptable to each other. Runs every tick (tolerances grow with the
// wait, so a pair that wasn't acceptable a moment ago may be now). Pools are
// small, so the O(n²) closest-pair scan is cheap.
func (h *Hub) matchWaiting() {
	now := time.Now()
	for key := range h.pools {
		tcPool, variant := splitQueueKey(key)
		tc, ok := parseTimeControl(tcPool)
		if !ok {
			continue
		}
		for {
			a, b := h.closestAcceptablePair(key, now)
			if a == nil {
				break
			}
			h.dequeue(a)
			h.dequeue(b)
			h.startGame(a, b, tc, tcPool, variant)
		}
		if len(h.pools[key]) == 0 {
			delete(h.pools, key)
		}
	}
}

// closestAcceptablePair finds the two waiting clients under queue `key` with the
// smallest mutually-acceptable rating gap, or (nil, nil) if no pair is acceptable.
// The key may be composite (variant|pool); the rating category comes from the tc part.
func (h *Hub) closestAcceptablePair(key string, now time.Time) (*Client, *Client) {
	tcPool, _ := splitQueueKey(key)
	list := h.pools[key]
	var ba, bb *Client
	bestGap := maxRatingGap + 1
	for i := 0; i < len(list); i++ {
		for j := i + 1; j < len(list); j++ {
			gap := absInt(h.poolRating(list[i], tcPool) - h.poolRating(list[j], tcPool))
			if gap < bestGap && pairAcceptable(gap, now.Sub(list[i].queuedAt), now.Sub(list[j].queuedAt)) {
				ba, bb, bestGap = list[i], list[j], gap
			}
		}
	}
	return ba, bb
}

func absInt(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
