package bench

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// UCIBudget is the per-move search budget sent to an external UCI engine.
// Exactly one of MoveTime/Nodes/Depth should be non-zero (checked in order).
type UCIBudget struct {
	MoveTime time.Duration
	Nodes    uint64
	Depth    int
}

func (b UCIBudget) goLine() string {
	switch {
	case b.MoveTime > 0:
		return fmt.Sprintf("go movetime %d", b.MoveTime.Milliseconds())
	case b.Nodes > 0:
		return fmt.Sprintf("go nodes %d", b.Nodes)
	case b.Depth > 0:
		return fmt.Sprintf("go depth %d", b.Depth)
	default:
		return "go movetime 100"
	}
}

// UCIEngine drives an external UCI engine (e.g. Stockfish) over stdin/stdout. It
// is NOT safe for concurrent use — one per game/worker.
type UCIEngine struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   *bufio.Scanner
	name  string
}

// StartUCI launches the engine at path, performs the uci/isready handshake, and
// applies options (e.g. {"UCI_LimitStrength":"true","UCI_Elo":"1800"}).
func StartUCI(path string, options map[string]string) (*UCIEngine, error) {
	cmd := exec.Command(path)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	e := &UCIEngine{cmd: cmd, stdin: stdin, out: sc, name: path}

	if err := e.send("uci"); err != nil {
		return nil, err
	}
	if err := e.waitFor("uciok"); err != nil {
		return nil, fmt.Errorf("%s: no uciok: %w", path, err)
	}
	for k, v := range options {
		if err := e.send(fmt.Sprintf("setoption name %s value %s", k, v)); err != nil {
			return nil, err
		}
	}
	if err := e.isready(); err != nil {
		return nil, err
	}
	return e, nil
}

func (e *UCIEngine) send(line string) error {
	_, err := io.WriteString(e.stdin, line+"\n")
	return err
}

func (e *UCIEngine) waitFor(token string) error {
	for e.out.Scan() {
		f := strings.Fields(e.out.Text())
		if len(f) > 0 && f[0] == token {
			return nil
		}
	}
	if err := e.out.Err(); err != nil {
		return err
	}
	return io.EOF
}

func (e *UCIEngine) isready() error {
	if err := e.send("isready"); err != nil {
		return err
	}
	return e.waitFor("readyok")
}

// NewGame resets the engine's per-game state.
func (e *UCIEngine) NewGame() error {
	if err := e.send("ucinewgame"); err != nil {
		return err
	}
	return e.isready()
}

// BestMove asks the engine for its move from position (openFEN + the UCI moves
// played since), under the given budget, returning the move in UCI notation.
func (e *UCIEngine) BestMove(openFEN string, moves []string, b UCIBudget) (string, error) {
	pos := "position fen " + openFEN
	if len(moves) > 0 {
		pos += " moves " + strings.Join(moves, " ")
	}
	if err := e.send(pos); err != nil {
		return "", err
	}
	if err := e.send(b.goLine()); err != nil {
		return "", err
	}
	for e.out.Scan() {
		f := strings.Fields(e.out.Text())
		if len(f) >= 2 && f[0] == "bestmove" {
			return f[1], nil
		}
	}
	if err := e.out.Err(); err != nil {
		return "", err
	}
	return "", io.EOF
}

// Evaluate asks the engine to search the position and returns its evaluation in
// centipawns from the SIDE-TO-MOVE's perspective (mate scores are mapped to a
// large bounded cp value). Used to label positions for Texel distillation.
func (e *UCIEngine) Evaluate(openFEN string, moves []string, b UCIBudget) (int, error) {
	pos := "position fen " + openFEN
	if len(moves) > 0 {
		pos += " moves " + strings.Join(moves, " ")
	}
	if err := e.send(pos); err != nil {
		return 0, err
	}
	if err := e.send(b.goLine()); err != nil {
		return 0, err
	}
	cp := 0
	for e.out.Scan() {
		f := strings.Fields(e.out.Text())
		if len(f) == 0 {
			continue
		}
		if f[0] == "info" {
			for i := 0; i+2 < len(f); i++ {
				if f[i] == "score" {
					switch f[i+1] {
					case "cp":
						if v, err := strconv.Atoi(f[i+2]); err == nil {
							cp = v
						}
					case "mate":
						if v, err := strconv.Atoi(f[i+2]); err == nil {
							if v >= 0 {
								cp = 20000 - v
							} else {
								cp = -20000 - v
							}
						}
					}
				}
			}
		} else if f[0] == "bestmove" {
			return cp, nil
		}
	}
	if err := e.out.Err(); err != nil {
		return 0, err
	}
	return cp, io.EOF
}

// Close terminates the engine process.
func (e *UCIEngine) Close() error {
	_ = e.send("quit")
	if e.stdin != nil {
		_ = e.stdin.Close()
	}
	if e.cmd != nil && e.cmd.Process != nil {
		_ = e.cmd.Process.Kill()
		_ = e.cmd.Wait()
	}
	return nil
}
