import Foundation

struct UserGamesResponse: Decodable, Sendable {
    @DefaultEmptyArray var games: [GameSummary]
    @DefaultZero var page: Int
    @DefaultZero var perPage: Int
    @DefaultZero var total: Int
}

struct ProfileService {
    static let shared = ProfileService()
    private init() {}

    func user(name: String) async throws -> Profile {
        try await APIClient.shared.get("/users/\(encodedPathComponent(name))")
    }

    /// `result` filters to "win"/"loss"/"draw"; `category` to a rating pool.
    func userGames(
        name: String,
        page: Int? = nil,
        category: String? = nil,
        result: String? = nil
    ) async throws -> UserGamesResponse {
        var query: [String] = []
        if let page { query.append("page=\(page)") }
        if let category, let encoded = category.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            query.append("category=\(encoded)")
        }
        if let result, let encoded = result.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            query.append("result=\(encoded)")
        }
        let suffix = query.isEmpty ? "" : "?" + query.joined(separator: "&")
        return try await APIClient.shared.get("/users/\(encodedPathComponent(name))/games\(suffix)")
    }

    /// `category` excludes `.crazyhouse` — no leaderboard route for it.
    /// `limit` clamps 1..50 server-side (default 10).
    func leaderboard(category: RatingCategory, limit: Int? = nil) async throws -> Leaderboard {
        var path = "/leaderboard?category=\(category.rawValue)"
        if let limit { path += "&limit=\(limit)" }
        return try await APIClient.shared.get(path)
    }

    func streak() async throws -> Streak {
        try await APIClient.shared.get("/streak")
    }

    private func encodedPathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}
