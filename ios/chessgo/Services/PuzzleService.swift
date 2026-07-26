import Foundation

private struct PuzzleMoveRequest: Encodable {
    let move: String
    let fen: String
    let ply: Int
}

struct PuzzleService {
    static let shared = PuzzleService()
    private init() {}

    /// `theme` is an optional filter tag; omit for any theme.
    func next(theme: String? = nil) async throws -> PuzzleNext {
        var path = "/puzzles/next"
        if let theme, let encoded = theme.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            path += "?theme=\(encoded)"
        }
        return try await APIClient.shared.get(path)
    }

    /// Deterministic per UTC day; same puzzle for everyone.
    func daily() async throws -> PuzzleNext {
        try await APIClient.shared.get("/puzzles/daily")
    }

    /// `fen` and `ply` describe the position the move is played from —
    /// required so the server can validate against takeback/replay drift.
    func move(id: String, move: String, fen: String, ply: Int) async throws -> PuzzleMoveResult {
        try await APIClient.shared.post(
            "/puzzles/\(id)/move",
            body: PuzzleMoveRequest(move: move, fen: fen, ply: ply)
        )
    }
}
