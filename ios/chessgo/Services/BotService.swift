import Foundation

private struct CreateBotGameRequest: Encodable {
    let rating: Int?
    let humanColor: String?
    let fen: String?
    let variant: Variant?
}

private struct BotMoveRequest: Encodable {
    let move: String
}

/// No auth required — guest-playable. `rating` is the bot's target strength
/// (0..3500; 0 = "Unlosable", bot plays its worst), not a 0..10 level.
struct BotService {
    static let shared = BotService()
    private init() {}

    func create(
        rating: Int? = nil,
        humanColor: String? = nil,
        variant: Variant? = nil,
        fen: String? = nil
    ) async throws -> BotGame {
        try await APIClient.shared.post(
            "/bot-games",
            body: CreateBotGameRequest(rating: rating, humanColor: humanColor, fen: fen, variant: variant)
        )
    }

    func get(id: String) async throws -> BotGame {
        try await APIClient.shared.get("/bot-games/\(id)")
    }

    /// UCI, e.g. "e2e4"; promotion "e7e8q"; Duck composite "e7e8q:h6".
    /// Applies the human move and the bot's reply synchronously.
    func move(id: String, move: String) async throws -> BotGame {
        try await APIClient.shared.post("/bot-games/\(id)/move", body: BotMoveRequest(move: move))
    }

    /// Pops the bot's reply and the human move together. 422 if there's
    /// nothing to undo, or in Duck/doublemove variants.
    func undo(id: String) async throws -> BotGame {
        try await APIClient.shared.post("/bot-games/\(id)/undo")
    }
}
