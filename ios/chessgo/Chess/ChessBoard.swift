import Foundation

/// A chess position for rendering purposes only. The engine is the rules
/// authority — this type never decides legality, check, or game end; it just
/// parses FEN and applies a move visually so the UI has something to show
/// before the server responds.
///
/// `duckSquare` and `pocket` are NOT part of a FEN — the server sends them as
/// separate fields alongside `fen` (see `LiveGameState`/bot-game responses).
/// `init(fen:)` always produces `nil` for both; callers merge in the server's
/// values with `withDuckSquare`/`withPocket`.
struct ChessBoard: Sendable, Equatable {
    let squares: [Piece?] // count 64, indexed by Square.index (a1 = 0, h8 = 63)
    let sideToMove: PieceColor
    let castlingRights: String // raw FEN field: "KQkq", "-", or a Chess960 file-letter form
    let enPassant: Square?
    let halfmoveClock: Int
    let fullmoveNumber: Int
    let duckSquare: Square?
    let pocket: String? // Crazyhouse pocket, e.g. "PPNq" (white upper, black lower)

    static let startFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

    /// Parse a FEN. Malformed input degrades to sensible defaults (empty
    /// board, white to move, no rights) rather than crashing — this only
    /// renders, it is never asked to judge the position.
    init(fen: String) {
        let fields = fen.split(separator: " ", omittingEmptySubsequences: true).map(String.init)

        var placed = [Piece?](repeating: nil, count: 64)
        if let placement = fields.first {
            let rows = placement.split(separator: "/", omittingEmptySubsequences: false)
            for (rowIndex, row) in rows.enumerated() where rowIndex < 8 {
                let rank = 7 - rowIndex // FEN lists rank 8 first
                var file = 0
                for char in row {
                    if let digit = char.wholeNumberValue, (1...8).contains(digit) {
                        file += digit
                    } else if let piece = Piece(fenChar: char), file < 8 {
                        if let square = Square(file: file, rank: rank) {
                            placed[square.index] = piece
                        }
                        file += 1
                    }
                }
            }
        }
        self.squares = placed

        self.sideToMove = (fields.count > 1 && fields[1] == "b") ? .black : .white
        self.castlingRights = fields.count > 2 ? fields[2] : "-"
        self.enPassant = (fields.count > 3) ? Square(algebraic: fields[3]) : nil
        self.halfmoveClock = (fields.count > 4) ? (Int(fields[4]) ?? 0) : 0
        self.fullmoveNumber = (fields.count > 5) ? (Int(fields[5]) ?? 1) : 1
        self.duckSquare = nil
        self.pocket = nil
    }

    private init(
        squares: [Piece?],
        sideToMove: PieceColor,
        castlingRights: String,
        enPassant: Square?,
        halfmoveClock: Int,
        fullmoveNumber: Int,
        duckSquare: Square?,
        pocket: String?
    ) {
        self.squares = squares
        self.sideToMove = sideToMove
        self.castlingRights = castlingRights
        self.enPassant = enPassant
        self.halfmoveClock = halfmoveClock
        self.fullmoveNumber = fullmoveNumber
        self.duckSquare = duckSquare
        self.pocket = pocket
    }

    func piece(at square: Square) -> Piece? { squares[square.index] }

    /// Copy with the duck square replaced (Duck Chess; server-provided, not FEN).
    func withDuckSquare(_ square: Square?) -> ChessBoard {
        ChessBoard(squares: squares, sideToMove: sideToMove, castlingRights: castlingRights,
                   enPassant: enPassant, halfmoveClock: halfmoveClock, fullmoveNumber: fullmoveNumber,
                   duckSquare: square, pocket: pocket)
    }

    /// Copy with the Crazyhouse pocket replaced (server-provided, not FEN).
    func withPocket(_ pocket: String?) -> ChessBoard {
        ChessBoard(squares: squares, sideToMove: sideToMove, castlingRights: castlingRights,
                   enPassant: enPassant, halfmoveClock: halfmoveClock, fullmoveNumber: fullmoveNumber,
                   duckSquare: duckSquare, pocket: pocket)
    }

    /// Apply a submitted turn visually and return a new board. Accepts any of
    /// the three wire formats (`Move`/`Drop`/`DuckMove` via `WireMove`).
    /// Best-effort rendering — an unparseable or from-empty-square move
    /// returns `self` unchanged rather than trapping.
    func applying(_ uci: String) -> ChessBoard {
        guard let move = WireMove(uci: uci) else { return self }
        switch move {
        case .standard(let move):
            return applyingStandard(move)
        case .drop(let drop):
            return applyingDrop(drop)
        case .duck(let duck):
            return applyingStandard(duck.pieceMove).withDuckSquare(duck.duckTarget)
        }
    }

    private func applyingDrop(_ drop: Drop) -> ChessBoard {
        var next = squares
        next[drop.target.index] = Piece(color: sideToMove, kind: drop.piece)

        var nextPocket = pocket
        if var pocketChars = pocket.map(Array.init) {
            let letter = sideToMove == .white ? drop.piece.fenLetter : Character(drop.piece.fenLetter.lowercased())
            if let removeIndex = pocketChars.firstIndex(of: letter) {
                pocketChars.remove(at: removeIndex)
                nextPocket = String(pocketChars)
            }
        }

        return ChessBoard(squares: next, sideToMove: sideToMove.opposite, castlingRights: castlingRights,
                           enPassant: nil, halfmoveClock: halfmoveClock + 1, fullmoveNumber: nextFullmoveNumber(),
                           duckSquare: duckSquare, pocket: nextPocket)
    }

    private func applyingStandard(_ move: Move) -> ChessBoard {
        guard let moving = piece(at: move.from) else { return self }

        var next = squares
        next[move.from.index] = nil

        let isCapture = squares[move.to.index] != nil
        let isPawn = moving.kind == .pawn

        // En passant: a pawn moves diagonally onto an empty square — the
        // captured pawn sits behind the target, on (to-file, from-rank).
        var isEnPassant = false
        if isPawn, move.from.file != move.to.file, squares[move.to.index] == nil,
           let capturedSquare = Square(file: move.to.file, rank: move.from.rank) {
            next[capturedSquare.index] = nil
            isEnPassant = true
        }

        if let promotion = move.promotion {
            next[move.to.index] = Piece(color: moving.color, kind: promotion)
        } else {
            next[move.to.index] = moving
        }

        var nextCastlingRights = castlingRights
        if moving.kind == .king {
            moveRookForCastling(&next, king: moving, from: move.from, to: move.to)
            // Losing the king forfeits both of that color's rights, whether
            // this was an actual castle or a plain king step.
            nextCastlingRights = stripCastlingRights(nextCastlingRights, color: moving.color)
        }

        var nextEnPassant: Square?
        if isPawn, abs(move.to.rank - move.from.rank) == 2 {
            nextEnPassant = Square(file: move.from.file, rank: (move.from.rank + move.to.rank) / 2)
        }

        let resetsClock = isPawn || isCapture || isEnPassant
        return ChessBoard(squares: next, sideToMove: sideToMove.opposite, castlingRights: nextCastlingRights,
                           enPassant: nextEnPassant, halfmoveClock: resetsClock ? 0 : halfmoveClock + 1,
                           fullmoveNumber: nextFullmoveNumber(), duckSquare: duckSquare, pocket: pocket)
    }

    private func nextFullmoveNumber() -> Int {
        sideToMove == .black ? fullmoveNumber + 1 : fullmoveNumber
    }

    /// Detect and perform the rook hop for a king move that castles. Two
    /// shapes: standard (king travels exactly two files) and Chess960 (the
    /// king lands directly on its own rook's g/c-file, any file distance).
    /// Best-effort — leaves the king moved with no rook hop if no rook is
    /// found, since the true source of truth is the server's next FEN.
    private func moveRookForCastling(_ squares: inout [Piece?], king: Piece, from: Square, to: Square) {
        let backRank = king.color == .white ? 0 : 7
        guard from.rank == backRank, to.rank == backRank else { return }

        let fileDiff = abs(to.file - from.file)
        var side: CastleSide?
        if fileDiff == 2 {
            side = to.file > from.file ? .kingside : .queenside
        } else if fileDiff != 1, to.file == 6 || to.file == 2 {
            side = to.file == 6 ? .kingside : .queenside
        }
        guard let side else { return }

        let rook = Piece(color: king.color, kind: .rook)
        switch side {
        case .kingside:
            // Rook on the highest file to the right of the king moves to f-file.
            for file in stride(from: 7, through: from.file + 1, by: -1) {
                guard let square = Square(file: file, rank: backRank) else { continue }
                if squares[square.index] == rook {
                    squares[square.index] = nil
                    if let target = Square(file: 5, rank: backRank) { squares[target.index] = rook }
                    return
                }
            }
        case .queenside:
            // Rook on the lowest file to the left of the king moves to d-file.
            for file in 0..<from.file {
                guard let square = Square(file: file, rank: backRank) else { continue }
                if squares[square.index] == rook {
                    squares[square.index] = nil
                    if let target = Square(file: 3, rank: backRank) { squares[target.index] = rook }
                    return
                }
            }
        }
    }

    private func stripCastlingRights(_ rights: String, color: PieceColor) -> String {
        guard rights != "-" else { return rights }
        let stripped = rights.filter { char in
            color == .white ? !char.isUppercase : !(char.isLowercase)
        }
        return stripped.isEmpty ? "-" : stripped
    }

    /// Reconstruct a FEN from current state. Best-effort — castling rights
    /// tracking above only clears rights on a king move, not on a rook
    /// moving/being captured from a corner, so this can drift from the
    /// server's authoritative FEN over a long game; refresh from the server
    /// whenever possible.
    func fen() -> String {
        var placement = ""
        for rowIndex in 0..<8 {
            let rank = 7 - rowIndex
            var emptyRun = 0
            for file in 0..<8 {
                guard let square = Square(file: file, rank: rank), let piece = squares[square.index] else {
                    emptyRun += 1
                    continue
                }
                if emptyRun > 0 {
                    placement += String(emptyRun)
                    emptyRun = 0
                }
                placement.append(piece.fenChar)
            }
            if emptyRun > 0 { placement += String(emptyRun) }
            if rowIndex < 7 { placement += "/" }
        }

        let side = sideToMove == .white ? "w" : "b"
        let ep = enPassant?.algebraic ?? "-"
        return "\(placement) \(side) \(castlingRights) \(ep) \(halfmoveClock) \(fullmoveNumber)"
    }
}

private enum CastleSide {
    case kingside
    case queenside
}
