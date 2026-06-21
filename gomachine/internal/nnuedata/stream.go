package nnuedata

import (
	"errors"
	"io"
)

// WriteRecord writes one 32-byte flat record to w.
func WriteRecord(w io.Writer, rec [RecordSize]byte) error {
	_, err := w.Write(rec[:])
	return err
}

// Reader streams fixed-size flat records from an io.Reader.
type Reader struct {
	r io.Reader
}

// NewReader wraps r to iterate 32-byte records. Wrap r in a bufio.Reader at the
// call site for throughput on real files.
func NewReader(r io.Reader) *Reader { return &Reader{r: r} }

// Next reads the next record. It returns io.EOF when the stream is exhausted on
// a record boundary, and io.ErrUnexpectedEOF on a truncated trailing record.
func (rd *Reader) Next() ([RecordSize]byte, error) {
	var rec [RecordSize]byte
	n, err := io.ReadFull(rd.r, rec[:])
	if err == nil {
		return rec, nil
	}
	if err == io.EOF && n == 0 {
		return rec, io.EOF
	}
	if err == io.ErrUnexpectedEOF || (err == io.EOF && n > 0) {
		return rec, errors.New("nnuedata: truncated record at end of stream")
	}
	return rec, err
}
