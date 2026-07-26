import Foundation

/// A board square as a file/rank pair (both 0-7, a-file/1-rank = 0). Pure value
/// type used for rendering and premove geometry only — it carries no notion of
/// legality.
struct Square: Hashable, Sendable {
    let file: Int
    let rank: Int

    init?(file: Int, rank: Int) {
        guard (0...7).contains(file), (0...7).contains(rank) else { return nil }
        self.file = file
        self.rank = rank
    }

    /// 0-63 index, a1 = 0, h1 = 7, a8 = 56, h8 = 63 (rank-major, matches FEN's
    /// rank order once the board array is filled top row first — see ChessBoard).
    init?(index: Int) {
        guard (0..<64).contains(index) else { return nil }
        self.file = index % 8
        self.rank = index / 8
    }

    var index: Int { rank * 8 + file }

    /// Parse algebraic notation ("e4"). Case-insensitive on the file letter.
    init?(algebraic: String) {
        let chars = Array(algebraic.lowercased())
        guard chars.count == 2,
              let fileChar = chars.first, ("a"..."h").contains(String(fileChar)),
              let rankDigit = chars.last?.wholeNumberValue,
              (1...8).contains(rankDigit)
        else { return nil }
        self.file = Int(fileChar.asciiValue! - Character("a").asciiValue!)
        self.rank = rankDigit - 1
    }

    var algebraic: String {
        let fileChar = Character(UnicodeScalar(UInt8(file) + Character("a").asciiValue!))
        return "\(fileChar)\(rank + 1)"
    }

    /// All 64 squares, a1 first, h8 last.
    static var all: [Square] {
        (0..<64).compactMap { Square(index: $0) }
    }
}

extension Square: CustomStringConvertible {
    var description: String { algebraic }
}
