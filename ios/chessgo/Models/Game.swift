import Foundation

/// `GET /games/{id}` — a finished, persisted game record. The path `{id}` is
/// the hub game id (hex string); the object's own `id` is the BaseAPI row's
/// numeric primary key, distinct from `hubGameId`.
struct Game: Decodable, Identifiable, Sendable {
    let id: String
    let hubGameId: String
    let pool: String
    let category: String
    @DefaultFalse var rated: Bool
    let variant: String
    let result: String?
    let reason: String?
    let whiteUid: String
    let blackUid: String
    let whiteName: String
    let blackName: String
    let whiteUserId: String?
    let blackUserId: String?
    @DefaultFalse var whiteIsBot: Bool
    @DefaultFalse var blackIsBot: Bool
    let whiteRatingBefore: Int?
    let whiteRatingAfter: Int?
    let blackRatingBefore: Int?
    let blackRatingAfter: Int?
    @DefaultZero var ply: Int
    @DefaultEmptyArray var moves: [String]
    @DefaultEmptyArray var sans: [String]
}
