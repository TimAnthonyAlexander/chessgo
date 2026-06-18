package main

import (
	"bufio"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
	"github.com/timanthonyalexander/gomachine/internal/server"
	"github.com/timanthonyalexander/gomachine/internal/uci"
)

func cmdUCI() { uci.Run() }

func cmdServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:6466", "listen address")
	tt := fs.Int("tt", 64, "transposition table size per worker (MB)")
	workers := fs.Int("workers", 4, "number of engine workers (bounds concurrent searches)")
	_ = fs.Parse(args)

	srv := server.New(*workers, *tt)
	fmt.Printf("gomachine engine listening on http://%s (%d workers, %d MB TT each)\n", *addr, *workers, *tt)
	if err := http.ListenAndServe(*addr, srv.Handler()); err != nil {
		fmt.Fprintln(os.Stderr, "server error:", err)
		os.Exit(1)
	}
}

func cmdBestMove(args []string) {
	fs := flag.NewFlagSet("bestmove", flag.ExitOnError)
	fen := fs.String("fen", chess.StartFEN, "position FEN")
	level := fs.Int("level", -1, "difficulty level 0..10 (overrides depth/movetime)")
	depth := fs.Int("depth", 0, "fixed search depth")
	movetime := fs.Int("movetime", 0, "time budget in milliseconds")
	tt := fs.Int("tt", 64, "transposition table size (MB)")
	_ = fs.Parse(args)

	pos, err := chess.ParseFEN(*fen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid fen:", err)
		os.Exit(1)
	}
	if !pos.Legal() {
		fmt.Fprintln(os.Stderr, "illegal position: side not to move is in check, or a king is missing")
		os.Exit(1)
	}
	eng := engine.New(*tt)
	start := time.Now()
	var res engine.BestResult
	switch {
	case *level >= 0:
		res = eng.BestMove(pos, *level, nil)
	case *depth > 0 || *movetime > 0:
		res = eng.SearchDirect(pos, *depth, time.Duration(*movetime)*time.Millisecond, nil)
	default:
		res = eng.SearchDirect(pos, 0, time.Second, nil)
	}
	el := time.Since(start)

	if res.Move == chess.NullMove {
		fmt.Println("no legal moves")
		return
	}
	scoreStr := fmt.Sprintf("%+d cp", res.Score)
	if res.MateIn != 0 {
		scoreStr = fmt.Sprintf("mate %d", res.MateIn)
	}
	pv := make([]string, len(res.PV))
	for i, m := range res.PV {
		pv[i] = m.String()
	}
	fmt.Printf("bestmove %s (%s)  score %s  depth %d  nodes %d  %v  pv %s\n",
		res.Move.String(), pos.SAN(res.Move), scoreStr, res.Depth, res.Nodes,
		el.Round(time.Millisecond), strings.Join(pv, " "))
}

func cmdPerft(args []string) {
	fs := flag.NewFlagSet("perft", flag.ExitOnError)
	fen := fs.String("fen", chess.StartFEN, "position FEN")
	depth := fs.Int("depth", 5, "perft depth")
	divide := fs.Bool("divide", false, "show per-root-move counts")
	_ = fs.Parse(args)

	pos, err := chess.ParseFEN(*fen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid fen:", err)
		os.Exit(1)
	}
	if !pos.Legal() {
		fmt.Fprintln(os.Stderr, "illegal position: side not to move is in check, or a king is missing")
		os.Exit(1)
	}
	start := time.Now()
	if *divide {
		div, total := chess.Divide(pos, *depth)
		for mv, n := range div {
			fmt.Printf("%s: %d\n", mv, n)
		}
		fmt.Printf("\ntotal: %d\n", total)
	} else {
		n := chess.Perft(pos, *depth)
		el := time.Since(start)
		fmt.Printf("perft(%d) = %d  [%v, %.1fM nps]\n", *depth, n,
			el.Round(time.Millisecond), float64(n)/el.Seconds()/1e6)
	}
}

func cmdSelfPlay(args []string) {
	fs := flag.NewFlagSet("selfplay", flag.ExitOnError)
	level := fs.Int("level", 6, "difficulty level 0..10")
	maxMoves := fs.Int("max", 200, "maximum full moves before aborting")
	movetime := fs.Int("movetime", 0, "override per-move time (ms); 0 = use level default")
	fen := fs.String("fen", chess.StartFEN, "starting FEN")
	_ = fs.Parse(args)

	pos, err := chess.ParseFEN(*fen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid fen:", err)
		os.Exit(1)
	}
	if !pos.Legal() {
		fmt.Fprintln(os.Stderr, "illegal position: side not to move is in check, or a king is missing")
		os.Exit(1)
	}
	eng := engine.New(64)
	var history []uint64

	for ply := 0; ply < *maxMoves*2; ply++ {
		st := engine.Adjudicate(pos, history)
		if st.State != "ongoing" {
			fmt.Printf("\nGame over: %s (%s)\n", st.State, st.Result)
			break
		}
		var res engine.BestResult
		if *movetime > 0 {
			res = eng.SearchDirect(pos, 0, time.Duration(*movetime)*time.Millisecond, history)
		} else {
			res = eng.BestMove(pos, *level, history)
		}
		if res.Move == chess.NullMove {
			fmt.Println("no move available")
			break
		}
		moveNo := pos.SAN(res.Move)
		history = append(history, pos.Key())
		var u chess.Undo
		pos.DoMove(res.Move, &u)
		if pos.SideToMove() == chess.Black {
			fmt.Printf("%d. %s ", (ply/2)+1, moveNo)
		} else {
			fmt.Printf("%s  ", moveNo)
		}
	}
	fmt.Printf("\n\nFinal FEN: %s\n", pos.FEN())
}

func cmdPlay(args []string) {
	fs := flag.NewFlagSet("play", flag.ExitOnError)
	level := fs.Int("level", 5, "engine difficulty level 0..10")
	color := fs.String("color", "white", "your color: white|black")
	fen := fs.String("fen", chess.StartFEN, "starting FEN")
	_ = fs.Parse(args)

	pos, err := chess.ParseFEN(*fen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid fen:", err)
		os.Exit(1)
	}
	if !pos.Legal() {
		fmt.Fprintln(os.Stderr, "illegal position: side not to move is in check, or a king is missing")
		os.Exit(1)
	}
	human := chess.White
	if strings.HasPrefix(strings.ToLower(*color), "b") {
		human = chess.Black
	}
	eng := engine.New(64)
	var history []uint64
	reader := bufio.NewReader(os.Stdin)

	fmt.Printf("You are %s vs gomachine level %d. Enter moves in UCI (e.g. e2e4), or 'quit'.\n", *color, *level)
	for {
		st := engine.Adjudicate(pos, history)
		if st.State != "ongoing" {
			fmt.Printf("Game over: %s (%s)\n", st.State, st.Result)
			return
		}
		printBoard(pos)
		if pos.SideToMove() == human {
			fmt.Print("your move> ")
			line, _ := reader.ReadString('\n')
			line = strings.TrimSpace(line)
			if line == "quit" || line == "exit" {
				return
			}
			m, ok := pos.ParseUCIMove(line)
			if !ok {
				fmt.Println("illegal move, try again (e.g. e2e4, e7e8q)")
				continue
			}
			history = append(history, pos.Key())
			var u chess.Undo
			pos.DoMove(m, &u)
		} else {
			res := eng.BestMove(pos, *level, history)
			fmt.Printf("gomachine plays %s (%s)\n", pos.SAN(res.Move), res.Move.String())
			history = append(history, pos.Key())
			var u chess.Undo
			pos.DoMove(res.Move, &u)
		}
	}
}

// printBoard renders an ASCII board from White's perspective.
func printBoard(pos *chess.Position) {
	fmt.Println()
	for rank := 7; rank >= 0; rank-- {
		fmt.Printf(" %d ", rank+1)
		for file := 0; file < 8; file++ {
			p := pos.PieceOn(chess.MakeSquare(chess.File(file), chess.Rank(rank)))
			fmt.Printf(" %s", pieceGlyph(p))
		}
		fmt.Println()
	}
	fmt.Println("    a b c d e f g h")
}

func pieceGlyph(p chess.Piece) string {
	if p == chess.NoPiece {
		return "."
	}
	glyphs := []string{"P", "N", "B", "R", "Q", "K", "p", "n", "b", "r", "q", "k"}
	return glyphs[p]
}
