import Foundation

/// `Core/Resilient.swift` ships `@Default*` wrappers for scalars and arrays
/// but not keyed dictionaries. `User.provisional` is the one field shaped
/// that way, so it gets a small local wrapper following the exact same
/// pattern as `DefaultEmptyArray` — missing/null key, or a key that fails to
/// decode as `[String: Bool]`, becomes `[:]` instead of failing the decode.
@propertyWrapper
struct DefaultEmptyDictionary<Value: Decodable>: Decodable {
    var wrappedValue: [String: Value]

    init() { wrappedValue = [:] }
    init(wrappedValue: [String: Value]) { self.wrappedValue = wrappedValue }

    init(from decoder: Decoder) throws {
        wrappedValue = (try? [String: Value](from: decoder)) ?? [:]
    }
}

extension KeyedDecodingContainer {
    func decode<Value>(
        _ type: DefaultEmptyDictionary<Value>.Type,
        forKey key: Key
    ) throws -> DefaultEmptyDictionary<Value> {
        ((try? decodeIfPresent(type, forKey: key)) ?? nil) ?? DefaultEmptyDictionary<Value>()
    }
}

/// The account object returned by `/auth/login`, `/auth/signup`, and `/me`
/// (password already stripped server-side). One rating block per pool;
/// `rating(for:)` reads the right one for a `RatingCategory` without a
/// switch at every call site.
struct User: Decodable, Identifiable, Sendable {
    let id: String
    let createdAt: String?
    let updatedAt: String?
    let name: String
    let email: String
    @DefaultTrue var active: Bool
    @DefaultEmptyString var role: String

    @DefaultZero var ratingBullet: Int
    @DefaultZeroDouble var rdBullet: Double
    @DefaultZeroDouble var volBullet: Double
    let ratedAtBullet: String?
    @DefaultZero var gamesBullet: Int

    @DefaultZero var ratingBlitz: Int
    @DefaultZeroDouble var rdBlitz: Double
    @DefaultZeroDouble var volBlitz: Double
    let ratedAtBlitz: String?
    @DefaultZero var gamesBlitz: Int

    @DefaultZero var ratingRapid: Int
    @DefaultZeroDouble var rdRapid: Double
    @DefaultZeroDouble var volRapid: Double
    let ratedAtRapid: String?
    @DefaultZero var gamesRapid: Int

    @DefaultZero var ratingClassical: Int
    @DefaultZeroDouble var rdClassical: Double
    @DefaultZeroDouble var volClassical: Double
    let ratedAtClassical: String?
    @DefaultZero var gamesClassical: Int

    @DefaultZero var ratingPuzzle: Int
    @DefaultZeroDouble var rdPuzzle: Double
    @DefaultZeroDouble var volPuzzle: Double
    let ratedAtPuzzle: String?
    @DefaultZero var gamesPuzzle: Int

    @DefaultZero var ratingChess960: Int
    @DefaultZeroDouble var rdChess960: Double
    @DefaultZeroDouble var volChess960: Double
    let ratedAtChess960: String?
    @DefaultZero var gamesChess960: Int

    @DefaultZero var ratingDuck: Int
    @DefaultZeroDouble var rdDuck: Double
    @DefaultZeroDouble var volDuck: Double
    let ratedAtDuck: String?
    @DefaultZero var gamesDuck: Int

    @DefaultZero var ratingCrazyhouse: Int
    @DefaultZeroDouble var rdCrazyhouse: Double
    @DefaultZeroDouble var volCrazyhouse: Double
    let ratedAtCrazyhouse: String?
    @DefaultZero var gamesCrazyhouse: Int

    @DefaultZero var ratingAntichess: Int
    @DefaultZeroDouble var rdAntichess: Double
    @DefaultZeroDouble var volAntichess: Double
    let ratedAtAntichess: String?
    @DefaultZero var gamesAntichess: Int

    @DefaultZero var ratingSecretqueen: Int
    @DefaultZeroDouble var rdSecretqueen: Double
    @DefaultZeroDouble var volSecretqueen: Double
    let ratedAtSecretqueen: String?
    @DefaultZero var gamesSecretqueen: Int

    @DefaultZero var currentStreak: Int
    @DefaultZero var longestStreak: Int
    let lastActiveDate: String?
    @DefaultZero var freezeTokens: Int
    @DefaultEmptyDictionary var provisional: [String: Bool]

    func rating(for category: RatingCategory) -> Int {
        switch category {
        case .bullet: return ratingBullet
        case .blitz: return ratingBlitz
        case .rapid: return ratingRapid
        case .classical: return ratingClassical
        case .puzzle: return ratingPuzzle
        case .chess960: return ratingChess960
        case .duck: return ratingDuck
        case .crazyhouse: return ratingCrazyhouse
        case .antichess: return ratingAntichess
        case .secretqueen: return ratingSecretqueen
        }
    }

    func games(for category: RatingCategory) -> Int {
        switch category {
        case .bullet: return gamesBullet
        case .blitz: return gamesBlitz
        case .rapid: return gamesRapid
        case .classical: return gamesClassical
        case .puzzle: return gamesPuzzle
        case .chess960: return gamesChess960
        case .duck: return gamesDuck
        case .crazyhouse: return gamesCrazyhouse
        case .antichess: return gamesAntichess
        case .secretqueen: return gamesSecretqueen
        }
    }

    func isProvisional(for category: RatingCategory) -> Bool {
        provisional[category.rawValue] ?? false
    }
}
