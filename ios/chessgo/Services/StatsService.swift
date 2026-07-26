import Foundation

struct StatsService {
    static let shared = StatsService()
    private init() {}

    func stats() async throws -> Stats {
        try await APIClient.shared.get("/stats")
    }
}
