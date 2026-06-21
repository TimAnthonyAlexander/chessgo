package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnuedata"
)

// cmdNNUEConvert turns Stockfish .plain training text into our flat 32-byte
// records (the only format the Go NNUE trainer reads). It does NOT touch binpack
// or Huffman — SF's C++ tool already produced the .plain. See DATA_PIPELINE §8.
//
// A .plain "block" is a run of key/value lines ending at a line beginning "e":
//
//	fen <FEN>
//	move <uci>
//	score <cp, side-to-move-relative>
//	ply <n>
//	result <-1|0|1, side-to-move-relative>
//	e
//
// Filters (skip the block) — applied in order, attributed in the report:
//   - unparseable FEN
//   - side to move in check        (unless --no-incheck-filter)
//   - |score| >= --score-limit
//   - ply < --min-ply
//
// Kept blocks are flipped to White's perspective before encoding.
func cmdNNUEConvert(args []string) {
	fs := flag.NewFlagSet("nnue-convert", flag.ExitOnError)
	plain := fs.String("plain", "", "comma-separated SF .plain input file(s); use \"-\" for stdin (stream)")
	out := fs.String("out", "", "output flat .bin file")
	scoreLimit := fs.Int("score-limit", 30000, "skip blocks with |score| >= this")
	minPly := fs.Int("min-ply", 8, "skip blocks with ply < this")
	sampleRate := fs.Int("sample-rate", 1, "keep 1 of every N blocks (uniform downsample of the whole stream; 1 = keep all)")
	noInCheck := fs.Bool("no-incheck-filter", false, "keep in-check positions (default: filter them)")
	_ = fs.Parse(args)
	if *sampleRate < 1 {
		*sampleRate = 1
	}

	if *plain == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "nnue-convert: --plain and --out are required")
		os.Exit(2)
	}

	outF, err := os.Create(*out)
	if err != nil {
		fmt.Fprintln(os.Stderr, "nnue-convert: create out:", err)
		os.Exit(1)
	}
	defer outF.Close()
	bw := bufio.NewWriter(outF)

	var st convStats
	for _, path := range strings.Split(*plain, ",") {
		path = strings.TrimSpace(path)
		if path == "" {
			continue
		}
		if err := convertFile(path, bw, *scoreLimit, *minPly, *sampleRate, !*noInCheck, &st); err != nil {
			fmt.Fprintf(os.Stderr, "nnue-convert: %s: %v\n", path, err)
			os.Exit(1)
		}
	}
	if err := bw.Flush(); err != nil {
		fmt.Fprintln(os.Stderr, "nnue-convert: flush:", err)
		os.Exit(1)
	}

	st.print(*out)
}

// convStats tallies read/kept/skip counts by reason for the final report.
type convStats struct {
	read         int
	kept         int
	skipParse    int
	skipIllegal  int
	skipIncheck  int
	skipScore    int
	skipPly      int
	skipEncode   int
	skipMalfblck int
}

func (s *convStats) print(out string) {
	fmt.Printf("read %d blocks, kept %d → %s\n", s.read, s.kept, out)
	fmt.Println("skipped:")
	fmt.Printf("  unparseable FEN  %d\n", s.skipParse)
	fmt.Printf("  illegal position %d\n", s.skipIllegal)
	fmt.Printf("  in check         %d\n", s.skipIncheck)
	fmt.Printf("  |score|>=limit   %d\n", s.skipScore)
	fmt.Printf("  ply<min-ply      %d\n", s.skipPly)
	fmt.Printf("  encode error     %d\n", s.skipEncode)
	fmt.Printf("  malformed block  %d\n", s.skipMalfblck)
}

// convertFile streams one .plain file (or stdin when path == "-") block-by-block
// into bw. With sampleRate>1 it keeps only every Nth block — uniformly across the
// whole stream, so piping the entire (unseekable) binpack through with a low keep
// rate yields a decorrelated sample. Sampling happens BEFORE the parse/filter, so
// the expensive ParseFEN is paid only on kept blocks.
func convertFile(path string, bw *bufio.Writer, scoreLimit, minPly, sampleRate int, filterInCheck bool, st *convStats) error {
	f := os.Stdin
	if path != "-" {
		var err error
		f, err = os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
	}

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var b plainBlock
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		key, val, _ := strings.Cut(line, " ")
		switch key {
		case "fen":
			b.fen = strings.TrimSpace(val)
		case "move":
			// unused for static eval data
		case "score":
			b.score, b.hasScore = parseInt(val)
		case "ply":
			b.ply, b.hasPly = parseInt(val)
		case "result":
			b.result, b.hasResult = parseInt(val)
		case "e":
			st.read++
			if st.read%sampleRate == 0 {
				processBlock(b, bw, scoreLimit, minPly, filterInCheck, st)
			}
			if st.read%20000000 == 0 {
				fmt.Fprintf(os.Stderr, "  …%dM blocks read, %d kept\n", st.read/1000000, st.kept)
			}
			b = plainBlock{}
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	// A trailing block with no "e" terminator is malformed; count it if present.
	if b.fen != "" {
		st.read++
		st.skipMalfblck++
	}
	return nil
}

// plainBlock accumulates one .plain block's fields.
type plainBlock struct {
	fen                         string
	score, ply, result          int
	hasScore, hasPly, hasResult bool
}

func parseInt(s string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	return n, err == nil
}

// processBlock applies filters, flips to White's perspective, encodes, and
// writes one record (or records the skip reason).
func processBlock(b plainBlock, bw *bufio.Writer, scoreLimit, minPly int, filterInCheck bool, st *convStats) {
	if b.fen == "" || !b.hasScore || !b.hasResult {
		st.skipMalfblck++
		return
	}
	pos, err := chess.ParseFEN(b.fen)
	if err != nil {
		st.skipParse++
		return
	}
	// Never trust external data: a corrupt record can yield a kingless / illegal
	// board that ParseFEN accepts but InCheck() would panic on (kingSq → 64 →
	// out-of-range attack-table index). Legal() is panic-safe (kings-present
	// short-circuit) and also drops genuinely illegal positions (opponent in
	// check), which aren't valid training data anyway.
	if !pos.Legal() {
		st.skipIllegal++
		return
	}
	if filterInCheck && pos.InCheck() {
		st.skipIncheck++
		return
	}
	if b.score >= scoreLimit || b.score <= -scoreLimit {
		st.skipScore++
		return
	}
	if b.hasPly && b.ply < minPly {
		st.skipPly++
		return
	}

	// Flip STM-relative score+result to White's frame.
	whiteScore := int16Clamp(b.score)
	whiteR := b.result // already White-relative if White to move
	if pos.SideToMove() == chess.Black {
		whiteScore = -whiteScore
		whiteR = -whiteR
	}
	// whiteR ∈ {-1,0,1} → result byte {0,1,2}.
	if whiteR < -1 {
		whiteR = -1
	} else if whiteR > 1 {
		whiteR = 1
	}
	resultByte := uint8(whiteR + 1)

	rec, err := nnuedata.Encode(b.fen, whiteScore, resultByte)
	if err != nil {
		st.skipEncode++
		return
	}
	if err := nnuedata.WriteRecord(bw, rec); err != nil {
		// Treat a write failure as fatal-ish: surface and stop counting kept.
		fmt.Fprintln(os.Stderr, "nnue-convert: write:", err)
		return
	}
	st.kept++
}

// int16Clamp clamps an int into the int16 range (scores past ±32767 are mate-ish
// extremes that the score-limit filter normally already removes).
func int16Clamp(v int) int16 {
	if v > 32767 {
		return 32767
	}
	if v < -32768 {
		return -32768
	}
	return int16(v)
}
