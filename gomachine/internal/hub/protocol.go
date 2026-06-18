package hub

import (
	"strconv"
	"strings"
)

// inMsg is a message from a client. Type is one of: queue, cancel, move, resign.
type inMsg struct {
	Type string `json:"type"`
	Pool string `json:"pool,omitempty"` // time control, e.g. "3+0" (queue)
	Move string `json:"move,omitempty"` // UCI (move)
}

// timeControl is a base time + per-move increment, both in milliseconds.
type timeControl struct {
	Base int64
	Inc  int64
}

// parseTimeControl turns "3+0", "10+5", "30+20" into a timeControl. Base is in
// minutes, increment in seconds, matching the lobby presets.
func parseTimeControl(pool string) (timeControl, bool) {
	plus := strings.IndexByte(pool, '+')
	if plus < 0 {
		return timeControl{}, false
	}
	base, err1 := strconv.Atoi(pool[:plus])
	inc, err2 := strconv.Atoi(pool[plus+1:])
	if err1 != nil || err2 != nil || base < 0 || inc < 0 || base > 180 || inc > 180 {
		return timeControl{}, false
	}
	if base == 0 && inc == 0 {
		return timeControl{}, false
	}
	return timeControl{Base: int64(base) * 60_000, Inc: int64(inc) * 1000}, true
}

// categoryForPool maps a pool to a rating category by estimated game duration
// (base seconds + 40·increment), mirroring BaseAPI's EloService so the displayed
// rating matches the one ratings are tracked under.
func categoryForPool(pool string) string {
	tc, ok := parseTimeControl(pool)
	if !ok {
		return "blitz"
	}
	est := tc.Base/1000 + 40*tc.Inc/1000 // seconds
	switch {
	case est < 180:
		return "bullet"
	case est < 480:
		return "blitz"
	case est < 1500:
		return "rapid"
	default:
		return "classical"
	}
}

// out builds a server→client message as a JSON-marshalable map.
func out(typ string, fields map[string]any) map[string]any {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["type"] = typ
	return fields
}
