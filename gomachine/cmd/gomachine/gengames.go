package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"runtime"
	"sync"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

// gengames self-plays a BATCH of engine-vs-engine games in ONE process, across a
// worker pool (one Engine per worker — Engines aren't concurrent-safe), each side
// weakened to a difficulty derived from its target rating. It exists to backfill
// realistic game HISTORY for seeded dev accounts without a per-game PHP/HTTP round
// trip: the caller pipes a JSON batch on stdin and reads JSON-lines on stdout.
// Local dev tooling only — never on the hot path.
//
//	echo '{"games":[{"whiteRating":1500,"blackRating":1480}]}' \
//	  | gomachine gengames -workers 8
//
// Output is ONE JSON object per line (order not guaranteed — match on "index").
//
// Strength: each rating maps to a level 0..8 (inverse of the hub's
// ratingForLevel = 600+180*level) and the game plays via engine.BestMove(level),
// whose weakened path caps root ranking at depth 6. That bounds per-move cost so
// thousands of short games finish in seconds-to-minutes — the point here is fast,
// rating-correlated history, not full-strength fidelity (live bot games still use
// the continuous configForRating ladder). The level cap of 8 keeps every game on
// the fast weakened path (levels 9/10 are clean full-strength searches).

// gengameSpec is one requested game. Ratings are on the seeded-user (human) scale.
type gengameSpec struct {
	WhiteRating int `json:"whiteRating"`
	BlackRating int `json:"blackRating"`
	MaxPlies    int `json:"maxPlies,omitempty"`
}

// gengameBatch is the whole stdin payload: a list of games plus optional defaults.
type gengameBatch struct {
	Workers  int           `json:"workers,omitempty"`
	MaxPlies int           `json:"maxPlies,omitempty"`
	Games    []gengameSpec `json:"games"`
}

// gengameResult is one finished game, emitted as a JSON line on stdout.
type gengameResult struct {
	Index    int      `json:"index"`    // position in the input batch
	Result   string   `json:"result"`   // "1-0" | "0-1" | "1/2-1/2" (White's perspective)
	Reason   string   `json:"reason"`   // checkmate | stalemate | draw-* | adjudicated
	Ply      int      `json:"ply"`      // number of plies played
	Moves    []string `json:"moves"`    // UCI move list
	FinalFEN string   `json:"finalFen"` // position after the last move
}

func cmdGenGames(args []string) {
	fs := flag.NewFlagSet("gengames", flag.ExitOnError)
	workersFlag := fs.Int("workers", 0, "concurrent game workers (0 = NumCPU)")
	maxPliesFlag := fs.Int("max-plies", 200, "adjudicate to a draw after this many plies (runaway guard)")
	ttFlag := fs.Int("tt", 8, "transposition table MB per worker")
	_ = fs.Parse(args)

	var batch gengameBatch
	if err := json.NewDecoder(bufio.NewReader(os.Stdin)).Decode(&batch); err != nil {
		fmt.Fprintln(os.Stderr, "gengames: invalid JSON batch on stdin:", err)
		os.Exit(1)
	}
	if len(batch.Games) == 0 {
		fmt.Fprintln(os.Stderr, "gengames: batch has no games")
		os.Exit(1)
	}

	defMaxPlies := *maxPliesFlag
	if batch.MaxPlies > 0 {
		defMaxPlies = batch.MaxPlies
	}
	workers := *workersFlag
	if batch.Workers > 0 {
		workers = batch.Workers
	}
	if workers <= 0 {
		workers = runtime.NumCPU()
	}
	if workers > len(batch.Games) {
		workers = len(batch.Games)
	}

	w := bufio.NewWriter(os.Stdout)
	defer w.Flush()
	enc := json.NewEncoder(w)

	jobs := make(chan int)
	var outMu sync.Mutex
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			eng := engine.New(*ttFlag) // one Engine per worker (not concurrent-safe)
			for idx := range jobs {
				g := batch.Games[idx]
				mp := g.MaxPlies
				if mp <= 0 {
					mp = defMaxPlies
				}
				res := playGenGame(eng, idx, g.WhiteRating, g.BlackRating, mp)
				outMu.Lock()
				_ = enc.Encode(&res)
				w.Flush()
				outMu.Unlock()
			}
		}()
	}
	for idx := range batch.Games {
		jobs <- idx
	}
	close(jobs)
	wg.Wait()
}

// levelForSeedRating maps a seeded-user rating to a difficulty level 0..8. It's the
// inverse of the hub's ratingForLevel (600+180*level), capped at 8 so every game
// stays on the fast weakened search path (levels 9/10 are clean full-strength).
func levelForSeedRating(rating int) int {
	lvl := int(math.Round(float64(rating-600) / 180.0))
	if lvl < 0 {
		lvl = 0
	}
	if lvl > 8 {
		lvl = 8
	}
	return lvl
}

// playGenGame self-plays one full game from the start position, each side at a
// level derived from its rating, and returns the result. The engine never claims
// threefold/fifty (Adjudicate only auto-ends on mate/stalemate/insufficient/
// fivefold/75-move), so long games are adjudicated a draw at maxPlies.
func playGenGame(eng *engine.Engine, index, whiteRating, blackRating, maxPlies int) gengameResult {
	eng.NewGame() // clear the TT so the previous game can't bias this one

	whiteLevel := levelForSeedRating(whiteRating)
	blackLevel := levelForSeedRating(blackRating)

	pos, err := chess.ParseFEN(chess.StartFEN)
	if err != nil {
		return gengameResult{Index: index, Result: "1/2-1/2", Reason: "adjudicated", FinalFEN: chess.StartFEN}
	}

	history := make([]uint64, 0, maxPlies)
	moves := make([]string, 0, maxPlies)
	result, reason := "1/2-1/2", "adjudicated"

	for ply := 0; ply < maxPlies; ply++ {
		st := engine.Adjudicate(pos, history)
		if st.State != "ongoing" {
			result, reason = st.Result, st.State
			break
		}

		level := whiteLevel
		if pos.SideToMove() == chess.Black {
			level = blackLevel
		}

		r := eng.BestMove(pos, level, history)
		if r.Move == chess.NullMove {
			break // defensive: Adjudicate said ongoing but no move — leave as draw
		}

		moves = append(moves, r.Move.String())
		history = append(history, pos.Key())
		var u chess.Undo
		pos.DoMove(r.Move, &u)
	}

	return gengameResult{
		Index:    index,
		Result:   result,
		Reason:   reason,
		Ply:      len(moves),
		Moves:    moves,
		FinalFEN: pos.FEN(),
	}
}
