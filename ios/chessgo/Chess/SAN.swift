import Foundation
import SwiftUI

/// Best-effort client-side UCI → SAN move formatter, driven by the board
/// BEFORE the move is played. The engine is the rules authority server-side
/// and normally sends real SAN with every move; this exists only because a
/// locally-played analysis move (`AnalysisDriver.submit`) has nothing to show
/// but its own UCI string otherwise.
///
/// Built on `Attacks` (`Chess/Attacks.swift`), NOT on `premoveTargets`.
/// `premoveTargets` is the permissive PREMOVE generator: its rays pass through
/// the first blocker and its pawns "target" the squares they push to. Used as
/// an attack map it reports check almost everywhere — an x-rayed rook or a pawn
/// sitting one square below the king both count as attackers — which is exactly
/// the bug this file used to have: every suggested move came out with a "+".
///
/// With real attack geometry, "+" is exact and "#" is exact apart from
/// castling, which `Attacks.hasLegalMove` omits from the escape search (a king
/// may never castle out of check, so it can never be the move that refutes a
/// mate). Disambiguation is exact apart from pins: a same-kind piece that could
/// reach the destination but is pinned still forces a disambiguator a strict
/// generator wouldn't need. Acceptable for display text.
enum SAN {
    /// Format a UCI move as SAN, using the position it is played FROM.
    /// Falls back to the raw UCI string if it doesn't parse or the origin
    /// square is empty (should not happen for moves drawn from
    /// `AnalysisDriver.legalMoves`, but this never crashes on bad input).
    static func format(uci: String, board: ChessBoard) -> String {
        guard let move = Move(uci: uci), let mover = board.piece(at: move.from) else {
            return uci
        }
        return body(move: move, mover: mover, board: board) + checkSuffix(afterApplying: uci, board: board)
    }

    // MARK: - Body (everything but the +/# suffix)

    private static func body(move: Move, mover: Piece, board: ChessBoard) -> String {
        if mover.kind == .king, abs(move.to.file - move.from.file) == 2 {
            return move.to.file > move.from.file ? "O-O" : "O-O-O"
        }

        let destOccupant = board.piece(at: move.to)
        let isPawn = mover.kind == .pawn
        let isEnPassant = isPawn && move.from.file != move.to.file && destOccupant == nil
        let isCapture = destOccupant != nil || isEnPassant

        var out = ""
        if isPawn {
            if isCapture { out += fileLetter(move.from.file) }
        } else {
            out += String(mover.kind.fenLetter)
            out += disambiguator(move: move, mover: mover, board: board)
        }
        if isCapture { out += "x" }
        out += move.to.algebraic
        if let promotion = move.promotion {
            out += "=\(promotion.fenLetter)"
        }
        return out
    }

    /// Minimal disambiguator: empty if no other piece of the same kind/color
    /// could also reach the destination (pseudo-legally); otherwise
    /// origin file if that alone distinguishes it from every such piece,
    /// else origin rank, else the full origin square.
    private static func disambiguator(move: Move, mover: Piece, board: ChessBoard) -> String {
        let others = Square.all.filter { square in
            square != move.from
                && board.piece(at: square) == mover
                && Attacks.pseudoLegalTargets(from: square, board: board).contains(move.to)
        }
        guard !others.isEmpty else { return "" }

        let anyShareFile = others.contains { $0.file == move.from.file }
        if !anyShareFile { return fileLetter(move.from.file) }
        let anyShareRank = others.contains { $0.rank == move.from.rank }
        if !anyShareRank { return String(move.from.rank + 1) }
        return move.from.algebraic
    }

    private static func fileLetter(_ file: Int) -> String {
        String(Character(UnicodeScalar(UInt8(file) + Character("a").asciiValue!)))
    }

    // MARK: - Check / mate suffix (best-effort — see file header)

    private static func checkSuffix(afterApplying uci: String, board: ChessBoard) -> String {
        let after = board.applying(uci)
        // `applying` flips the side to move, so `after.sideToMove` is the side
        // that just got moved against — the one whose king may now be attacked.
        guard Attacks.isInCheck(after.sideToMove, board: after) else { return "" }
        return Attacks.hasLegalMove(after.sideToMove, board: after) ? "+" : "#"
    }
}

#if DEBUG
/// Self-contained sanity checks, same idiom as `ChessSelfCheck`
/// (`Chess/ChessBoardTests.swift`) — there is no XCTest target in this app.
enum SANSelfCheck {
    static func run() {
        checkQuietPawnMove()
        checkKnightMove()
        checkPawnCapture()
        checkCastling()
        checkPromotion()
        checkDisambiguationByFile()
        checkPlainCheck()
        checkBlockedRayIsNotCheck()
        checkPawnPushIsNotCheck()
        checkMate()
    }

    private static func checkQuietPawnMove() {
        let board = ChessBoard(fen: ChessBoard.startFEN)
        assert(SAN.format(uci: "e2e4", board: board) == "e4")
    }

    private static func checkKnightMove() {
        let board = ChessBoard(fen: ChessBoard.startFEN)
        assert(SAN.format(uci: "g1f3", board: board) == "Nf3")
    }

    private static func checkPawnCapture() {
        // After 1.e4 d5, white to capture on d5.
        let board = ChessBoard(fen: "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2")
        assert(SAN.format(uci: "e4d5", board: board) == "exd5")
    }

    private static func checkCastling() {
        let board = ChessBoard(fen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
        assert(SAN.format(uci: "e1g1", board: board) == "O-O")
        assert(SAN.format(uci: "e1c1", board: board) == "O-O-O")
    }

    private static func checkPromotion() {
        let board = ChessBoard(fen: "8/4P3/8/8/8/8/8/K6k w - - 0 1")
        assert(SAN.format(uci: "e7e8q", board: board) == "e8=Q")
    }

    private static func checkDisambiguationByFile() {
        // Two white knights, both able to reach d7; distinct files disambiguate.
        let board = ChessBoard(fen: "1N3N2/8/8/8/8/8/8/K6k w - - 0 1")
        assert(SAN.format(uci: "b8d7", board: board) == "Nbd7")
        assert(SAN.format(uci: "f8d7", board: board) == "Nfd7")
    }

    private static func checkPlainCheck() {
        // Queen steps up the e-file to deliver check; king can capture it
        // (undefended), so this is check, not mate.
        let board = ChessBoard(fen: "4k3/8/8/8/8/8/4Q3/K7 w - - 0 1")
        assert(SAN.format(uci: "e2e7", board: board) == "Qe7+")
    }

    /// Regression: a rook whose line to the enemy king is BLOCKED gives no
    /// check. The premove generator used to say otherwise (its rays see through
    /// the first blocker), which put a "+" on essentially every move.
    private static func checkBlockedRayIsNotCheck() {
        let board = ChessBoard(fen: "4k3/8/8/4p3/8/8/8/4R2K w - - 0 1")
        assert(SAN.format(uci: "h1g1", board: board) == "Kg1")
    }

    /// Regression: a pawn attacks diagonally, never the square it pushes to —
    /// a pawn directly below the enemy king is not giving check.
    private static func checkPawnPushIsNotCheck() {
        let board = ChessBoard(fen: "4k3/4P3/8/8/8/8/8/K7 w - - 0 1")
        assert(SAN.format(uci: "a1a2", board: board) == "Ka2")
    }

    /// The other side of it: a real back-rank mate must still read "#".
    private static func checkMate() {
        let board = ChessBoard(fen: "6k1/5ppp/8/8/8/8/8/R3K3 w Q - 0 1")
        assert(SAN.format(uci: "a1a8", board: board) == "Ra8#")
    }
}
#endif

#Preview("SAN.format examples") {
    let cases: [(label: String, fen: String, uci: String)] = [
        ("quiet pawn push", ChessBoard.startFEN, "e2e4"),
        ("knight development", ChessBoard.startFEN, "g1f3"),
        ("pawn capture", "rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2", "e4d5"),
        ("kingside castle", "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "e1g1"),
        ("promotion", "8/4P3/8/8/8/8/8/K6k w - - 0 1", "e7e8q"),
        ("disambiguation", "1N3N2/8/8/8/8/8/8/K6k w - - 0 1", "b8d7"),
        ("check", "4k3/8/8/8/8/8/4Q3/K7 w - - 0 1", "e2e7"),
    ]
    return List(cases, id: \.label) { item in
        HStack {
            Text(item.label)
                .foregroundStyle(.secondary)
            Spacer()
            Text("\(item.uci) → \(SAN.format(uci: item.uci, board: ChessBoard(fen: item.fen)))")
                .font(.system(.body, design: .monospaced))
        }
    }
}
