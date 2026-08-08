import Foundation

struct RatingSnapshot: Decodable, Sendable {
    @DefaultZero var rating: Int
    @DefaultZeroDouble var rd: Double
    @DefaultZero var games: Int
    @DefaultFalse var provisional: Bool
    let ratedAt: String?
}

/// Puzzle's rating block additionally carries `solved` (lifetime puzzles
/// solved), which the other pools don't have.
struct PuzzleSnapshot: Decodable, Sendable {
    @DefaultZero var rating: Int
    @DefaultZeroDouble var rd: Double
    @DefaultZero var games: Int
    @DefaultZero var solved: Int
    @DefaultFalse var provisional: Bool
}

struct RatingsBlock: Decodable, Sendable {
    let bullet: RatingSnapshot?
    let blitz: RatingSnapshot?
    let rapid: RatingSnapshot?
    let classical: RatingSnapshot?
}

struct Record: Decodable, Sendable {
    @DefaultZero var wins: Int
    @DefaultZero var losses: Int
    @DefaultZero var draws: Int
    @DefaultZero var total: Int
}

/// `Game` without `moves`/`sans` — the row shape used in game lists
/// (`Profile.games`, `GET /users/{name}/games`).
struct GameSummary: Decodable, Identifiable, Sendable {
    let id: String
    let hubGameId: String?
    let pool: String?
    let category: String?
    @DefaultFalse var rated: Bool
    let variant: String?
    let result: String?
    let reason: String?
    let whiteUid: String?
    let blackUid: String?
    let whiteName: String?
    let blackName: String?
    let whiteUserId: String?
    let blackUserId: String?
    @DefaultFalse var whiteIsBot: Bool
    @DefaultFalse var blackIsBot: Bool
    let whiteRatingBefore: Int?
    let whiteRatingAfter: Int?
    let blackRatingBefore: Int?
    let blackRatingAfter: Int?
    @DefaultZero var ply: Int
}

/// `GET /users/{name}` — public profile: per-pool ratings, record, and the
/// first page of games (full history via `ProfileService.userGames`).
struct Profile: Decodable, Identifiable, Sendable {
    let id: String
    let name: String
    @DefaultEmptyString var role: String
    let createdAt: String?
    let ratings: RatingsBlock?
    let puzzle: PuzzleSnapshot?
    let chess960: RatingSnapshot?
    let duck: RatingSnapshot?
    let antichess: RatingSnapshot?
    let record: Record?
    @DefaultEmptyArray var games: [GameSummary]
    @DefaultZero var gamesTotal: Int
    @DefaultZero var gamesPerPage: Int
}

struct LeaderboardEntry: Decodable, Identifiable, Sendable {
    @DefaultZero var rank: Int
    let id: String
    let name: String
    @DefaultZero var rating: Int
    @DefaultZero var games: Int
    @DefaultFalse var provisional: Bool
}

/// `GET /leaderboard?category=`. Crazyhouse has no leaderboard route on the
/// server even though it has a rating pool — don't pass `.crazyhouse` here.
struct Leaderboard: Decodable, Sendable {
    let category: String
    @DefaultEmptyArray var entries: [LeaderboardEntry]
}

struct Streak: Decodable, Sendable {
    @DefaultZero var current: Int
    @DefaultZero var longest: Int
    let lastActiveDate: String?
    @DefaultZero var freezeTokens: Int
    @DefaultFalse var activeToday: Bool
}

struct Stats: Decodable, Sendable {
    @DefaultZero var playersOnline: Int
    @DefaultZero var activeGames: Int
}
