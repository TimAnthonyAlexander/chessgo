package bench

import (
	"encoding/json"
	"fmt"
	"io"
)

// WriteEPD emits the trainable blunders as Texel/NNUE-style labelled EPD lines —
// `<FEN-after-the-blunder> c9 "<white-result>";` — directly consumable by
// `gomachine tune --epd`. The position is the one AFTER the blunder (genuinely bad)
// and the label is the eventual game result (WDL), NOT the judge's centipawns: per
// the §6 lesson, the judge's eval only SELECTS the position, the result LABELS it.
// Returns how many lines were written (deduped by FEN). cfg gates which blunders
// qualify (blind-spot, quiet, confirmed).
func WriteEPD(w io.Writer, blunders []Blunder, cfg BlunderConfig) (int, error) {
	seen := make(map[string]struct{})
	n := 0
	for _, b := range blunders {
		if !isTrainable(b, cfg) {
			continue
		}
		if _, dup := seen[b.FENAfter]; dup {
			continue
		}
		seen[b.FENAfter] = struct{}{}
		if _, err := fmt.Fprintf(w, "%s c9 \"%s\";\n", b.FENAfter, b.GameResult); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// WriteJSON dumps every flagged blunder (both classes) for scripting/aggregation.
func WriteJSON(w io.Writer, blunders []Blunder) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(blunders)
}
