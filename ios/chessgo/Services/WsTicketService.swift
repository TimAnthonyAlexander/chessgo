import Foundation

/// `anonId` is a stable per-install id (Keychain), sent even for logged-in
/// clients so the hub has a reconnect key if the bearer token isn't honored
/// (see rest-api.md's `/ws-ticket` known gap).
struct WsTicketService {
    static let shared = WsTicketService()
    private init() {}

    func fetch(anonId: String) async throws -> WsTicketResponse {
        let encoded = anonId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? anonId
        return try await APIClient.shared.get("/ws-ticket?anon=\(encoded)")
    }
}
