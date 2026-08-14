import Foundation

/// A `cp` or `mate` engine score, side-to-move relative unless noted
/// otherwise at the call site (see `EvalWhiteScore` in Analysis.swift for the
/// white-relative variant used by game analysis).
struct EvalScore: Codable, Sendable, Equatable {
    let type: String
    let value: Int
    /// Optional Syzygy verdict ("win"/"loss"). When present, `value` is a
    /// stand-in (±1000) and not a measurement — render the verdict, not the
    /// number. See `Models/EngineEval.swift`.
    let tb: String?

    /// Explicit so `tb` can default: every existing `EvalScore(type:value:)`
    /// call site keeps compiling, and Codable synthesis is unaffected (an
    /// optional decodes via decodeIfPresent, so an engine that never sends
    /// `tb` still decodes).
    init(type: String, value: Int, tb: String? = nil) {
        self.type = type
        self.value = value
        self.tb = tb
    }
}

/// Secret Queen: what one move unmasked, if anything. Present on EVERY move
/// of a secretqueen game (`BotGameService::applySecretQueen` always writes the
/// engine's `reveal` object) — all three flags false and `square` null is the
/// ordinary case, not a missing one. `moved` is a BOOLEAN ("this move itself,
/// by being non-pawn-shaped, revealed it"), not a color — the web's first pass
/// mistyped it as one and attributed every reveal to Black; see
/// `zugzwang/src/secretqueen.cpp` (`reveal.moved = true`) and
/// `serve_handlers.cpp`'s `reveal_json` for the real wire shape.
struct RevealInfo: Codable, Sendable {
    /// Revealed by playing a non-pawn-shaped move from the secret square.
    let moved: Bool
    /// Revealed because it was captured while still hidden (rule 7).
    let captured: Bool
    /// Revealed by reaching the last rank (rule 8) — a pawn there must
    /// promote, and this one already is a queen.
    let promoted: Bool
    /// Where the reveal happened: the capturing move's destination for a
    /// capture, otherwise the moving piece's own square. `nil` when none of
    /// the three flags above are set.
    let square: String?

    /// Whether this reveal object actually unmasked anything. A bare
    /// `moves.first(where: { $0.reveal != nil })` matches the FIRST move of
    /// every game (reveal is always present, just all-false) and then reads a
    /// null `square` — exactly the crash secret-queen.md's "Two bugs" section
    /// records the web hitting first. Check this instead.
    var didReveal: Bool { moved || captured || promoted }
}

/// One ply of a bot game, as returned inline in `BotGame.moves`.
struct GameMove: Codable, Sendable {
    let ply: Int
    let uci: String
    let san: String
    let by: String
    let fen: String
    let eval: EvalScore?
    let duck: String?
    /// Secret Queen only; absent (`nil`) on every other variant's moves.
    let reveal: RevealInfo?

    init(ply: Int, uci: String, san: String, by: String, fen: String, eval: EvalScore?, duck: String?, reveal: RevealInfo? = nil) {
        self.ply = ply
        self.uci = uci
        self.san = san
        self.by = by
        self.fen = fen
        self.eval = eval
        self.duck = duck
        self.reveal = reveal
    }
}

/// `POST /bot-games`, `GET /bot-games/{id}`, and the move/undo responses all
/// share this shape (`BotGameService::present`).
struct BotGame: Decodable, Identifiable, Sendable {
    let id: String
    @DefaultZero var rating: Int
    let humanColor: String
    let variant: String
    let duck: String?
    let fen: String
    let sideToMove: String
    let status: String
    let result: String?
    @DefaultEmptyArray var moves: [GameMove]
    @DefaultEmptyArray var legalMoves: [String]
    @DefaultFalse var yourTurn: Bool
    /// Secret Queen: the human's OWN secret-queen square, or `nil` once it's
    /// been revealed, captured, or promoted. The bot's secret never reaches
    /// the client — `BotGameService::present()` redacts it out of both this
    /// field and the trailing FEN suffix before the response leaves the
    /// server. Absent (`nil`, via `decodeIfPresent`) on every other variant.
    let secretSquare: String?
}
