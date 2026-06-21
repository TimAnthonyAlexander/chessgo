package nnuetrain

import (
	"fmt"
	"io"
	"math/bits"
	"os"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
	"github.com/timanthonyalexander/gomachine/internal/nnuedata"
)

// RawData is a memory-compact training set: the .flat file's 32-byte records held
// verbatim in one []byte, decoded to features on the fly per-minibatch. At 32 B/
// record this is ~4.8 GB for 150M positions (vs ~25 GB if features were
// pre-extracted), so it fits the trainer's RAM budget. Decoding is pure bit-ops
// (no FEN string, no chess.ParseFEN) so per-epoch decode overhead stays small.
type RawData struct {
	records []byte // n*RecordSize bytes, record i at [i*RecordSize : (i+1)*RecordSize]
	n       int    // number of records
}

// Len returns the number of records.
func (d *RawData) Len() int { return d.n }

// LoadFlatRaw reads up to limit records (0 = all) of a .flat training file into a
// single []byte and returns the raw-backed dataset. It is the low-memory loader
// the --flat path uses: records stay compact (32 B each) and are decoded per
// batch via decodeRecord, never pre-expanded into samples.
func LoadFlatRaw(path string, limit int) (*RawData, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return nil, 0, fmt.Errorf("stat %s: %w", path, err)
	}

	// Total whole records on disk, then cap by --limit.
	total := int(fi.Size() / nnuedata.RecordSize)
	want := total
	if limit > 0 && limit < want {
		want = limit
	}

	buf := make([]byte, want*nnuedata.RecordSize)
	read, err := io.ReadFull(f, buf)
	if err == io.ErrUnexpectedEOF || err == io.EOF {
		// File shorter than its size implied (or empty); keep the whole records read.
		read = read - (read % nnuedata.RecordSize)
		buf = buf[:read]
	} else if err != nil {
		return nil, 0, fmt.Errorf("read %s: %w", path, err)
	}
	n := len(buf) / nnuedata.RecordSize
	return &RawData{records: buf, n: n}, n, nil
}

// decodeRecord turns one 32-byte raw record into the same training quantities
// LoadFlat's FEN path produces — active features from both perspectives plus the
// stm-relative eval score and result win-prob — WITHOUT building a FEN or calling
// chess.ParseFEN. It walks the occupancy bitmap + nibble stream directly and emits
// nnue.FeatureIndex for each piece (the single source of truth shared with
// inference), so featsStm/featsOpp are byte-identical to nnue.AppendFeatures.
//
// featStm/featOpp are scratch slices (pass buf[:0] with cap ≥ maxActive) reused
// across calls to avoid per-record allocation; the returned slices alias them.
func decodeRecord(rec []byte, featStm, featOpp []uint16) (featsStm, featsOpp []uint16, stmScore, stmResultWP float64) {
	occ := getU64(rec[0:8])

	stm := chess.White
	if rec[24] != 0 {
		stm = chess.Black
	}
	opp := stm.Opposite()

	nibbleIdx := 0
	o := occ
	for o != 0 {
		sq := chess.Square(bits.TrailingZeros64(o))
		o &= o - 1 // clear lowest set bit
		pc := chess.Piece(getNibble(rec[8:24], nibbleIdx))
		nibbleIdx++
		featStm = append(featStm, nnue.FeatureIndex(stm, pc, sq))
		featOpp = append(featOpp, nnue.FeatureIndex(opp, pc, sq))
	}

	// Labels: White-relative score/result flipped into the stm frame (identical
	// convention to LoadFlat's FEN path).
	whiteScore := getI16(rec[28:30])
	result := rec[30]
	white := stm == chess.White

	stmScore = float64(whiteScore)
	if !white {
		stmScore = -stmScore
	}
	whiteWP := float64(result) / 2.0
	stmResultWP = whiteWP
	if !white {
		stmResultWP = 1 - whiteWP
	}
	return featStm, featOpp, stmScore, stmResultWP
}

// getU64/getNibble/getI16 are the same little-endian readers nnuedata uses; they
// are re-derived here (rather than exported) so this package stays decoupled from
// nnuedata's internals while reading the documented record layout. Kept identical
// to nnuedata's helpers by construction (see internal/nnuedata/flat.go).
func getU64(buf []byte) uint64 {
	var v uint64
	for i := 0; i < 8; i++ {
		v |= uint64(buf[i]) << (8 * uint(i))
	}
	return v
}

func getNibble(buf []byte, i int) byte {
	b := buf[i>>1]
	if i&1 == 0 {
		return b & 0x0f
	}
	return b >> 4
}

func getI16(buf []byte) int16 {
	return int16(uint16(buf[0]) | uint16(buf[1])<<8)
}
