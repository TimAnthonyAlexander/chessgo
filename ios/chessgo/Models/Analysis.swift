import Foundation

/// `POST /analyze` — full-strength single-line eval of a position.
struct AnalyzeResult: Decodable, Sendable {
    let eval: EvalScore?
    let bestmove: String?
    @DefaultEmptyArray var pv: [String]
    let depth: Int?
}

struct Opening: Codable, Sendable {
    let eco: String
    let name: String
}

struct CandidateMove: Decodable, Sendable {
    let uci: String
    let san: String
    let eval: EvalScore?
    @DefaultEmptyArray var pv: [String]
    let depth: Int?
}

/// `POST /candidates` — multi-PV move list, best-first, with opening name
/// when the position is still in book.
struct Candidates: Decodable, Sendable {
    let opening: Opening?
    @DefaultEmptyArray var moves: [CandidateMove]
}

/// `POST /sf-analyze` — external Stockfish second opinion, single best move.
struct SfAnalyzeResult: Codable, Sendable {
    let bestmove: String?
    let san: String?
    let eval: EvalScore?
}

/// Game analysis reports eval **white-relative** (`white`), unlike the
/// side-to-move-relative `EvalScore` used everywhere else.
struct EvalWhiteScore: Decodable, Sendable {
    let type: String
    @DefaultZero var white: Int
}

struct AnalysisMoveJudgment: Decodable, Sendable {
    let uci: String
    let san: String
    let color: String
    @DefaultZeroDouble var cpLoss: Double
    @DefaultFalse var isBest: Bool
    @DefaultEmptyString var judgment: String
}

struct AnalysisPly: Decodable, Sendable {
    @DefaultZero var ply: Int
    let fen: String?
    let duck: String?
    let sideToMove: String?
    let evalWhite: EvalWhiteScore?
    let bestUci: String?
    let bestSan: String?
    @DefaultEmptyArray var bestPv: [String]
    let bestDepth: Int?
    let move: AnalysisMoveJudgment?
}

struct PlySummary: Decodable, Sendable {
    @DefaultZero var best: Int
    @DefaultZero var good: Int
    @DefaultZero var inaccuracy: Int
    @DefaultZero var mistake: Int
    @DefaultZero var blunder: Int
    @DefaultZeroDouble var acpl: Double
    @DefaultZeroDouble var accuracy: Double
}

struct AnalysisSummary: Decodable, Sendable {
    let w: PlySummary?
    let b: PlySummary?
}

/// `GET /games/{id}/analysis` — cached post-mortem. Chess960 and Crazyhouse
/// return `{unsupported:true}` instead of this shape, so every field besides
/// `unsupported` is optional/@Default; check `unsupported` first.
struct GameAnalysis: Decodable, Sendable {
    @DefaultFalse var unsupported: Bool
    let version: Int?
    let variant: String?
    let hubGameId: String?
    let result: String?
    let reason: String?
    let pool: String?
    @DefaultFalse var rated: Bool
    let whiteName: String?
    let blackName: String?
    @DefaultFalse var whiteIsBot: Bool
    @DefaultFalse var blackIsBot: Bool
    let startFen: String?
    @DefaultEmptyArray var plies: [AnalysisPly]
    let summary: AnalysisSummary?
}
