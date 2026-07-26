import Foundation

/// `GET /watch` — the spectate lobby list. No auth required (same as bot
/// games/puzzles); guests can browse live games.
struct WatchService {
    static let shared = WatchService()
    private init() {}

    func liveGames() async throws -> WatchResponse {
        try await APIClient.shared.get("/watch")
    }
}
