package bench

import (
	"context"
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/book"
	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/search"
	"github.com/timanthonyalexander/gomachine/internal/syzygy"
)

// mateEvalCp is the centipawn magnitude the UCI helpers map a mate score to
// (`Evaluate`: 20000 − dist). A checkmate gomachine delivers is scored at +mateEvalCp
// from its POV so the swing goes sharply negative and it's never flagged.
const mateEvalCp = 20000

// winProbScale is the logistic divisor mapping centipawns → win probability (the
// same 400-Elo/pawn convention used elsewhere). winProb(cp) = 1/(1+10^(−cp/400)).
const winProbScale = 400.0

// winProb maps a side-to-move centipawn score to that side's win probability in
// [0,1]. Blunders are measured as the DROP in this (Lichess-style), not raw cp, so a
// "mate → still winning" move barely registers while an "equal → losing" move is huge.
func winProb(cp int) float64 {
	return 1.0 / (1.0 + math.Pow(10, -float64(cp)/winProbScale))
}

// BlunderConfig specifies a blunder-mining run: gomachine plays games against an
// opponent (Stockfish), and a SEPARATE full-strength "judge" engine scores the
// position before and after every gomachine move. A large drop is a blunder; the
// position after it (correctly bad, labelled by the eventual game result) becomes
// hard-example training data.
type BlunderConfig struct {
	OurParams   search.Params
	OurMoveTime time.Duration
	OurThreads  int
	TTMB        int

	SFPath    string            // path to the stockfish binary (used for BOTH opponent and judge)
	SFOptions map[string]string // opponent UCI options (may be handicapped)
	SFBudget  UCIBudget         // opponent per-move budget

	// JudgeOptions/JudgeBudget configure the neutral ground-truth analyser. It must
	// be FULL strength (no UCI_LimitStrength) — its evals select which positions are
	// blunders. A separate process from the opponent so the opponent's handicap can't
	// contaminate the labels.
	JudgeOptions map[string]string
	JudgeBudget  UCIBudget

	Games       int
	Concurrency int
	Book        []Opening
	EngineBook  *book.Book
	Tablebase   *syzygy.Tablebase

	BlunderWP   float64 // win-prob DROP on one move to flag a blunder (default 0.30, Lichess "blunder")
	BlindWP     float64 // gomachine OVERESTIMATED the result win-prob by ≥ this → "blind spot" (default 0.20)
	TrainMaxCp  int     // emit to the EPD only if the resulting position is ≤ this for gomachine (default 0 → not winning)
	QuietOnly   bool    // emit only quiet post-blunder positions to the training set (label is meaningful)
	ConfirmLoss bool    // emit only when gomachine did NOT go on to win (the blunder mattered)
}

// Blunder is one flagged gomachine move.
type Blunder struct {
	Game       int    `json:"game"`
	Ply        int    `json:"ply"`
	OurColor   string `json:"our_color"`
	MoveNo     int    `json:"move_no"`
	FENBefore  string `json:"fen_before"`  // position gomachine moved from
	FENAfter   string `json:"fen_after"`   // the resulting (bad) position — the minable one
	MovePlayed string `json:"move_played"` // gomachine's move, SAN
	MoveUCI    string `json:"move_uci"`
	BestMove   string `json:"best_move"` // judge's preferred move, SAN
	BestUCI    string `json:"best_uci"`
	JudgePV    string `json:"judge_pv"` // judge's expected line from FENBefore (UCI), the refutation

	EvalBefore   int     `json:"eval_before_cp"` // judge, gomachine POV
	EvalAfter    int     `json:"eval_after_cp"`  // judge, gomachine POV
	SwingCp      int     `json:"swing_cp"`       // EvalBefore − EvalAfter = cp thrown away
	WinBefore    float64 `json:"win_before"`     // gomachine win-prob before the move, 0..1
	WinAfter     float64 `json:"win_after"`      // gomachine win-prob after the move
	WinDrop      float64 `json:"win_drop"`       // WinBefore − WinAfter (the real "eval bar" drop)
	OurScoreCp   int     `json:"our_score_cp"`   // gomachine's OWN search score, gomachine POV
	OurDepth     int     `json:"our_depth"`
	Overestimate int     `json:"overestimate_cp"` // OurScoreCp − EvalAfter; how badly gomachine misjudged
	OverWP       float64 `json:"over_wp"`         // win-prob gomachine overestimated the result by
	Class        string  `json:"class"`           // "blind_spot" (eval wrong) | "horizon" (eval saw it)
	Quiet        bool    `json:"quiet"`           // FENAfter has no live tactic (good training label)
	GameResult   string  `json:"game_result"`     // White-perspective "1-0" | "0-1" | "1/2-1/2"
	OurWon       bool    `json:"our_won"`
}

// BlunderProgress is pushed after each finished game.
type BlunderProgress struct {
	Games     int
	Moves     int // gomachine moves judged
	Blunders  int
	BlindSpot int
	Horizon   int
	Trainable int // blind-spot + quiet (+ confirm) → emitted to the EPD
	Elapsed   time.Duration
}

// BlunderSummary is the final outcome plus every flagged blunder.
type BlunderSummary struct {
	BlunderProgress
	Blunders []Blunder
}

// RunBlunderHunt plays gomachine vs the opponent over color-swapped pairs, judging
// every gomachine move, and returns all flagged blunders. Each worker owns its own
// gomachine engine + opponent process + judge process (full state isolation).
func RunBlunderHunt(ctx context.Context, cfg BlunderConfig, onProgress func(BlunderProgress)) (BlunderSummary, error) {
	if cfg.Concurrency < 1 {
		cfg.Concurrency = 1
	}
	if cfg.BlunderWP <= 0 {
		cfg.BlunderWP = 0.30
	}
	if cfg.BlindWP <= 0 {
		cfg.BlindWP = 0.20
	}
	pairs := (cfg.Games + 1) / 2
	ourLim := search.Limits{MoveTime: cfg.OurMoveTime}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	jobs := make(chan int)
	results := make(chan []Blunder, cfg.Concurrency*2)
	errCh := make(chan error, cfg.Concurrency)

	var wg sync.WaitGroup
	for w := 0; w < cfg.Concurrency; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ours := engine.NewWithParams(cfg.TTMB, cfg.OurParams)
			ours.SetBook(cfg.EngineBook)
			ours.SetTablebase(cfg.Tablebase)
			opp, err := StartUCI(cfg.SFPath, cfg.SFOptions)
			if err != nil {
				reportErr(errCh, err)
				cancel()
				return
			}
			defer opp.Close()
			judge, err := StartUCI(cfg.SFPath, cfg.JudgeOptions)
			if err != nil {
				reportErr(errCh, err)
				cancel()
				return
			}
			defer judge.Close()

			gameNo := 0
			for idx := range jobs {
				open := cfg.Book[idx%len(cfg.Book)]
				for _, ourColor := range []chess.Color{chess.White, chess.Black} {
					gameNo++
					bl, err := huntGame(ctx, cfg, ours, opp, judge, open.FEN, ourColor, ourLim, gameNo)
					if err != nil {
						if ctx.Err() != nil {
							return
						}
						reportErr(errCh, err)
						cancel()
						return
					}
					select {
					case results <- bl:
					case <-ctx.Done():
						return
					}
				}
			}
		}()
	}

	go func() {
		defer close(jobs)
		for i := 0; i < pairs; i++ {
			select {
			case jobs <- i:
			case <-ctx.Done():
				return
			}
		}
	}()

	var summary BlunderSummary
	start := time.Now()
	total := pairs * 2

	for i := 0; i < total; i++ {
		var bl []Blunder
		select {
		case bl = <-results:
		case <-ctx.Done():
			select {
			case err := <-errCh:
				return summary, err
			default:
				cancel()
				wg.Wait()
				summary.Elapsed = time.Since(start)
				return summary, nil
			}
		}
		summary.Games++
		for _, b := range bl {
			summary.Blunders = append(summary.Blunders, b)
			summary.BlunderProgress.Blunders++
			if b.Class == "blind_spot" {
				summary.BlindSpot++
			} else {
				summary.Horizon++
			}
			if isTrainable(b, cfg) {
				summary.Trainable++
			}
		}
		summary.Elapsed = time.Since(start)
		if onProgress != nil {
			onProgress(summary.BlunderProgress)
		}
	}

	cancel()
	wg.Wait()
	summary.Elapsed = time.Since(start)
	return summary, nil
}

// huntGame plays one game and returns every flagged gomachine blunder in it. The
// game result is known only at the end, so candidates are collected during play and
// finalised (result label + confirm filter) once the game is over.
func huntGame(ctx context.Context, cfg BlunderConfig, ours *engine.Engine, opp, judge *UCIEngine, openFEN string, ourColor chess.Color, ourLim search.Limits, gameNo int) ([]Blunder, error) {
	ours.NewGame()
	if err := opp.NewGame(); err != nil {
		return nil, err
	}
	if err := judge.NewGame(); err != nil {
		return nil, err
	}
	pos, err := chess.ParseFEN(openFEN)
	if err != nil {
		return nil, err
	}
	history := make([]uint64, 0, 128)
	moves := make([]string, 0, 128) // UCI moves since openFEN, for the UCI engines' position cmd

	var cands []Blunder
	whiteResult := "1/2-1/2"

	for ply := 0; ply < maxPlies; ply++ {
		st := engine.Adjudicate(pos, history)
		if st.State != "ongoing" {
			whiteResult = st.Result
			break
		}
		if containsAny(st.ClaimableDraws, "threefold", "fifty") {
			whiteResult = "1/2-1/2"
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		if pos.SideToMove() != ourColor {
			// Opponent's move — no judging.
			uci, err := opp.BestMove(openFEN, moves, cfg.SFBudget)
			if err != nil {
				return nil, fmt.Errorf("opponent: %w", err)
			}
			m, ok := pos.ParseUCIMove(uci)
			if !ok {
				// Opponent played an illegal move per our rules → it loses.
				whiteResult = resultString(resultFor(ourColor))
				break
			}
			history = append(history, pos.Key())
			var u chess.Undo
			pos.DoMove(m, &u)
			moves = append(moves, uci)
			continue
		}

		// gomachine's move — judge before, play, judge after.
		before, err := judge.AnalyzeBest(openFEN, moves, cfg.JudgeBudget)
		if err != nil {
			return nil, fmt.Errorf("judge before: %w", err)
		}
		res := ours.PlayThreads(pos, ourLim, history, maxThreads(cfg.OurThreads))
		if res.Move == chess.NullMove {
			whiteResult = "1/2-1/2"
			break
		}
		fenBefore := pos.FEN()
		san := pos.SAN(res.Move)
		uci := res.Move.String()

		bestSAN := ""
		if bm, ok := pos.ParseUCIMove(before.BestMove); ok {
			bestSAN = pos.SAN(bm)
		}

		history = append(history, pos.Key())
		var u chess.Undo
		pos.DoMove(res.Move, &u)
		moves = append(moves, uci)
		fenAfter := pos.FEN()

		// Only the full-strength search path carries a meaningful score; skip book /
		// tablebase / zero-depth moves (res.Depth==0) — they're not eval blunders.
		if res.Depth > 0 {
			// before.Cp is gomachine-POV (gomachine was to move). The resulting
			// position's eval must be from gomachine's POV too. A position that's
			// already game-over breaks the judge (it returns `mate 0`, sign-ambiguous),
			// so resolve terminals by the rules instead of querying SF.
			st2 := engine.Adjudicate(pos, history)
			terminal := st2.State != "ongoing"
			var evalAfter int
			switch {
			case terminal && st2.State == "checkmate":
				evalAfter = mateEvalCp // gomachine delivered mate — never a blunder
			case terminal:
				evalAfter = 0 // stalemate / insufficient material / drawn by rule
			default:
				after, err := judge.Evaluate(openFEN, moves, cfg.JudgeBudget)
				if err != nil {
					return nil, fmt.Errorf("judge after: %w", err)
				}
				evalAfter = -after // SF reports opponent-POV (they're now to move)
			}
			evalBefore := before.Cp
			winBefore := winProb(evalBefore)
			winAfter := winProb(evalAfter)
			winDrop := winBefore - winAfter
			if winDrop >= cfg.BlunderWP {
				ourScore := res.Score // gomachine-POV already
				// Blind spot vs horizon: did gomachine's OWN eval already see the drop?
				// Measure in win-prob — gomachine predicted winProb(ourScore), reality is
				// winAfter. A big positive gap means it didn't see it (eval-trainable).
				overWP := winProb(ourScore) - winAfter
				class := "horizon"
				if overWP >= cfg.BlindWP {
					class = "blind_spot"
				}
				cands = append(cands, Blunder{
					Game: gameNo, Ply: ply, OurColor: colorName(ourColor), MoveNo: ply/2 + 1,
					FENBefore: fenBefore, FENAfter: fenAfter,
					MovePlayed: san, MoveUCI: uci, BestMove: bestSAN, BestUCI: before.BestMove,
					JudgePV:    strings.Join(before.PV, " "),
					EvalBefore: evalBefore, EvalAfter: evalAfter, SwingCp: evalBefore - evalAfter,
					WinBefore: winBefore, WinAfter: winAfter, WinDrop: winDrop,
					OurScoreCp: ourScore, OurDepth: res.Depth,
					Overestimate: ourScore - evalAfter, OverWP: overWP,
					// A terminal position (stalemate the engine walked into) is not a
					// meaningful static-eval training target, so never emit it.
					Class: class, Quiet: isQuiet(pos) && !terminal,
				})
			}
		}
	}

	ourWon := (whiteResult == "1-0" && ourColor == chess.White) ||
		(whiteResult == "0-1" && ourColor == chess.Black)
	for i := range cands {
		cands[i].GameResult = whiteResult
		cands[i].OurWon = ourWon
	}
	return cands, nil
}

// isQuiet reports whether the position has no immediately-live tactic (side to move
// not in check, and no SEE-winning capture available), so its game-result label is a
// meaningful training target rather than mid-combination noise.
func isQuiet(pos *chess.Position) bool {
	if pos.InCheck() {
		return false
	}
	var ml chess.MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.Len(); i++ {
		m := ml.Get(i)
		capture := pos.Occupied().Has(m.To()) || m.Type() == chess.EnPassant
		if capture && pos.SEEGE(m, 1) {
			return false
		}
	}
	return true
}

// isTrainable reports whether a blunder should be emitted to the EPD training set:
// an eval blind spot (not a horizon loss), quiet if QuietOnly, and confirmed by the
// result if ConfirmLoss.
func isTrainable(b Blunder, cfg BlunderConfig) bool {
	if b.Class != "blind_spot" {
		return false
	}
	// The mined position must be genuinely bad for gomachine — labelling a still-
	// winning position with a (noisy) loss/draw result would poison the eval. Default
	// TrainMaxCp=0 → only positions where gomachine is no longer winning.
	if b.EvalAfter > cfg.TrainMaxCp {
		return false
	}
	if cfg.QuietOnly && !b.Quiet {
		return false
	}
	if cfg.ConfirmLoss && b.OurWon {
		return false
	}
	return true
}

func reportErr(ch chan error, err error) {
	select {
	case ch <- err:
	default:
	}
}

func colorName(c chess.Color) string {
	if c == chess.White {
		return "white"
	}
	return "black"
}

func resultString(o gameOutcome) string {
	switch o {
	case whiteWin:
		return "1-0"
	case blackWin:
		return "0-1"
	default:
		return "1/2-1/2"
	}
}
