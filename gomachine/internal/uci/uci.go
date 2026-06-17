// Package uci implements a minimal UCI protocol loop so gomachine can be driven
// by standard chess GUIs and test tools (SPEC §2, §6). It is an interactive
// stdin/stdout protocol and is NOT the PHP integration boundary — that is the
// stateless HTTP service in package server.
package uci

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/engine"
)

const ttSizeMB = 64

// Run starts the UCI loop reading from stdin and writing to stdout.
func Run() {
	runIO(os.Stdin, os.Stdout)
}

func runIO(in io.Reader, out io.Writer) {
	eng := engine.New(ttSizeMB)
	pos, _ := chess.ParseFEN(chess.StartFEN)
	var history []uint64

	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 1<<20), 1<<20) // allow long "position ... moves" lines

	for scanner.Scan() {
		fields := strings.Fields(strings.TrimSpace(scanner.Text()))
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "uci":
			fmt.Fprintln(out, "id name gomachine")
			fmt.Fprintln(out, "id author Tim Anthony Alexander")
			fmt.Fprintln(out, "option name Level type spin default 10 min 0 max 10")
			fmt.Fprintln(out, "uciok")
		case "isready":
			fmt.Fprintln(out, "readyok")
		case "ucinewgame":
			eng = engine.New(ttSizeMB)
			pos, _ = chess.ParseFEN(chess.StartFEN)
			history = nil
		case "position":
			if p, h, ok := parsePosition(fields); ok {
				pos, history = p, h
			}
		case "go":
			handleGo(out, eng, pos, history, fields)
		case "quit", "exit":
			return
		}
	}
}

// parsePosition handles "position startpos [moves ...]" and
// "position fen <6 fields> [moves ...]", returning the resulting position and
// the Zobrist keys of all positions before the current one.
func parsePosition(fields []string) (*chess.Position, []uint64, bool) {
	var pos *chess.Position
	var err error
	i := 1
	if i < len(fields) && fields[i] == "startpos" {
		pos, err = chess.ParseFEN(chess.StartFEN)
		i++
	} else if i < len(fields) && fields[i] == "fen" {
		if i+7 > len(fields) {
			return nil, nil, false // need 6 FEN fields after "fen"
		}
		fen := strings.Join(fields[i+1:i+7], " ")
		pos, err = chess.ParseFEN(fen)
		i += 7
	} else {
		return nil, nil, false
	}
	if err != nil {
		return nil, nil, false
	}

	var history []uint64
	if i < len(fields) && fields[i] == "moves" {
		for _, ms := range fields[i+1:] {
			m, ok := pos.ParseUCIMove(ms)
			if !ok {
				break
			}
			history = append(history, pos.Key())
			var u chess.Undo
			pos.DoMove(m, &u)
		}
	}
	return pos, history, true
}

// handleGo parses time controls and runs a full-strength search.
func handleGo(out io.Writer, eng *engine.Engine, pos *chess.Position, history []uint64, fields []string) {
	depth := 0
	movetime := time.Duration(0)
	var wtime, btime, winc, binc int

	for i := 1; i < len(fields); i++ {
		readInt := func() int {
			if i+1 < len(fields) {
				i++
				n, _ := strconv.Atoi(fields[i])
				return n
			}
			return 0
		}
		switch fields[i] {
		case "depth":
			depth = readInt()
		case "movetime":
			movetime = time.Duration(readInt()) * time.Millisecond
		case "wtime":
			wtime = readInt()
		case "btime":
			btime = readInt()
		case "winc":
			winc = readInt()
		case "binc":
			binc = readInt()
		case "infinite":
			depth = 0
			movetime = 0
		}
	}

	// Derive a move time from the clock if none was given explicitly.
	if movetime == 0 && depth == 0 {
		remaining, inc := wtime, winc
		if pos.SideToMove() == chess.Black {
			remaining, inc = btime, binc
		}
		if remaining > 0 {
			movetime = time.Duration(remaining/30+inc/2) * time.Millisecond
		} else {
			movetime = time.Second // default think time
		}
	}

	res := eng.SearchDirect(pos, depth, movetime, history)

	scoreStr := fmt.Sprintf("cp %d", res.Score)
	if res.MateIn != 0 {
		scoreStr = fmt.Sprintf("mate %d", res.MateIn)
	}
	pv := make([]string, len(res.PV))
	for i, m := range res.PV {
		pv[i] = m.String()
	}
	fmt.Fprintf(out, "info depth %d score %s nodes %d pv %s\n",
		res.Depth, scoreStr, res.Nodes, strings.Join(pv, " "))
	if res.Move == chess.NullMove {
		fmt.Fprintln(out, "bestmove 0000")
		return
	}
	fmt.Fprintf(out, "bestmove %s\n", res.Move.String())
}
