import Foundation

private struct AnalyzeRequest: Encodable {
    let fen: String
    let movetime: Int?
    let depth: Int?
    let multipv: Int?
    /// Prior-position FENs, root→previous — NOT UCI moves. The server re-walks
    /// them through its own Zobrist to resolve the DEEPEST named opening along
    /// the line; anything that isn't a parseable FEN is silently skipped.
    let history: [String]?
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

private struct DuckAnalyzeRequest: Encodable {
    let fen: String
    let duck: String
    let movetime: Int?
}

private struct AntichessAnalyzeRequest: Encodable {
    let fen: String
    let movetime: Int?
}

struct AnalysisService {
    static let shared = AnalysisService()
    private init() {}

    /// Default movetime 1500ms server-side; depth clamped 1..40; `multipv`
    /// clamped to 12. With `multipv > 1` the result carries `lines` — the top N
    /// moves from ONE search, all at the same depth — so the opening explorer
    /// and the eval bar are fed by a single request instead of two.
    func analyze(
        fen: String,
        movetime: Int? = nil,
        depth: Int? = nil,
        multipv: Int? = nil,
        history: [String]? = nil
    ) async throws -> AnalyzeResult {
        try await APIClient.shared.post(
            "/analyze",
            body: AnalyzeRequest(fen: fen, movetime: movetime, depth: depth, multipv: multipv, history: history)
        )
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

    /// The standard engine has no Duck rules and mis-scores/mis-picks moves
    /// on a Duck position, so this hits the dedicated Duck engine instead
    /// (`frontend/src/api/client.ts` `duckEval`). `bestmove` is a composite
    /// `"<pieceUci>:<duckSquare>"`.
    func duckAnalyze(fen: String, duck: String, movetime: Int? = nil) async throws -> DuckAnalyzeResult {
        try await APIClient.shared.post("/duck/analyze", body: DuckAnalyzeRequest(fen: fen, duck: duck, movetime: movetime))
    }

    /// Antichess has compulsory captures and inverted material, so the
    /// standard engine's "best move" is frequently illegal here — this hits
    /// the dedicated Antichess engine instead (`frontend/src/api/client.ts`
    /// `antichessEval`). `bestmove` is a plain UCI (with a `k` suffix for a
    /// king promotion).
    func antichessAnalyze(fen: String, movetime: Int? = nil) async throws -> AntichessAnalyzeResult {
        try await APIClient.shared.post("/antichess/analyze", body: AntichessAnalyzeRequest(fen: fen, movetime: movetime))
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
