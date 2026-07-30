import Foundation

/// Real board geometry: which squares a piece ATTACKS, and the pseudo-legal
/// moves a side has. Display-only, like the rest of `Chess/` — the engine
/// remains the rules authority for anything that is actually played.
///
/// This exists because `premoveTargets` (`Chess/Premove.swift`) is deliberately
/// PERMISSIVE and must stay that way: for premoves, a ray passes *through* the
/// first blocker (it may move away before your turn comes) and a pawn "targets"
/// the squares it pushes to. That set is far too generous to answer "is the
/// king attacked?" — an x-rayed rook or a pawn one square below the king both
/// register as attackers, so almost any move looks like check. Attack tests
/// need this file; premove UI needs that one.
enum Attacks {
    /// Squares the piece on `from` genuinely attacks. Rays stop at the first
    /// occupied square — that square IS attacked (it may hold the enemy king or
    /// a capturable piece); anything behind it is not. Pawns attack only their
    /// two forward diagonals, never the square in front of them. Castling
    /// targets are not attacks.
    static func squares(from: Square, board: ChessBoard) -> [Square] {
        guard let piece = board.piece(at: from) else { return [] }
        var out: [Square] = []

        func step(_ file: Int, _ rank: Int) {
            if let square = Square(file: file, rank: rank) { out.append(square) }
        }

        func ray(_ df: Int, _ dr: Int) {
            for i in 1...7 {
                guard let square = Square(file: from.file + df * i, rank: from.rank + dr * i) else { return }
                out.append(square)
                if board.piece(at: square) != nil { return } // blocked: nothing beyond is attacked
            }
        }

        switch piece.kind {
        case .pawn:
            let direction = piece.color == .white ? 1 : -1
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
        case .bishop:
            ray(1, 1); ray(1, -1); ray(-1, 1); ray(-1, -1)
        case .rook:
            ray(1, 0); ray(-1, 0); ray(0, 1); ray(0, -1)
        case .queen:
            ray(1, 1); ray(1, -1); ray(-1, 1); ray(-1, -1)
            ray(1, 0); ray(-1, 0); ray(0, 1); ray(0, -1)
        }

        return out
    }

    /// Is `square` attacked by any piece of `color`?
    static func isAttacked(_ square: Square, by color: PieceColor, board: ChessBoard) -> Bool {
        Square.all.contains { origin in
            board.piece(at: origin)?.color == color && squares(from: origin, board: board).contains(square)
        }
    }

    static func kingSquare(of color: PieceColor, board: ChessBoard) -> Square? {
        Square.all.first { board.piece(at: $0) == Piece(color: color, kind: .king) }
    }

    static func isInCheck(_ color: PieceColor, board: ChessBoard) -> Bool {
        guard let king = kingSquare(of: color, board: board) else { return false }
        return isAttacked(king, by: color.opposite, board: board)
    }

    /// Destinations the piece on `from` can pseudo-legally move to: attacks
    /// minus own-occupied squares, plus the pawn pushes that attacks exclude,
    /// minus the pawn diagonals that have nothing to capture. Pins and moving
    /// into check are NOT filtered — callers that care do so by applying the
    /// move and testing `isInCheck`. Castling is omitted (never needed for the
    /// two callers: check detection and SAN disambiguation).
    static func pseudoLegalTargets(from: Square, board: ChessBoard) -> [Square] {
        guard let piece = board.piece(at: from) else { return [] }

        if piece.kind == .pawn {
            var out: [Square] = []
            let direction = piece.color == .white ? 1 : -1
            let startRank = piece.color == .white ? 1 : 6
            if let ahead = Square(file: from.file, rank: from.rank + direction), board.piece(at: ahead) == nil {
                out.append(ahead)
                if from.rank == startRank,
                   let twoAhead = Square(file: from.file, rank: from.rank + 2 * direction),
                   board.piece(at: twoAhead) == nil {
                    out.append(twoAhead)
                }
            }
            for diagonal in squares(from: from, board: board) {
                let occupant = board.piece(at: diagonal)
                if occupant?.color == piece.color.opposite || diagonal == board.enPassant {
                    out.append(diagonal)
                }
            }
            return out
        }

        return squares(from: from, board: board).filter { board.piece(at: $0)?.color != piece.color }
    }

    /// Does `color` have any move that leaves its own king unattacked? Used to
    /// tell "+" from "#". Pins are handled naturally (the move is applied and
    /// the king re-tested); the only gap left is castling, which can never be a
    /// way out of check anyway.
    static func hasLegalMove(_ color: PieceColor, board: ChessBoard) -> Bool {
        for origin in Square.all {
            guard let piece = board.piece(at: origin), piece.color == color else { continue }
            for target in pseudoLegalTargets(from: origin, board: board) {
                let promotion: PieceKind? = (piece.kind == .pawn && (target.rank == 0 || target.rank == 7)) ? .queen : nil
                let after = board.applying(Move(from: origin, to: target, promotion: promotion).uci)
                if !isInCheck(color, board: after) { return true }
            }
        }
        return false
    }
}
