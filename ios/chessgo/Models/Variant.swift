import Foundation

/// The eight playable game variants (rest-api.md `variant` field on bot
/// games / live games). Server-provided variant strings on model responses
/// stay plain `String` (schema drift shouldn't fail a whole decode); this
/// enum is for client-authored requests and UI pickers.
enum Variant: String, Codable, CaseIterable, Sendable {
    case standard
    case chess960
    case duck
    case crazyhouse
    case antichess
    case fading
    case glassjaw
    case doublemove

    var displayName: String {
        switch self {
        case .standard: return "Standard"
        case .chess960: return "Chess960"
        case .duck: return "Duck"
        case .crazyhouse: return "Crazyhouse"
        case .antichess: return "Antichess"
        case .fading: return "Fading"
        case .glassjaw: return "Glassjaw"
        case .doublemove: return "Double Move"
        }
    }
}

/// The eight rating pools a user has a Glicko-2 block for (User model,
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
}
