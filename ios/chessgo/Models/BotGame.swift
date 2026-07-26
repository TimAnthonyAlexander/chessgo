import Foundation

/// A `cp` or `mate` engine score, side-to-move relative unless noted
/// otherwise at the call site (see `EvalWhiteScore` in Analysis.swift for the
/// white-relative variant used by game analysis).
struct EvalScore: Codable, Sendable, Equatable {
    let type: String
    let value: Int
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
}
