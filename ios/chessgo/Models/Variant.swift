import Foundation

/// The nine playable game variants (rest-api.md `variant` field on bot
/// games / live games). Server-provided variant strings on model responses
/// stay plain `String` (schema drift shouldn't fail a whole decode); this
/// enum is for client-authored requests and UI pickers.
enum Variant: String, Codable, CaseIterable, Sendable {
    case standard
    case chess960
    case duck
    case crazyhouse
    case antichess
    case secretqueen
    case fading
    case glassjaw
    case doublemove

    /// Whether check exists as a concept here — i.e. whether the board should
    /// glow the attacked king. Antichess and Duck both let the king be captured
    /// outright, so an attacked king there is normal play, not a warning.
    /// Secret Queen is the same shape (win by capturing the king, no check, no
    /// checkmate — docs/tasks/open/secret-queen.md rule 5) so it joins them.
    /// Takes the raw server string, which is what game models carry.
    static func hasCheck(_ raw: String?) -> Bool {
        raw != Variant.antichess.rawValue && raw != Variant.duck.rawValue && raw != Variant.secretqueen.rawValue
    }

    var displayName: String {
        switch self {
        case .standard: return "Standard"
        case .chess960: return "Chess960"
        case .duck: return "Duck"
        case .crazyhouse: return "Crazyhouse"
        case .antichess: return "Antichess"
        case .secretqueen: return "Secret Queen"
        case .fading: return "Fading"
        case .glassjaw: return "Glassjaw"
        case .doublemove: return "Double Move"
        }
    }
}

/// The nine rating pools a user has a Glicko-2 block for (User model,
/// leaderboard categories). Crazyhouse has no leaderboard endpoint but still
/// carries a rating block on the user.
enum RatingCategory: String, Codable, CaseIterable, Sendable {
    case bullet
    case blitz
    case rapid
    case classical
    case puzzle
    case duck
    case crazyhouse
    case antichess
    case secretqueen
}
