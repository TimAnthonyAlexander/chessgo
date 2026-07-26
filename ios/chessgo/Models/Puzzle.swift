import Foundation

/// `GET /puzzles/next` and `GET /puzzles/daily` (daily adds `themes`, which
/// defaults to `[]` here so the same model covers both).
struct PuzzleNext: Decodable, Identifiable, Sendable {
    let id: String
    @DefaultZero var rating: Int
    let startFen: String
    let opponentMove: String
    let fen: String
    let color: String
    @DefaultEmptyArray var legalMoves: [String]
    @DefaultZero var ply: Int
    @DefaultEmptyArray var themes: [String]

    /// Explicit initializer for tests/previews. The `@Default` wrappers use a
    /// generic associated wrapped-value type, so Swift's synthesized memberwise
    /// init would demand the wrapper type instead of the raw value — this gives
    /// call sites the plain types. Decodable init(from:) is still synthesized.
    init(
        id: String,
        rating: Int = 0,
        startFen: String,
        opponentMove: String,
        fen: String,
        color: String,
        legalMoves: [String] = [],
        ply: Int = 0,
        themes: [String] = []
    ) {
        self.id = id
        self.rating = rating
        self.startFen = startFen
        self.opponentMove = opponentMove
        self.fen = fen
        self.color = color
        self.legalMoves = legalMoves
        self.ply = ply
        self.themes = themes
    }
}

struct PuzzleRating: Codable, Sendable {
    var value: Int = 0
    var delta: Int = 0
    var games: Int = 0
}

/// `POST /puzzles/{id}/move` returns one of three shapes depending on
/// whether the move was wrong, correct-and-complete, or correct-and-continue.
/// Rather than three structs, one tolerant struct covers all three — every
/// field that isn't in every variant is optional or `@Default`-guarded.
struct PuzzleMoveResult: Decodable, Sendable {
    @DefaultFalse var correct: Bool
    @DefaultFalse var complete: Bool
    @DefaultFalse var solved: Bool
    @DefaultEmptyArray var solution: [String]
    let opponentMove: String?
    let fen: String?
    @DefaultEmptyArray var legalMoves: [String]
    let ply: Int?
    @DefaultEmptyArray var themes: [String]
    let rating: PuzzleRating?
    @DefaultFalse var alternative: Bool
    @DefaultEmptyString var status: String

    /// All-defaulted initializer so tests/previews can build any one of the
    /// three variants without spelling out every field. Decodable init(from:)
    /// is still synthesized from the wrappers and is unaffected.
    init(
        correct: Bool = false,
        complete: Bool = false,
        solved: Bool = false,
        solution: [String] = [],
        opponentMove: String? = nil,
        fen: String? = nil,
        legalMoves: [String] = [],
        ply: Int? = nil,
        themes: [String] = [],
        rating: PuzzleRating? = nil,
        alternative: Bool = false,
        status: String = ""
    ) {
        self.correct = correct
        self.complete = complete
        self.solved = solved
        self.solution = solution
        self.opponentMove = opponentMove
        self.fen = fen
        self.legalMoves = legalMoves
        self.ply = ply
        self.themes = themes
        self.rating = rating
        self.alternative = alternative
        self.status = status
    }
}
