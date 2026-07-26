import Foundation

enum PieceColor: Sendable, Equatable, Hashable {
    case white
    case black

    var opposite: PieceColor { self == .white ? .black : .white }
}

enum PieceKind: Sendable, Equatable, Hashable, CaseIterable {
    case pawn
    case knight
    case bishop
    case rook
    case queen
    case king

    /// The uppercase FEN letter for this kind (color is expressed via case).
    var fenLetter: Character {
        switch self {
        case .pawn: return "P"
        case .knight: return "N"
        case .bishop: return "B"
        case .rook: return "R"
        case .queen: return "Q"
        case .king: return "K"
        }
    }

    init?(fenLetter: Character) {
        switch fenLetter.uppercased() {
        case "P": self = .pawn
        case "N": self = .knight
        case "B": self = .bishop
        case "R": self = .rook
        case "Q": self = .queen
        case "K": self = .king
        default: return nil
        }
    }
}

/// A piece on a square. Rendering-only value type — no move-generation smarts.
struct Piece: Sendable, Equatable {
    let color: PieceColor
    let kind: PieceKind

    /// FEN character: white pieces uppercase, black lowercase.
    var fenChar: Character {
        let letter = kind.fenLetter
        return color == .white ? letter : Character(letter.lowercased())
    }

    init(color: PieceColor, kind: PieceKind) {
        self.color = color
        self.kind = kind
    }

    /// Parse a single FEN board character ("P", "n", "Q", ...).
    init?(fenChar: Character) {
        guard let kind = PieceKind(fenLetter: fenChar) else { return nil }
        self.color = fenChar.isUppercase ? .white : .black
        self.kind = kind
    }
}
