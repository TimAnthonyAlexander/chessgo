import Foundation

struct WsIdentity: Decodable, Sendable {
    @DefaultEmptyString var name: String
    @DefaultFalse var anon: Bool
    @DefaultZero var rating: Int
}

/// `GET /ws-ticket?anon=` — mint a fresh one on every socket connect
/// attempt (60s TTL). Always read `wsUrl` from here, never hardcode it.
struct WsTicketResponse: Decodable, Sendable {
    let ticket: String
    let wsUrl: String
    let identity: WsIdentity
}
