import Foundation

/// A plain piece move in UCI form ("e2e4", "e7e8q"). Value type; no legality
/// implied — this is a wire-format parser/builder, not a move generator.
struct Move: Sendable, Equatable {
    let from: Square
    let to: Square
    let promotion: PieceKind?

    init(from: Square, to: Square, promotion: PieceKind? = nil) {
        self.from = from
        self.to = to
        self.promotion = promotion
    }

    /// Parse "e2e4" or "e7e8q". Rejects anything shorter than 4 chars or with an
    /// unrecognized promotion letter.
    init?(uci: String) {
        let chars = Array(uci)
        guard chars.count == 4 || chars.count == 5 else { return nil }
        guard let from = Square(algebraic: String(chars[0...1])),
              let to = Square(algebraic: String(chars[2...3]))
        else { return nil }
        var promo: PieceKind?
        if chars.count == 5 {
            guard let kind = PieceKind(fenLetter: chars[4]), kind != .pawn, kind != .king else { return nil }
            promo = kind
        }
        self.from = from
        self.to = to
        self.promotion = promo
    }

    /// Emit UCI: promotion letter is always lowercase (engine convention).
    var uci: String {
        let promoSuffix = promotion.map { String($0.fenLetter).lowercased() } ?? ""
        return from.algebraic + to.algebraic + promoSuffix
    }
}

/// A Crazyhouse drop: place a pocketed piece on an empty square. Wire format
/// "P@e4" (piece letter is always uppercase regardless of side to move; whose
/// pocket it comes from is implied by side to move).
struct Drop: Sendable, Equatable {
    let piece: PieceKind
    let target: Square

    init(piece: PieceKind, target: Square) {
        self.piece = piece
        self.target = target
    }

    init?(uci: String) {
        let parts = uci.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2,
              let letter = parts[0].first, parts[0].count == 1,
              let kind = PieceKind(fenLetter: letter),
              let square = Square(algebraic: String(parts[1]))
        else { return nil }
        self.piece = kind
        self.target = square
    }

    var uci: String { "\(piece.fenLetter)@\(target.algebraic)" }
}

/// A Duck Chess composite move: a normal piece move, then the duck placed on an
/// empty square, submitted together as one turn. Wire format "e2e4:d5".
struct DuckMove: Sendable, Equatable {
    let pieceMove: Move
    let duckTarget: Square

    init(pieceMove: Move, duckTarget: Square) {
        self.pieceMove = pieceMove
        self.duckTarget = duckTarget
    }

    init?(uci: String) {
        let parts = uci.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2,
              let move = Move(uci: String(parts[0])),
              let duck = Square(algebraic: String(parts[1]))
        else { return nil }
        self.pieceMove = move
        self.duckTarget = duck
    }

    var uci: String { "\(pieceMove.uci):\(duckTarget.algebraic)" }
}

/// Any of the three wire formats the engine accepts for a submitted turn.
/// Board/UI code parses a server-provided UCI string once into this and reads
/// off whichever case applies, or builds one to hand to `submit`.
enum WireMove: Sendable, Equatable {
    case standard(Move)
    case drop(Drop)
    case duck(DuckMove)

    init?(uci: String) {
        if uci.contains("@") {
            guard let drop = Drop(uci: uci) else { return nil }
            self = .drop(drop)
        } else if uci.contains(":") {
            guard let duck = DuckMove(uci: uci) else { return nil }
            self = .duck(duck)
        } else {
            guard let move = Move(uci: uci) else { return nil }
            self = .standard(move)
        }
    }

    var uci: String {
        switch self {
        case .standard(let move): return move.uci
        case .drop(let drop): return drop.uci
        case .duck(let duck): return duck.uci
        }
    }
}
