package bench

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
)

// Opening is one starting position for a game pair, identified for the report.
type Opening struct {
	Name string
	FEN  string // position both colors start the pair from
}

// embeddedOpenings is a small, balanced book of common openings (4 plies each),
// so `bench` works with no external files. Reversed-color pairs over these give
// variety without first-move bias. Each is validated legal at startup.
var embeddedOpenings = []struct {
	name  string
	moves string // space-separated UCI
}{
	{"Open Game", "e2e4 e7e5 g1f3 b8c6"},
	{"Sicilian", "e2e4 c7c5 g1f3 d7d6"},
	{"Queen's Gambit", "d2d4 d7d5 c2c4 e7e6"},
	{"QGD / Indian", "d2d4 g8f6 c2c4 e7e6"},
	{"French", "e2e4 e7e6 d2d4 d7d5"},
	{"Caro-Kann", "e2e4 c7c6 d2d4 d7d5"},
	{"Réti", "g1f3 d7d5 d2d4 g8f6"},
	{"English", "c2c4 e7e5 b1c3 g8f6"},
	{"Scandinavian", "e2e4 d7d5 e4d5 d8d5"},
	{"Dutch", "d2d4 f7f5 g2g3 g8f6"},
	{"Modern", "e2e4 g7g6 d2d4 f8g7"},
	{"Pirc", "e2e4 d7d6 d2d4 g8f6"},
	{"English Symmetric", "c2c4 g8f6 b1c3 e7e5"},
	{"KID setup", "g1f3 g8f6 c2c4 g7g6"},
	{"Petrov", "e2e4 e7e5 g1f3 g8f6"},
	{"Slav", "d2d4 d7d5 c2c4 c7c6"},
}

// EmbeddedBook builds and validates the embedded opening positions.
func EmbeddedBook() ([]Opening, error) {
	out := make([]Opening, 0, len(embeddedOpenings))
	for _, o := range embeddedOpenings {
		fen, err := applyUCILine(o.moves)
		if err != nil {
			return nil, fmt.Errorf("embedded opening %q: %w", o.name, err)
		}
		out = append(out, Opening{Name: o.name, FEN: fen})
	}
	return out, nil
}

// LoadBook reads an opening book from path. Supports:
//   - .epd / .fen: one FEN (or EPD; first 4+ fields) per line, '#' comments.
//   - otherwise: one UCI move-line per line ("e2e4 e7e5 ...").
//
// An empty path returns the embedded book.
func LoadBook(path string) ([]Opening, error) {
	if path == "" {
		return EmbeddedBook()
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	isFEN := strings.HasSuffix(strings.ToLower(path), ".epd") ||
		strings.HasSuffix(strings.ToLower(path), ".fen")

	var out []Opening
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	line := 0
	for sc.Scan() {
		line++
		raw := strings.TrimSpace(sc.Text())
		if raw == "" || strings.HasPrefix(raw, "#") {
			continue
		}
		name := fmt.Sprintf("%s:%d", baseName(path), line)
		if isFEN {
			fen, err := normalizeFEN(raw)
			if err != nil {
				return nil, fmt.Errorf("%s line %d: %w", path, line, err)
			}
			out = append(out, Opening{Name: name, FEN: fen})
		} else {
			fen, err := applyUCILine(raw)
			if err != nil {
				return nil, fmt.Errorf("%s line %d: %w", path, line, err)
			}
			out = append(out, Opening{Name: name, FEN: fen})
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: no openings found", path)
	}
	return out, nil
}

// applyUCILine plays a UCI move-line from the start position and returns the
// resulting FEN, validating every move against legal movegen.
func applyUCILine(moves string) (string, error) {
	pos, err := chess.ParseFEN(chess.StartFEN)
	if err != nil {
		return "", err
	}
	for _, ms := range strings.Fields(moves) {
		m, ok := pos.ParseUCIMove(ms)
		if !ok {
			return "", fmt.Errorf("illegal/unparseable move %q", ms)
		}
		var u chess.Undo
		pos.DoMove(m, &u)
	}
	return pos.FEN(), nil
}

// normalizeFEN parses an EPD/FEN field string and returns a canonical 6-field
// FEN (EPD lines may omit the halfmove/fullmove counters).
func normalizeFEN(raw string) (string, error) {
	fields := strings.Fields(raw)
	if len(fields) < 4 {
		return "", fmt.Errorf("need ≥4 FEN fields, got %d", len(fields))
	}
	if len(fields) == 4 {
		fields = append(fields, "0", "1")
	}
	fen := strings.Join(fields[:6], " ")
	pos, err := chess.ParseFEN(fen)
	if err != nil {
		return "", err
	}
	return pos.FEN(), nil
}

func baseName(p string) string {
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		p = p[i+1:]
	}
	return p
}
