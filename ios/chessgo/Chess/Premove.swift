import Foundation

/// Pseudo-legal destination squares for a PREMOVE — the moves a piece could
/// make by its own geometry, evaluated while it isn't your turn (so the real
/// legal-move list from the server isn't available yet). Deliberately
/// permissive, Chess.com-style: ignores whose turn it is, check, and pins.
/// Sliders may reach through a single intervening piece (it could move or be
/// captured by the time it's your turn) but stop at a second. Own-occupied
/// squares are included: premoving onto a friendly piece is valid play (it
/// only executes once the opponent vacates that square). The queued move is
/// still matched against the real legal moves before it's ever sent, so
/// anything still illegal on your turn is simply discarded there.
func premoveTargets(from: Square, board: ChessBoard) -> [Square] {
    guard let piece = board.piece(at: from) else { return [] }
    var out = Set<Square>()

    func step(_ file: Int, _ rank: Int) {
        if let square = Square(file: file, rank: rank) { out.insert(square) }
    }

    // Walk a ray, passing through at most one occupant: the first blocker is
    // added (it may be captured or move away) and the ray continues one more
    // stretch past it; a second occupant is added, then the ray stops.
    func ray(_ df: Int, _ dr: Int) {
        var passedBlocker = false
        for i in 1...7 {
            guard let square = Square(file: from.file + df * i, rank: from.rank + dr * i) else { break }
            out.insert(square)
            if board.piece(at: square) != nil {
                if passedBlocker { break }
                passedBlocker = true
            }
        }
    }

    switch piece.kind {
    case .pawn:
        let direction = piece.color == .white ? 1 : -1
        let startRank = piece.color == .white ? 1 : 6
        step(from.file, from.rank + direction)
        if from.rank == startRank { step(from.file, from.rank + 2 * direction) }
        step(from.file - 1, from.rank + direction)
        step(from.file + 1, from.rank + direction)
    case .knight:
        for (df, dr) in [(1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2)] {
            step(from.file + df, from.rank + dr)
        }
    case .king:
        for df in -1...1 {
            for dr in -1...1 where df != 0 || dr != 0 {
                step(from.file + df, from.rank + dr)
            }
        }
        if from.file == 4 {
            step(6, from.rank) // kingside castle target
            step(2, from.rank) // queenside castle target
        }
    case .bishop:
        ray(1, 1); ray(1, -1); ray(-1, 1); ray(-1, -1)
    case .rook:
        ray(1, 0); ray(-1, 0); ray(0, 1); ray(0, -1)
    case .queen:
        ray(1, 1); ray(1, -1); ray(-1, 1); ray(-1, -1)
        ray(1, 0); ray(-1, 0); ray(0, 1); ray(0, -1)
    }

    out.remove(from)
    return Array(out)
}

/// An ordered queue of client-only premoves. Board rendering shows the
/// position "folded" through the chain; on your turn, the head is matched
/// against the server's real legal moves and either sent or the whole chain
/// is discarded (a mismatched head invalidates everything queued behind it).
struct PremoveChain: Sendable, Equatable {
    let moves: [Move]

    static let empty = PremoveChain(moves: [])

    var isEmpty: Bool { moves.isEmpty }

    func appending(_ move: Move) -> PremoveChain {
        PremoveChain(moves: moves + [move])
    }

    func droppingFirst() -> PremoveChain {
        PremoveChain(moves: Array(moves.dropFirst()))
    }

    /// Apply every queued move in order, visually, for rendering.
    func folded(over board: ChessBoard) -> ChessBoard {
        moves.reduce(board) { $0.applying($1.uci) }
    }

    /// Match the chain's head against the real legal-move list. An exact UCI
    /// match (including promotion) wins; otherwise any legal move sharing the
    /// head's from/to is accepted (promotion piece is ignored, since a queued
    /// premove's choice may not be what the server enumerates). Returns the
    /// server-form UCI to submit, or `nil` if the head is no longer legal —
    /// the caller should then discard the whole chain.
    func matchedHead(against legalMoves: [String]) -> String? {
        guard let head = moves.first else { return nil }
        if legalMoves.contains(head.uci) { return head.uci }
        for legal in legalMoves {
            guard let legalMove = Move(uci: legal) else { continue }
            if legalMove.from == head.from && legalMove.to == head.to { return legal }
        }
        return nil
    }
}
