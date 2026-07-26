import Foundation

/// Time-control speed bucket, matching Lichess's grouping (used both to
/// group the QuickPairing preset grid and to classify a custom challenge
/// pool for display). `frontend-features.md` groups the 12 standard presets
/// as Bullet/Blitz/Rapid/Classical — same four buckets here.
enum TimeControlCategory: String, CaseIterable, Sendable {
    case bullet
    case blitz
    case rapid
    case classical

    var label: String {
        switch self {
        case .bullet: return "Bullet"
        case .blitz: return "Blitz"
        case .rapid: return "Rapid"
        case .classical: return "Classical"
        }
    }

    var systemImage: String {
        switch self {
        case .bullet: return "hare.fill"
        case .blitz: return "bolt.fill"
        case .rapid: return "timer"
        case .classical: return "tortoise.fill"
        }
    }

    var ratingCategory: RatingCategory {
        switch self {
        case .bullet: return .bullet
        case .blitz: return .blitz
        case .rapid: return .rapid
        case .classical: return .classical
        }
    }

    /// Lichess's estimated-game-length heuristic: `base*60 + inc*40` seconds.
    /// Bucket boundaries are Lichess's own (bullet <3min, blitz <8min, rapid
    /// <25min, else classical) — used to classify any "base+inc" pool
    /// string, not just the 12 fixed presets below.
    static func classify(pool: String) -> TimeControlCategory {
        let parts = pool.split(separator: "+")
        guard parts.count == 2,
              let base = Double(parts[0]),
              let inc = Double(parts[1])
        else { return .blitz }
        let estimateSeconds = base * 60 + inc * 40
        switch estimateSeconds {
        case ..<180: return .bullet
        case ..<480: return .blitz
        case ..<1_500: return .rapid
        default: return .classical
        }
    }
}

/// One cell in the QuickPairing grid: a standard rated pool, wire-format
/// "base+inc" (minutes+seconds) as `SocketStore.queue(pool:variant:)` expects.
struct TimeControlPreset: Identifiable, Hashable, Sendable {
    var id: String { pool }
    let pool: String
    let category: TimeControlCategory

    /// 12 presets across the four speed buckets — Bullet/Blitz/Rapid/
    /// Classical, mirroring the web's grid.
    static let standard: [TimeControlPreset] = [
        TimeControlPreset(pool: "1+0", category: .bullet),
        TimeControlPreset(pool: "2+1", category: .bullet),
        TimeControlPreset(pool: "3+0", category: .blitz),
        TimeControlPreset(pool: "3+2", category: .blitz),
        TimeControlPreset(pool: "5+0", category: .blitz),
        TimeControlPreset(pool: "5+3", category: .blitz),
        TimeControlPreset(pool: "10+0", category: .rapid),
        TimeControlPreset(pool: "10+5", category: .rapid),
        TimeControlPreset(pool: "15+10", category: .rapid),
        TimeControlPreset(pool: "30+0", category: .classical),
        TimeControlPreset(pool: "30+20", category: .classical),
        TimeControlPreset(pool: "60+0", category: .classical),
    ]

    /// `standard`, bucketed by category in display order — what
    /// `QuickPairingPanel` actually iterates to build the grid sections.
    static func grouped() -> [(category: TimeControlCategory, presets: [TimeControlPreset])] {
        TimeControlCategory.allCases.map { category in
            (category, standard.filter { $0.category == category })
        }
    }

    /// "[rating±100, rounded to the nearest 50]" — the QuickPairing hint
    /// shown next to a preset when signed in (frontend-features.md).
    static func eloRangeHint(rating: Int) -> String {
        "\(roundToNearest50(rating - 100))–\(roundToNearest50(rating + 100))"
    }

    private static func roundToNearest50(_ value: Int) -> Int {
        Int((Double(value) / 50).rounded()) * 50
    }
}

/// A fixed variant queue — Duck/Crazyhouse/Antichess each play one canonical
/// pool rather than exposing the full preset grid (frontend-features.md:
/// "Duck 5+0, Crazyhouse 3+0, Antichess 3+0").
struct VariantPool: Identifiable, Hashable, Sendable {
    var id: String { variant.rawValue }
    let variant: Variant
    let pool: String
    let systemImage: String

    static let all: [VariantPool] = [
        VariantPool(variant: .duck, pool: "5+0", systemImage: "bird.fill"),
        VariantPool(variant: .crazyhouse, pool: "3+0", systemImage: "arrow.triangle.2.circlepath"),
        VariantPool(variant: .antichess, pool: "3+0", systemImage: "xmark.circle.fill"),
    ]
}
