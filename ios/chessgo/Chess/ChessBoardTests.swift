import Foundation

#if DEBUG
/// Self-contained sanity checks for the Chess/ layer. There is no XCTest
/// target in this app, so these run as plain `assert`s — call
/// `ChessSelfCheck.run()` once from a debug entry point (e.g. app launch).
/// Asserts no-op in release builds; this whole file only compiles in DEBUG.
enum ChessSelfCheck {
    static func run() {
        checkStartPositionParses()
        checkPawnPush()
        checkStandardCastlingMovesRook()
        checkEnPassantRemovesCapturedPawn()
        checkPromotion()
        checkChess960FenParses()
        checkKnightPremoveTargets()
        checkSecretQueenFenTrailerTolerated()
        checkSecretQueenPawnShapedMoves()
        checkSecretQueenOptimisticRevealPatch()
    }

    private static func sq(_ algebraic: String) -> Square {
        Square(algebraic: algebraic)!
    }

    private static func checkStartPositionParses() {
        let board = ChessBoard(fen: ChessBoard.startFEN)
        let occupied = Square.all.compactMap { board.piece(at: $0) }
        assert(occupied.count == 32, "start position should have 32 pieces")
        assert(board.piece(at: sq("e1")) == Piece(color: .white, kind: .king))
        assert(board.piece(at: sq("e8")) == Piece(color: .black, kind: .king))
        assert(board.piece(at: sq("a1")) == Piece(color: .white, kind: .rook))
        assert(board.piece(at: sq("h8")) == Piece(color: .black, kind: .rook))
        assert(board.sideToMove == .white)
        assert(board.castlingRights == "KQkq")
    }

    private static func checkPawnPush() {
        let board = ChessBoard(fen: ChessBoard.startFEN)
        let next = board.applying("e2e4")
        assert(next.piece(at: sq("e2")) == nil, "e2 should be empty after e2e4")
        assert(next.piece(at: sq("e4")) == Piece(color: .white, kind: .pawn))
        assert(next.sideToMove == .black)
        assert(next.enPassant == sq("e3"), "double push should set the en passant square")
    }

    private static func checkStandardCastlingMovesRook() {
        let board = ChessBoard(fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
        let next = board.applying("e1g1")
        assert(next.piece(at: sq("g1")) == Piece(color: .white, kind: .king))
        assert(next.piece(at: sq("f1")) == Piece(color: .white, kind: .rook), "rook should hop to f1")
        assert(next.piece(at: sq("h1")) == nil, "h1 rook should have moved")
        assert(next.piece(at: sq("e1")) == nil)
    }

    private static func checkEnPassantRemovesCapturedPawn() {
        let board = ChessBoard(fen: "8/8/8/3pP3/8/8/8/K6k w - d6 0 1")
        let next = board.applying("e5d6")
        assert(next.piece(at: sq("d6")) == Piece(color: .white, kind: .pawn))
        assert(next.piece(at: sq("d5")) == nil, "captured pawn should be removed")
        assert(next.piece(at: sq("e5")) == nil)
    }

    private static func checkPromotion() {
        let board = ChessBoard(fen: "8/4P3/8/8/8/8/8/K6k w - - 0 1")
        let next = board.applying("e7e8q")
        assert(next.piece(at: sq("e8")) == Piece(color: .white, kind: .queen))
    }

    private static func checkChess960FenParses() {
        let board = ChessBoard(fen: "bqnbrkrn/pppppppp/8/8/8/8/PPPPPPPP/BQNBRKRN w KQkq - 0 1")
        let occupied = Square.all.compactMap { board.piece(at: $0) }
        assert(occupied.count == 32, "960 start position should still have 32 pieces")
        assert(board.piece(at: sq("a1")) == Piece(color: .white, kind: .bishop))
        assert(board.piece(at: sq("f1")) == Piece(color: .white, kind: .king))
    }

    private static func checkKnightPremoveTargets() {
        let board = ChessBoard(fen: "8/8/8/8/3N4/8/8/K6k w - - 0 1")
        let targets = premoveTargets(from: sq("d4"), board: board)
        assert(targets.count == 8, "a knight on a central square has 8 L-shaped targets, got \(targets.count)")
        let expected: Set<Square> = [
            sq("b3"), sq("b5"), sq("c2"), sq("c6"),
            sq("e2"), sq("e6"), sq("f3"), sq("f5"),
        ]
        assert(Set(targets) == expected, "knight targets should be exactly the 8 L-shapes from d4")
    }

    // MARK: - Secret Queen

    private static func checkSecretQueenFenTrailerTolerated() {
        let board = ChessBoard(fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [e2|h7]")
        let occupied = Square.all.compactMap { board.piece(at: $0) }
        assert(occupied.count == 32, "the trailing [w|b] field should be ignored, not break placement parsing")
        assert(board.sideToMove == .white)
        assert(board.fullmoveNumber == 1, "fields past index 5 shouldn't shift the real ones")
    }

    private static func checkSecretQueenPawnShapedMoves() {
        let board = ChessBoard(fen: ChessBoard.startFEN)
        assert(SecretQueen.isPawnShaped(uci: "e2e3", color: .white, board: board), "single push")
        assert(SecretQueen.isPawnShaped(uci: "e2e4", color: .white, board: board), "double push from home")
        assert(!SecretQueen.isPawnShaped(uci: "e2e5", color: .white, board: board), "not a legal pawn distance")
        assert(!SecretQueen.isPawnShaped(uci: "e2a6", color: .white, board: board), "diagonal slide is a queen move, not a pawn one")

        let midgame = ChessBoard(fen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2")
        assert(SecretQueen.isPawnShaped(uci: "e4d5", color: .white, board: midgame), "diagonal onto an occupied square is an ordinary pawn capture")
        assert(!SecretQueen.isPawnShaped(uci: "e4d5", color: .black, board: midgame), "the wrong color's forward direction shouldn't match")

        // Destination e4 is empty, but e3 (the square a double push passes
        // through) is occupied — the push should still be refused.
        let blocked = ChessBoard(fen: "8/8/8/8/8/4p3/4P3/K6k w - - 0 1")
        assert(!SecretQueen.isPawnShaped(uci: "e2e4", color: .white, board: blocked), "double push through an occupied square isn't pawn-shaped")
    }

    /// Mirrors what `BotGameDriver.applyOptimistic` does for a Secret Queen
    /// reveal: apply the move, then patch the destination to a real queen —
    /// `applying(_:)` alone would keep it a pawn, since the board stores a
    /// still-hidden queen as a plain `P` (see `withPiece`'s doc comment).
    private static func checkSecretQueenOptimisticRevealPatch() {
        let board = ChessBoard(fen: ChessBoard.startFEN)
        let afterApply = board.applying("e2a6")
        assert(afterApply.piece(at: sq("a6")) == Piece(color: .white, kind: .pawn), "applying(_:) alone doesn't know about hidden queens")
        let revealed = afterApply.withPiece(Piece(color: .white, kind: .queen), at: sq("a6"))
        assert(revealed.piece(at: sq("a6")) == Piece(color: .white, kind: .queen))
        assert(revealed.piece(at: sq("e1")) == Piece(color: .white, kind: .king), "withPiece should only touch the one square it's given")
    }
}
#endif
