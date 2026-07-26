import Foundation

/// One theme filter for `GET /puzzles/next?theme=`. Mirrors the web's
/// `THEMES` list (`Puzzles.tsx`) exactly — 13 entries including "all".
enum PuzzleTheme: String, CaseIterable, Identifiable, Sendable {
    case all = ""
    case mateIn1
    case mateIn2
    case mateIn3
    case fork
    case pin
    case skewer
    case discoveredAttack
    case sacrifice
    case endgame
    case rookEndgame
    case crushing
    case advantage

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All puzzles"
        case .mateIn1: return "Mate in 1"
        case .mateIn2: return "Mate in 2"
        case .mateIn3: return "Mate in 3"
        case .fork: return "Fork"
        case .pin: return "Pin"
        case .skewer: return "Skewer"
        case .discoveredAttack: return "Discovered attack"
        case .sacrifice: return "Sacrifice"
        case .endgame: return "Endgame"
        case .rookEndgame: return "Rook endgame"
        case .crushing: return "Crushing"
        case .advantage: return "Advantage"
        }
    }

    /// `nil` for `.all` — `PuzzleService.next(theme:)` omits the query param
    /// entirely, matching the server's "empty = any theme".
    var queryValue: String? { self == .all ? nil : rawValue }
}

/// Session-wide countdown preset (Puzzle-Rush style): solve as many as you
/// can before the clock runs out. `.untimed` is unlimited practice.
enum PuzzleTimeFormat: CaseIterable, Identifiable, Sendable {
    case sprint
    case blitz
    case marathon
    case untimed

    var id: String { tag }

    var seconds: Int? {
        switch self {
        case .sprint: return 60
        case .blitz: return 180
        case .marathon: return 300
        case .untimed: return nil
        }
    }

    var tag: String {
        switch self {
        case .sprint: return "Sprint"
        case .blitz: return "Blitz"
        case .marathon: return "Marathon"
        case .untimed: return "Untimed"
        }
    }

    /// "1:00" / "3:00" / "5:00" / "∞".
    var display: String {
        guard let seconds else { return "\u{221E}" }
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    /// Persisted as raw seconds; `UserDefaults` has no native `Int?` so
    /// untimed is stored as `-1`.
    fileprivate var storageValue: Int { seconds ?? -1 }

    fileprivate init(storageValue: Int) {
        self = PuzzleTimeFormat.allCases.first { $0.storageValue == storageValue } ?? .blitz
    }
}

/// Persisted puzzle session prefs — theme + time format survive relaunch,
/// device-local only (no server sync), mirroring the web's `localStorage`
/// persistence (`chessgo.puzzleTheme` / `chessgo.puzzleTime`). Malformed or
/// stale stored values fall back to sensible defaults rather than crashing.
@Observable
@MainActor
final class PuzzleSettings {
    private let themeKey = "chessgo.puzzleTheme"
    private let timeKey = "chessgo.puzzleTimeSeconds"

    var theme: PuzzleTheme {
        didSet { UserDefaults.standard.set(theme.rawValue, forKey: themeKey) }
    }

    var timeFormat: PuzzleTimeFormat {
        didSet { UserDefaults.standard.set(timeFormat.storageValue, forKey: timeKey) }
    }

    init() {
        let defaults = UserDefaults.standard
        theme = defaults.string(forKey: themeKey).flatMap(PuzzleTheme.init(rawValue:)) ?? .all
        if defaults.object(forKey: timeKey) == nil {
            timeFormat = .blitz // default: 3-minute Blitz, matches the web
        } else {
            timeFormat = PuzzleTimeFormat(storageValue: defaults.integer(forKey: timeKey))
        }
    }
}
