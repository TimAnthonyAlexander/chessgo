import Foundation

private struct AnalyzeRequest: Encodable {
    let fen: String
    let movetime: Int?
    let depth: Int?
}

private struct CandidatesRequest: Encodable {
    let fen: String
    let history: [String]?
    let multipv: Int?
    let movetime: Int?
    let depth: Int?
}

private struct SfAnalyzeRequest: Encodable {
    let fen: String
    let movetime: Int?
}

struct AnalysisService {
    static let shared = AnalysisService()
    private init() {}

    /// Default movetime 1500ms server-side; depth clamped 1..40.
    func analyze(fen: String, movetime: Int? = nil, depth: Int? = nil) async throws -> AnalyzeResult {
        try await APIClient.shared.post("/analyze", body: AnalyzeRequest(fen: fen, movetime: movetime, depth: depth))
    }

    /// `multipv` clamps to 12, `movetime` to 50..2000 (default 300), `depth` to 30.
    func candidates(
        fen: String,
        history: [String]? = nil,
        multipv: Int? = nil,
        movetime: Int? = nil,
        depth: Int? = nil
    ) async throws -> Candidates {
        try await APIClient.shared.post(
            "/candidates",
            body: CandidatesRequest(fen: fen, history: history, multipv: multipv, movetime: movetime, depth: depth)
        )
    }

    /// Full-strength Stockfish second opinion, default movetime 300ms.
    func sfAnalyze(fen: String, movetime: Int? = nil) async throws -> SfAnalyzeResult {
        try await APIClient.shared.post("/sf-analyze", body: SfAnalyzeRequest(fen: fen, movetime: movetime))
    }

    /// `id` is the hub game id (hex string) — same identifier `game(id:)`
    /// takes below. Chess960/Crazyhouse decode with `unsupported == true`.
    func gameAnalysis(id: String) async throws -> GameAnalysis {
        try await APIClient.shared.get("/games/\(id)/analysis")
    }

    /// `GET /games/{id}` — the finished game record backing the analysis
    /// view (moves/sans, players, result). Not in the original service list
    /// but the `Game` model has no other caller and Wave 2/3 need it.
    func game(id: String) async throws -> Game {
        try await APIClient.shared.get("/games/\(id)")
    }
}
