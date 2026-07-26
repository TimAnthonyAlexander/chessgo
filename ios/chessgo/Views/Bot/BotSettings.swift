import Foundation

/// Bot game setup, persisted locally so returning to the setup screen
/// remembers the last choice (frontend-features.md: "Settings persisted
/// local" — no server sync, this is a pure UserDefaults blob like the web's
/// localStorage equivalent).
struct BotSettings: Codable, Equatable, Sendable {
    var variant: Variant
    /// 0 = "Unlosable" (the bot plays its worst); otherwise clamped into
    /// `ratingRange` on a `ratingStep` grid.
    var rating: Int
    /// "w" / "b" / "random". The server only accepts "w"/"b" — a driver
    /// resolves "random" to a concrete color once, at game start.
    var humanColor: String

    static let ratingRange = 700...3500
    static let ratingStep = 50
    static let unlosable = 0

    static let `default` = BotSettings(variant: .standard, rating: 1500, humanColor: "random")

    private static let validColors: Set<String> = ["w", "b", "random"]

    /// Clamp whatever came off disk into something the setup UI can render
    /// without special-casing garbage (a stale rating from a step-size
    /// change, a since-removed variant slipping through as `.standard` via
    /// decode failure upstream, an unrecognized color string).
    func sanitized() -> BotSettings {
        var result = self
        if result.rating != Self.unlosable {
            let clamped = min(Self.ratingRange.upperBound, max(Self.ratingRange.lowerBound, result.rating))
            result.rating = clamped - (clamped % Self.ratingStep)
        }
        if !Self.validColors.contains(result.humanColor) {
            result.humanColor = "random"
        }
        return result
    }

    var isUnlosable: Bool { rating == Self.unlosable }

    /// fading/glassjaw derive their own decaying strength server-side and
    /// ignore the client's rating entirely — the setup screen hides the
    /// slider for these and shows the fixed display value below instead.
    var forcesMaxStrength: Bool {
        variant == .fading || variant == .glassjaw
    }

    /// What actually gets sent to `POST /bot-games`.
    var resolvedRating: Int {
        forcesMaxStrength ? Self.ratingRange.upperBound : rating
    }
}

/// UserDefaults persistence for `BotSettings`. One key, one blob — no
/// migrations to worry about since `sanitized()` absorbs drift.
enum BotSettingsStore {
    private static let key = "botgame:settings"

    static func load() -> BotSettings {
        guard let data = UserDefaults.standard.data(forKey: key),
              let decoded = try? JSONDecoder().decode(BotSettings.self, from: data)
        else { return .default }
        return decoded.sanitized()
    }

    static func save(_ settings: BotSettings) {
        guard let data = try? JSONEncoder().encode(settings) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}
