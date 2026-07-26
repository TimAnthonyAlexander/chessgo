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
}
#endif
