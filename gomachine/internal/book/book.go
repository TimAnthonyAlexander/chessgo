// Package book is a compiled, versioned, read-only opening book: a sorted array
// of precomputed (Zobrist -> eval/best-move/depth) records, loaded fully into RAM
// and binary-searched. It's the ".po -> .mo" artifact — built offline by
// `gomachine compile-book`, shipped as a sidecar file, consulted by the engine to
// skip re-searching known positions (the start position above all).
//
// File layout (little-endian):
//
//	header (24 bytes): magic "GMBK" | formatVer u32 | engineVer u32 | count u32 | crc32 u32 | pad u32
//	records (24 bytes each, sorted ascending by Key):
//	    Key u64 | Score i32 | Mate i16 | Depth i16 | Move [8]byte (UCI, null-padded)
//
// Score/Mate are SIDE-TO-MOVE relative (exactly what engine.SearchDirect returns),
// so a hit can be returned verbatim. The full 64-bit key is stored, so a hit is
// verified by exact compare — no Zobrist-collision risk — and any returned move is
// still re-validated against movegen by the caller before use.
package book

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"os"
	"sort"
)

// EngineVersion tags the eval/search generation a book was computed with. BUMP IT
// whenever a change makes old precomputed evals/moves stale (e.g. a re-tuned eval):
// a book whose tag != EngineVersion is safely ignored at load.
const EngineVersion = 1

const (
	magic       = "GMBK"
	formatVer   = 1
	headerSize  = 24
	recordSize  = 24
	moveFieldSz = 8
)

// Entry is one precomputed position. Move is UCI ("e2e4", "" if none).
type Entry struct {
	Key   uint64
	Score int
	Mate  int
	Depth int
	Move  string
}

// Book is a loaded, sorted, read-only set of entries.
type Book struct {
	entries []Entry
}

// Len reports how many positions the book holds.
func (b *Book) Len() int { return len(b.entries) }

// Lookup returns the entry for an exact Zobrist key, or ok=false.
func (b *Book) Lookup(key uint64) (Entry, bool) {
	es := b.entries
	i := sort.Search(len(es), func(i int) bool { return es[i].Key >= key })
	if i < len(es) && es[i].Key == key {
		return es[i], true
	}
	return Entry{}, false
}

// Write sorts entries by key (deduping, last-writer-wins) and writes the artifact.
func Write(path string, entries []Entry) error {
	dedup := make(map[uint64]Entry, len(entries))
	for _, e := range entries {
		dedup[e.Key] = e
	}
	sorted := make([]Entry, 0, len(dedup))
	for _, e := range dedup {
		sorted = append(sorted, e)
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Key < sorted[j].Key })

	body := make([]byte, len(sorted)*recordSize)
	for i, e := range sorted {
		off := i * recordSize
		binary.LittleEndian.PutUint64(body[off:], e.Key)
		binary.LittleEndian.PutUint32(body[off+8:], uint32(int32(e.Score)))
		binary.LittleEndian.PutUint16(body[off+12:], uint16(int16(e.Mate)))
		binary.LittleEndian.PutUint16(body[off+14:], uint16(int16(e.Depth)))
		copyMove(body[off+16:off+16+moveFieldSz], e.Move)
	}

	hdr := make([]byte, headerSize)
	copy(hdr[0:4], magic)
	binary.LittleEndian.PutUint32(hdr[4:], formatVer)
	binary.LittleEndian.PutUint32(hdr[8:], EngineVersion)
	binary.LittleEndian.PutUint32(hdr[12:], uint32(len(sorted)))
	binary.LittleEndian.PutUint32(hdr[16:], crc32.ChecksumIEEE(body))
	// hdr[20:24] reserved (zero)

	return os.WriteFile(path, append(hdr, body...), 0o644)
}

// Load reads and validates a book. Returns (nil, nil) — a usable "no book" — when
// the file is for a different engine/format version, so a stale artifact is simply
// ignored rather than breaking startup. A real IO/corruption problem is an error.
func Load(path string) (*Book, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(raw) < headerSize || string(raw[0:4]) != magic {
		return nil, fmt.Errorf("book %s: bad magic/too short", path)
	}
	if binary.LittleEndian.Uint32(raw[4:]) != formatVer {
		return nil, nil // unknown format → ignore
	}
	if binary.LittleEndian.Uint32(raw[8:]) != EngineVersion {
		return nil, nil // stale engine version → ignore
	}
	count := int(binary.LittleEndian.Uint32(raw[12:]))
	body := raw[headerSize:]
	if len(body) != count*recordSize {
		return nil, fmt.Errorf("book %s: size mismatch (have %d, want %d)", path, len(body), count*recordSize)
	}
	if binary.LittleEndian.Uint32(raw[16:]) != crc32.ChecksumIEEE(body) {
		return nil, fmt.Errorf("book %s: crc mismatch (corrupt)", path)
	}

	entries := make([]Entry, count)
	for i := range entries {
		off := i * recordSize
		entries[i] = Entry{
			Key:   binary.LittleEndian.Uint64(body[off:]),
			Score: int(int32(binary.LittleEndian.Uint32(body[off+8:]))),
			Mate:  int(int16(binary.LittleEndian.Uint16(body[off+12:]))),
			Depth: int(int16(binary.LittleEndian.Uint16(body[off+14:]))),
			Move:  readMove(body[off+16 : off+16+moveFieldSz]),
		}
	}
	return &Book{entries: entries}, nil
}

func copyMove(dst []byte, uci string) {
	for i := range dst {
		dst[i] = 0
	}
	copy(dst, uci)
}

func readMove(b []byte) string {
	n := 0
	for n < len(b) && b[n] != 0 {
		n++
	}
	return string(b[:n])
}
