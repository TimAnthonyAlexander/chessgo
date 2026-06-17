package chess

// Perft counts the number of strictly-legal leaf nodes reachable in exactly
// `depth` plies. It is the gold-standard movegen correctness test (SPEC §5.5).
func Perft(pos *Position, depth int) uint64 {
	if depth == 0 {
		return 1
	}
	var ml MoveList
	pos.GenerateLegal(&ml)
	if depth == 1 {
		return uint64(ml.count)
	}
	var nodes uint64
	for i := 0; i < ml.count; i++ {
		var u Undo
		pos.DoMove(ml.moves[i], &u)
		nodes += Perft(pos, depth-1)
		pos.UndoMove(ml.moves[i], &u)
	}
	return nodes
}

// Divide returns per-root-move perft counts (split perft) for debugging, plus
// the total.
func Divide(pos *Position, depth int) (map[string]uint64, uint64) {
	result := make(map[string]uint64)
	var total uint64
	var ml MoveList
	pos.GenerateLegal(&ml)
	for i := 0; i < ml.count; i++ {
		m := ml.moves[i]
		var u Undo
		pos.DoMove(m, &u)
		var n uint64 = 1
		if depth > 1 {
			n = Perft(pos, depth-1)
		}
		pos.UndoMove(m, &u)
		result[m.String()] = n
		total += n
	}
	return result, total
}
