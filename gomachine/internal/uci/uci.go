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
	"github.com/timanthonyalexander/gomachine/internal/search"
)

const ttSizeMB = 64

// Run starts the UCI loop reading from stdin and writing to stdout.
func Run() {
	runIO(os.Stdin, os.Stdout)
}

func runIO(in io.Reader, out io.Writer) {
	// threads / ttMB are configurable via `setoption Threads/Hash` so gomachine can
	// be tested as-deployed (multi-core Lazy SMP) and match a GUI/gauntlet's hash —
	// e.g. an Abitur CCRL run at 4 threads. Changing either rebuilds the engine; the
	// NNUE net is a process global (nnue.SetEnriched), so it survives the rebuild.
	// No tablebase is attached on the UCI path (SetTablebase is never called), so a
	// UCI gomachine plays Syzygy-free — fair against opponents without EGTBs.
	threads := 1
	ttMB := ttSizeMB
	eng := engine.NewWithThreads(ttMB, threads)
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
			fmt.Fprintln(out, "option name Threads type spin default 1 min 1 max 256")
			fmt.Fprintln(out, "option name Hash type spin default 64 min 1 max 1048576")
			fmt.Fprintln(out, "uciok")
		case "isready":
			fmt.Fprintln(out, "readyok")
		case "setoption":
			if name, value, ok := parseSetoption(fields); ok {
				switch strings.ToLower(name) {
				case "threads":
					if n, err := strconv.Atoi(value); err == nil && n >= 1 {
						threads = n
						eng = engine.NewWithThreads(ttMB, threads)
					}
				case "hash":
					if n, err := strconv.Atoi(value); err == nil && n >= 1 {
						ttMB = n
						eng = engine.NewWithThreads(ttMB, threads)
					}
				}
			}
		case "ucinewgame":
			eng = engine.NewWithThreads(ttMB, threads)
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

// parseSetoption parses "setoption name <Name...> value <Value...>" into the
// option name and value. Handles multi-word names/values. Returns ok=false if the
// line is malformed (missing name/value).
func parseSetoption(fields []string) (name, value string, ok bool) {
	nameIdx, valueIdx := -1, -1
	for i, f := range fields {
		switch strings.ToLower(f) {
		case "name":
			nameIdx = i
		case "value":
			valueIdx = i
		}
	}
	if nameIdx < 0 || valueIdx <= nameIdx+1 || valueIdx+1 >= len(fields) {
		return "", "", false
	}
	name = strings.Join(fields[nameIdx+1:valueIdx], " ")
	value = strings.Join(fields[valueIdx+1:], " ")
	return name, value, true
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
	// Reject illegal positions (side not to move already in check, or a king
	// missing) before searching. Pseudo-legal-derived movegen would otherwise
	// generate a king-capturing move whose resulting position has no king for
	// the side to move, and InCheck() would index the attack tables at square
	// 64 (kingSq of an empty king bitboard) and panic. The internal HTTP engine
	// already guards this via server.parseLegal; the raw uci entry did not.
	if !pos.Legal() {
		fmt.Fprintln(out, "info string illegal position: side not to move is in check, or a king is missing")
		fmt.Fprintln(out, "bestmove 0000")
		return
	}

	depth := 0
	movetime := time.Duration(0)
	var nodes uint64
	var wtime, btime, winc, binc, movestogo int

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
		case "nodes":
			nodes = uint64(readInt())
		case "wtime":
			wtime = readInt()
		case "btime":
			btime = readInt()
		case "winc":
			winc = readInt()
		case "binc":
			binc = readInt()
		case "movestogo":
			movestogo = readInt()
		case "infinite":
			depth = 0
			movetime = 0
		}
	}

	// Build search limits: prefer clock-aware time management over flat movetime.
	limits := search.Limits{Depth: depth, MoveTime: movetime, Nodes: nodes}
	if movetime == 0 && depth == 0 && nodes == 0 {
		remaining, inc := wtime, winc
		if pos.SideToMove() == chess.Black {
			remaining, inc = btime, binc
		}
		if remaining > 0 {
			limits.TimeLeft = time.Duration(remaining) * time.Millisecond
			limits.Increment = time.Duration(inc) * time.Millisecond
			limits.MovesToGo = movestogo
		} else {
			limits.MoveTime = time.Second
		}
	}

	res := eng.SearchDirectLimits(pos, limits, history)

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
