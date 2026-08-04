import Foundation

/// Tutor: the player report card. Mirrors the TS contract at the end of
/// `frontend/src/api/client.ts` (`// --- Tutor: the player report card ---`)
/// field-for-field. Two decode-resilience choices apply throughout, beyond
/// the app's usual `@Default*` convention:
///
/// - `TutorCategoryReport`, `TutorMetricValue`, and `TutorTrendSeries` are
///   **dictionary values** (`categories`/`metrics`/`series` are all
///   `Record<string, X>`). `DefaultEmptyDictionary` degrades the WHOLE
///   dictionary to `[:]` if even one entry fails to decode (see its doc
///   comment in `Models/User.swift`) — there is no per-key-lossy dictionary
///   in this codebase. So every field on those three types is `@Default*`-
///   or `Optional`-guarded, never a plain throwing `let`, to keep one bad
///   category/metric/series-point from silently wiping every other one.
/// - Everywhere else (elements of a plain `[T]`, which IS per-element lossy
///   via `DefaultEmptyArray`), plain `let` is used for contract-required
///   fields — a malformed element just drops that one row, which is
///   correct: don't invent a zero for data that wasn't there.
///
/// Closed string unions from the server (`status`, `tier`, `kind`, `color`,
/// `unit`) stay plain `String` at the model layer, per the app's existing
/// convention (`BotGame.variant`, `Game.result`, `WatchGame.sideToMove`) — a
/// new server-side case can never fail a decode. Call sites switch on them
/// with a default/fallback case instead of trusting a Swift enum decode.

// MARK: - Comparisons & metrics

/// How a measured value compares to players in the same rating band. Every
/// Tutor number is relative — an absolute accuracy figure says nothing, and
/// "below other 1500s" is the only form that's actionable.
struct TutorComparison: Decodable, Sendable, Equatable {
    @DefaultEmptyString var metric: String
    /// '' for a plain metric, else a qualifier: "phase:endgame", "piece:R",
    /// "opening:Sicilian Defense".
    @DefaultEmptyString var dimension: String
    @DefaultEmptyString var label: String
    /// Present on entries inside `phases`/`pieces`/`openings`: the dimension
    /// with its family prefix stripped, ready to render.
    let name: String?
    @DefaultZeroDouble var mine: Double
    @DefaultZeroDouble var peer: Double
    /// Games behind YOUR number. Always shown next to it — a figure without
    /// its sample size is an argument, not a fact.
    @DefaultZero var sample: Int
    /// Games behind the PEER number.
    @DefaultZero var peerSample: Int
    /// [-1, 1]. Positive is always good, whichever direction the raw metric runs.
    @DefaultZeroDouble var grade: Double
    /// "much better" | "better" | "slightly better" | "similar" | …
    @DefaultEmptyString var wording: String
    /// grade x sqrt(evidence x level weight). Drives ranking, not display.
    @DefaultZeroDouble var importance: Double
    /// 1-99, or nil without enough percentile data.
    let percentile: Int?
    @DefaultTrue var higherIsBetter: Bool
    /// "percent" | "cp" | "rating".
    @DefaultEmptyString var unit: String
}

/// A measured value on its own, before comparison. Lives inside
/// `TutorCategoryReport.metrics` (a `Record<string, _>`) — every field is
/// `@Default*`-wrapped so one bad key can't wipe the whole metrics table.
struct TutorMetricValue: Decodable, Sendable, Equatable {
    @DefaultZeroDouble var value: Double
    @DefaultZero var sample: Int
    @DefaultEmptyString var label: String
    @DefaultEmptyString var unit: String
    @DefaultTrue var higherIsBetter: Bool
}

/// A position from one of the player's OWN games, to be replayed.
struct TutorDrillPosition: Decodable, Sendable, Identifiable {
    var id: String { "\(gameId)-\(ply)" }
    let fen: String
    let gameId: String
    @DefaultZero var ply: Int
    @DefaultEmptyString var color: String
    let san: String?
    /// Centipawns lost at this moment — drills are ordered by it.
    @DefaultZeroDouble var swing: Double
    let playedAt: String?
}

/// One game reference inside a `games`-kind drill.
struct TutorDrillGameRef: Decodable, Sendable, Identifiable {
    var id: String { gameId }
    let gameId: String
    let playedAt: String?
}

/// What to DO about a weakness. Exactly one per weakness card, by design: a
/// card with four links is a card with no recommendation.
///
/// - `puzzles` — a themed set, filtered to this player's weak themes
/// - `replay`  — positions from their own games, played out against the bot
/// - `opening` — drill one opening from their side of it
/// - `games`   — no honest drill exists (time trouble); show the evidence
struct TutorDrill: Decodable, Sendable, Identifiable {
    var id: String { "\(kind)-\(metric)-\(dimension)" }
    @DefaultEmptyString var kind: String
    @DefaultEmptyString var metric: String
    @DefaultEmptyString var dimension: String
    @DefaultEmptyString var label: String
    @DefaultEmptyString var title: String
    @DefaultEmptyString var blurb: String
    @DefaultEmptyArray var themes: [String]
    @DefaultEmptyArray var positions: [TutorDrillPosition]
    let opening: String?
    /// Which side to drill the opening from: "w" | "b".
    let color: String?
    @DefaultEmptyArray var games: [TutorDrillGameRef]
}

/// View-layer switch key for `TutorDrill.kind` — never used for decoding, so
/// an unrecognized server value can't fail anything; it just falls through to
/// `nil` and the card renders its title/blurb with no action body.
enum TutorDrillKind: String {
    case puzzles, replay, opening, games
}

/// Which peer band produced the comparisons, so the UI can say how sure it is
/// rather than implying certainty it doesn't have.
struct TutorPeerInfo: Decodable, Sendable, Equatable {
    /// "band" = your own rating band; "widened" = neighbouring bands merged
    /// because yours was too thin; "none" = no comparison was possible.
    @DefaultEmptyString var tier: String
    @DefaultZero var bandFrom: Int
    @DefaultZero var bandTo: Int
    @DefaultEmptyString var source: String

    /// Explicit memberwise init (the `@Default*` wrappers otherwise demand
    /// the wrapper type, not the raw value, in the synthesized one — see
    /// `PuzzleNext`'s identical note) so a "no peer data" fallback can be
    /// built when the `peer` key itself is missing/malformed.
    init(tier: String = "none", bandFrom: Int = 0, bandTo: Int = 0, source: String = "") {
        self.tier = tier
        self.bandFrom = bandFrom
        self.bandTo = bandTo
        self.source = source
    }
}

/// `openings: { w: [...], b: [...] }` — split by the colour they were played
/// with. The same opening is a different problem from each side, so merging
/// them hides what a repertoire fix depends on.
struct TutorOpeningsSplit: Decodable, Sendable {
    @DefaultEmptyArray var w: [TutorComparison]
    @DefaultEmptyArray var b: [TutorComparison]
}

/// One measured game.
struct TutorGameRow: Decodable, Sendable, Identifiable {
    var id: String { gameId }
    let gameId: String
    let playedAt: String?
    @DefaultEmptyString var color: String
    @DefaultEmptyString var opening: String
    @DefaultEmptyString var result: String
    @DefaultEmptyString var reason: String
    let myRating: Int?
    let oppRating: Int?
    let accuracy: Double?
    let acpl: Double?
    @DefaultZero var moves: Int
}

/// One rating category's sub-report. Lives inside `TutorPayload.categories`
/// (a `Record<string, _>`) — every field is `@Default*`/`Optional`-guarded so
/// one malformed category can't wipe every other one in the dictionary.
struct TutorCategoryReport: Decodable, Sendable, Identifiable {
    var id: String { category }
    @DefaultEmptyString var category: String
    @DefaultZero var rating: Int
    /// Games actually measured.
    @DefaultZero var games: Int
    /// Games available in the window before sampling.
    @DefaultZero var gamesAvailable: Int
    @DefaultFalse var capHit: Bool
    let peer: TutorPeerInfo?
    @DefaultEmptyDictionary var metrics: [String: TutorMetricValue]
    @DefaultEmptyArray var comparisons: [TutorComparison]
    @DefaultEmptyArray var strengths: [TutorComparison]
    @DefaultEmptyArray var weaknesses: [TutorComparison]
    @DefaultEmptyArray var phases: [TutorComparison]
    @DefaultEmptyArray var pieces: [TutorComparison]
    let openings: TutorOpeningsSplit?
    /// One row per measured game — the report showing its working, and what
    /// the opening drilldown is served from.
    @DefaultEmptyArray var gameRows: [TutorGameRow]
    @DefaultEmptyArray var drills: [TutorDrill]
    /// The player's rating TODAY, as opposed to `rating`, which is the mean
    /// rating they actually played the sampled games at.
    @DefaultZero var currentRating: Int

    var effectivePeer: TutorPeerInfo { peer ?? TutorPeerInfo() }
    var openingsWhite: [TutorComparison] { openings?.w ?? [] }
    var openingsBlack: [TutorComparison] { openings?.b ?? [] }

    /// Mirrors the web's `CategorySection.drillFor` — matches a weakness row
    /// to its one drill by `(metric, dimension)`.
    func drill(for comparison: TutorComparison) -> TutorDrill? {
        drills.first { $0.metric == comparison.metric && $0.dimension == comparison.dimension }
    }
}

/// Solve rate per tactical theme, from the player's puzzle history — the
/// second, independent source of tactical evidence. `awareness` says whether
/// you punish mistakes; this says which patterns you miss, by name.
///
/// `comparable` is always false and the UI must respect it: the imported
/// puzzle set carries puzzle ratings but not other players' per-theme
/// results, so a peer number here would be invented rather than measured.
/// Show `note`.
struct TutorThemeEntry: Decodable, Sendable, Identifiable {
    var id: String { theme }
    let theme: String
    @DefaultZero var attempts: Int
    @DefaultZero var solved: Int
    @DefaultZeroDouble var rate: Double
    @DefaultZeroDouble var avgPuzzleRating: Double
}

struct TutorThemeProfile: Decodable, Sendable {
    @DefaultEmptyArray var themes: [TutorThemeEntry]
    @DefaultZero var attempts: Int
    @DefaultFalse var comparable: Bool
    @DefaultEmptyString var note: String
}

/// The one sentence at the top of the report. `Optional` at every call site
/// (never crashes the payload) and internally `@Default*`-guarded (never
/// throws on its own malformed field either) — see the type doc comment.
struct TutorHeadline: Decodable, Sendable {
    @DefaultEmptyString var category: String
    @DefaultEmptyString var metric: String
    @DefaultEmptyString var text: String
    @DefaultZeroDouble var mine: Double
    @DefaultZeroDouble var peer: Double
    @DefaultZero var sample: Int
}

struct TutorInsufficientInfo: Decodable, Sendable {
    @DefaultZero var games: Int
    @DefaultZero var need: Int
}

struct TutorPayload: Decodable, Sendable {
    @DefaultZero var version: Int
    let baselineSource: String?
    let generatedAt: String?
    let rangeFrom: String?
    let rangeTo: String?
    let headline: TutorHeadline?
    /// Player-level, not per-category — the puzzle pool has no time control.
    let themeProfile: TutorThemeProfile?
    @DefaultEmptyDictionary var categories: [String: TutorCategoryReport]
    /// Categories that had games but not enough of them, so the page can say
    /// "Blitz: 12 of 20 games. Play 8 more" instead of silently omitting it.
    @DefaultEmptyDictionary var insufficient: [String: TutorInsufficientInfo]
    @DefaultZero var minGames: Int

    private static let categoryOrder = [
        "bullet", "blitz", "rapid", "classical", "puzzle", "duck", "crazyhouse", "antichess",
    ]

    /// Dictionaries decode with no preserved key order, unlike the web's
    /// `Object.keys()`. This reconstructs a stable, sensible order: the
    /// app's usual rating-category order first, then anything unrecognized
    /// alphabetically.
    var orderedCategoryKeys: [String] {
        let known = Self.categoryOrder.filter { categories[$0] != nil }
        let rest = categories.keys.filter { !Self.categoryOrder.contains($0) }.sorted()
        return known + rest
    }
}

// MARK: - Report shelf

enum TutorReportStatus: String {
    case queued, building, ready, insufficient, failed, unknown
}

/// One report row on the shelf, or the summary alongside a full payload.
struct TutorReportSummary: Decodable, Sendable, Identifiable {
    let id: String
    @DefaultEmptyString var status: String
    @DefaultEmptyString var rangeFrom: String
    @DefaultEmptyString var rangeTo: String
    @DefaultEmptyString var rangeLabel: String
    @DefaultZero var gamesConsidered: Int
    @DefaultZero var gamesUsed: Int
    @DefaultFalse var capHit: Bool
    let builtAt: String?
    let createdAt: String?
    let error: String?
    let headline: TutorHeadline?
    @DefaultEmptyArray var categories: [String]

    var statusKind: TutorReportStatus { TutorReportStatus(rawValue: status) ?? .unknown }
    var isPending: Bool { statusKind == .queued || statusKind == .building }
}

/// Whether a new report is worth building — and if not, a reason the user can
/// act on. Never a bare cooldown: "no new games, play a few more" beats a
/// dead button with a timer.
struct TutorEligibility: Decodable, Sendable {
    @DefaultFalse var canRequest: Bool
    let reason: String?
    @DefaultZero var newGames: Int
    @DefaultZero var usedToday: Int
    @DefaultZero var dailyLimit: Int

    init(
        canRequest: Bool = false,
        reason: String? = "Couldn't check eligibility.",
        newGames: Int = 0,
        usedToday: Int = 0,
        dailyLimit: Int = 0
    ) {
        self.canRequest = canRequest
        self.reason = reason
        self.newGames = newGames
        self.usedToday = usedToday
        self.dailyLimit = dailyLimit
    }
}

// MARK: - Responses

/// `GET /tutor/reports`.
struct TutorReportsResponse: Decodable, Sendable {
    @DefaultEmptyArray var reports: [TutorReportSummary]
    let eligibility: TutorEligibility?
    @DefaultEmptyArray var ranges: [String]
    @DefaultZero var minGames: Int
}

/// `POST /tutor/reports`.
struct TutorReportRequestResponse: Decodable, Sendable {
    let report: TutorReportSummary
}

/// `GET /tutor/reports/{id}`. 404s (not 403s) for someone else's report.
struct TutorReportDetailResponse: Decodable, Sendable {
    let report: TutorReportSummary
    let payload: TutorPayload
}

/// `DELETE /tutor/reports/{id}`.
struct TutorDeleteResponse: Decodable, Sendable {
    @DefaultFalse var deleted: Bool
}

// MARK: - Opening drilldown

struct TutorOpeningSummary: Decodable, Sendable {
    @DefaultZero var games: Int
    let score: Double?
    let accuracy: Double?
}

struct TutorOpeningDrillRef: Decodable, Sendable {
    @DefaultEmptyString var kind: String
    @DefaultEmptyString var opening: String
    @DefaultEmptyString var color: String
}

/// `GET /tutor/reports/{id}/opening`. One opening family from one side, with
/// the games behind it.
struct TutorOpeningDetail: Decodable, Sendable {
    @DefaultEmptyString var category: String
    @DefaultEmptyString var color: String
    @DefaultEmptyString var family: String
    let comparison: TutorComparison?
    let peer: TutorPeerInfo?
    @DefaultEmptyArray var games: [TutorGameRow]
    let summary: TutorOpeningSummary?
    let drill: TutorOpeningDrillRef?

    var effectivePeer: TutorPeerInfo { peer ?? TutorPeerInfo() }
}

// MARK: - Trend

/// One point in a metric's history across reports.
struct TutorTrendPoint: Decodable, Sendable, Identifiable {
    var id: String { reportId }
    @DefaultEmptyString var reportId: String
    let at: String?
    /// YOUR measured value, never a grade — that is what makes the line
    /// legitimate across reports compared against different peer tiers.
    let value: Double?
    @DefaultZero var sample: Int
    @DefaultEmptyString var peerTier: String
    let rating: Int?
}

/// One metric across every report you've built. Lives inside
/// `TutorTrendResponse.series` (a `Record<string, Record<string, _>>`) — every
/// field is `@Default*`-guarded for the same reason as `TutorCategoryReport`.
struct TutorTrendSeries: Decodable, Sendable {
    @DefaultEmptyString var label: String
    @DefaultEmptyString var unit: String
    @DefaultTrue var higherIsBetter: Bool
    @DefaultEmptyArray var points: [TutorTrendPoint]
    @DefaultZeroDouble var delta: Double
    @DefaultFalse var improved: Bool
    /// The reports behind this line used different peer tiers. The line is
    /// still valid (raw values), but the UI should say so.
    @DefaultFalse var mixedTiers: Bool

    /// Non-null values in ply order, for the sparkline.
    var plottedValues: [Double] { points.compactMap(\.value) }
}

/// `GET /tutor/trend`.
struct TutorTrendResponse: Decodable, Sendable {
    @DefaultEmptyArray var categories: [String]
    @DefaultEmptyDictionary var series: [String: [String: TutorTrendSeries]]
    @DefaultZero var reports: Int
}

// MARK: - Shared formatting

/// The ONLY place that decides "78.4%" vs "41 cp" vs a bare rating number, so
/// every consumer stays in sync — mirrors `frontend/src/components/tutor/format.ts`
/// `fmtValue`, extended to actually handle `"rating"` (the web's version
/// silently mis-renders that unit as `cp`; ported correctly here rather than
/// bug-for-bug).
enum TutorFormat {
    static func value(_ value: Double, unit: String) -> String {
        switch unit {
        case "percent": return String(format: "%.1f%%", value)
        case "rating": return String(Int(value.rounded()))
        default: return "\(Int(value.rounded())) cp"
        }
    }

    /// Signed delta for the trend page — "+4.2%" / "-12 cp" / "+34".
    static func delta(_ delta: Double, unit: String) -> String {
        let sign = delta > 0 ? "+" : ""
        switch unit {
        case "percent": return "\(sign)\(String(format: "%.1f", delta))%"
        case "rating": return "\(sign)\(Int(delta.rounded()))"
        default: return "\(sign)\(Int(delta.rounded())) cp"
        }
    }

    /// "Jan 3, 2026" — nullable, matching the rest of the app's date rendering.
    static func date(_ iso: String?) -> String {
        guard let iso else { return "" }
        var date = ISO8601DateFormatter.tutorFractional.date(from: iso)
        if date == nil { date = ISO8601DateFormatter.tutorPlain.date(from: iso) }
        guard let date else { return "" }
        return dateFormatter.string(from: date)
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        return formatter
    }()

    /// "bullet" -> "Bullet". Category/dimension keys arrive lowercase from the API.
    static func cap(_ s: String) -> String {
        s.isEmpty ? s : s.prefix(1).uppercased() + s.dropFirst()
    }

    /// "hangingPiece" -> "Hanging piece". Puzzle theme tags arrive camelCase.
    static func themeLabel(_ tag: String) -> String {
        var spaced = ""
        for (index, char) in tag.enumerated() {
            if index > 0, char.isUppercase { spaced += " " }
            spaced.append(char)
        }
        let lowered = spaced.lowercased()
        return cap(lowered)
    }
}

private extension ISO8601DateFormatter {
    static let tutorFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let tutorPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
