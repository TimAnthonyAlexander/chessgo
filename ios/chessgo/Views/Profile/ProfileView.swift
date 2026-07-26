import SwiftUI

/// Read-only public profile: hero (avatar + name + headline rating +
/// sparkline), ratings panel, overall record, and paginated/filterable game
/// history. Loads `ProfileService.user(name:)`; a 404 renders "Player not
/// found." — anything else renders a generic retry-worthy error.
struct ProfileView: View {
    let name: String

    private enum Phase {
        case loading
        case loaded(Profile)
        case notFound
        case failed(String)
    }

    @State private var phase: Phase = .loading

    var body: some View {
        Group {
            switch phase {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .notFound:
                ContentUnavailableView(
                    "Player not found.",
                    systemImage: "person.crop.circle.badge.questionmark"
                )
            case let .failed(message):
                ContentUnavailableView(
                    "Couldn't load this profile.",
                    systemImage: "wifi.slash",
                    description: Text(message)
                )
            case let .loaded(profile):
                ScrollView {
                    ProfileBody(profile: profile)
                        .padding(Theme.Spacing.md)
                }
            }
        }
        .background(Theme.Colors.background)
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: name) { await load() }
    }

    private func load() async {
        phase = .loading
        do {
            let profile = try await ProfileService.shared.user(name: name)
            phase = .loaded(profile)
        } catch let error as APIError where error.statusCode == 404 {
            phase = .notFound
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

/// The profile's static content — split out from the network-driven container
/// so it previews directly from a decoded fixture, no request required.
private struct ProfileBody: View {
    let profile: Profile

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            hero
            RecordPanel(
                wins: profile.record?.wins ?? 0,
                losses: profile.record?.losses ?? 0,
                draws: profile.record?.draws ?? 0,
                total: profile.record?.total ?? 0
            )
            RatingsPanel(rows: ratingsRows)
            GamesPanel(
                profileId: profile.id,
                profileName: profile.name,
                availableCategories: availableCategories,
                initialGames: profile.games,
                initialTotal: profile.gamesTotal,
                perPage: profile.gamesPerPage > 0 ? profile.gamesPerPage : 10
            )
        }
    }

    // MARK: - Hero

    private var hero: some View {
        let primary = primaryRating
        return HStack(alignment: .center, spacing: Theme.Spacing.md) {
            Avatar(name: profile.name, size: 60)

            VStack(alignment: .leading, spacing: 2) {
                Text(profile.name)
                    .font(Theme.title(22))
                    .foregroundStyle(Theme.Colors.primaryText)
                if let created = profile.createdAt {
                    Text("Member since \(Self.shortDate(created))")
                        .font(Theme.caption())
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }

            Spacer(minLength: Theme.Spacing.sm)

            if let primary {
                VStack(alignment: .trailing, spacing: 4) {
                    Text(primary.label.uppercased())
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Theme.Colors.secondaryText)
                    RatingBadge(rating: primary.rating, provisional: primary.provisional, size: 28)
                    if primary.series.count >= 2 {
                        RatingSparkline(series: primary.series, color: Theme.Colors.accent, width: 96, height: 28)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    private static func shortDate(_ iso: String) -> String {
        var date = ISO8601DateFormatter.withFractionalSeconds.date(from: iso)
        if date == nil {
            date = ISO8601DateFormatter.plain.date(from: iso)
        }
        guard let date else { return iso }
        return Self.mediumDateFormatter.string(from: date)
    }

    private static let mediumDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        return formatter
    }()

    // MARK: - Ratings panel rows

    private var ratingsRows: [RatingsPanel.Row] {
        let primaryKey = primaryRating?.key
        let timeControls: [(RatingCategory, String, String)] = [
            (.bullet, "bolt.fill", "Bullet"),
            (.blitz, "bolt.circle.fill", "Blitz"),
            (.rapid, "hare.fill", "Rapid"),
            (.classical, "tortoise.fill", "Classical"),
        ]

        var rows = timeControls.map { category, icon, label -> RatingsPanel.Row in
            let snap = snapshot(for: category)
            return RatingsPanel.Row(
                id: category.rawValue,
                icon: icon,
                label: label,
                rating: snap?.rating ?? 0,
                games: snap?.games ?? 0,
                provisional: snap?.provisional ?? false,
                sub: nil,
                highlighted: category == primaryKey
            )
        }

        if let puzzle = profile.puzzle {
            let losses = max(puzzle.games - puzzle.solved, 0)
            rows.append(RatingsPanel.Row(
                id: "puzzle",
                icon: "puzzlepiece.fill",
                label: "Puzzles",
                rating: puzzle.rating,
                games: puzzle.games,
                provisional: puzzle.provisional,
                sub: "\(puzzle.solved)W \(losses)L",
                highlighted: false
            ))
        }
        if let duck = profile.duck {
            rows.append(RatingsPanel.Row(
                id: "duck", icon: "bird.fill", label: "Duck",
                rating: duck.rating, games: duck.games, provisional: duck.provisional,
                sub: nil, highlighted: false
            ))
        }
        if let antichess = profile.antichess {
            rows.append(RatingsPanel.Row(
                id: "antichess", icon: "xmark.seal.fill", label: "Antichess",
                rating: antichess.rating, games: antichess.games, provisional: antichess.provisional,
                sub: nil, highlighted: false
            ))
        }
        return rows
    }

    // MARK: - Headline rating + sparkline

    private struct PrimaryRatingInfo {
        let key: RatingCategory
        let label: String
        let rating: Int
        let provisional: Bool
        let series: [Int]
    }

    /// The most-played time control (bullet/blitz/rapid/classical), with a
    /// rating-trend series reconstructed from the loaded page of games.
    /// Mirrors the web's `primaryRating`/`ratingSeries` (`shared.ts`).
    private var primaryRating: PrimaryRatingInfo? {
        let timeControls: [RatingCategory] = [.bullet, .blitz, .rapid, .classical]
        var best: RatingCategory?
        var bestGames = -1
        for category in timeControls {
            let games = snapshot(for: category)?.games ?? 0
            if games > bestGames {
                bestGames = games
                best = category
            }
        }
        guard let best else { return nil }
        let tile = snapshot(for: best)
        let series = ratingSeries[best.rawValue] ?? []
        let window = Array(series.suffix(16))
        return PrimaryRatingInfo(
            key: best,
            label: best.rawValue.capitalized,
            rating: tile?.rating ?? 0,
            provisional: tile?.provisional ?? false,
            series: window
        )
    }

    /// Per-category rating progression, oldest-to-newest, reconstructed from
    /// each rated standard game's post-game rating. `profile.games` is the
    /// fixed first page (unfiltered) — it doesn't move as `GamesPanel` pages
    /// or filters underneath, so this stays stable.
    private var ratingSeries: [String: [Int]] {
        var out: [String: [Int]] = [:]
        for game in profile.games.reversed() {
            guard game.rated, game.variant == "standard",
                  let category = game.category, !category.isEmpty else { continue }
            let isWhite = game.whiteUserId == profile.id
            let after = isWhite ? game.whiteRatingAfter : game.blackRatingAfter
            guard let after else { continue }
            out[category, default: []].append(after)
        }
        return out
    }

    // MARK: - Available game-history categories

    private var availableCategories: [String] {
        var cats: [String] = []
        for category: RatingCategory in [.bullet, .blitz, .rapid, .classical] {
            if (snapshot(for: category)?.games ?? 0) > 0 { cats.append(category.rawValue) }
        }
        if (profile.duck?.games ?? 0) > 0 { cats.append("duck") }
        if (profile.antichess?.games ?? 0) > 0 { cats.append("antichess") }
        return cats
    }

    private func snapshot(for category: RatingCategory) -> RatingSnapshot? {
        switch category {
        case .bullet: return profile.ratings?.bullet
        case .blitz: return profile.ratings?.blitz
        case .rapid: return profile.ratings?.rapid
        case .classical: return profile.ratings?.classical
        default: return nil
        }
    }
}

private extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let plain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}

#Preview("Live") {
    NavigationStack {
        ProfileView(name: "Ada Lovelace")
    }
}

#Preview("Loaded fixture") {
    NavigationStack {
        ScrollView {
            ProfileBody(profile: .previewStub)
                .padding(Theme.Spacing.md)
        }
        .background(Theme.Colors.background)
    }
}

private extension Profile {
    /// Decoded (not memberwise-constructed) — most fields are `@Default*`
    /// wrapped, so this follows the same JSON-literal decode pattern as
    /// `AccountView`'s `User.previewStub`.
    static let previewStub: Profile = {
        let json = Data("""
        {
          "id": "u1",
          "name": "Ada Lovelace",
          "created_at": "2025-01-14T00:00:00Z",
          "ratings": {
            "bullet": {"rating": 1180, "rd": 60, "games": 12, "provisional": true},
            "blitz": {"rating": 1450, "rd": 40, "games": 62, "provisional": false},
            "rapid": {"rating": 1502, "rd": 45, "games": 31, "provisional": false},
            "classical": {"rating": 0, "rd": 0, "games": 0, "provisional": false}
          },
          "puzzle": {"rating": 1600, "rd": 35, "games": 300, "solved": 210, "provisional": false},
          "duck": {"rating": 1300, "rd": 80, "games": 5, "provisional": true},
          "antichess": {"rating": 0, "rd": 0, "games": 0, "provisional": false},
          "record": {"wins": 42, "losses": 20, "draws": 8, "total": 70},
          "games_total": 70,
          "games_per_page": 10,
          "games": [
            {"id":"g1","pool":"5+0","category":"blitz","rated":true,"variant":"standard",
             "result":"1-0","white_user_id":"u1","black_user_id":"u2","white_name":"Ada Lovelace",
             "black_name":"Bobby Fischer","white_rating_before":1440,"white_rating_after":1450,
             "black_rating_before":1500,"black_rating_after":1490,"ply":42},
            {"id":"g2","pool":"5+0","category":"blitz","rated":true,"variant":"standard",
             "result":"0-1","white_user_id":"u2","black_user_id":"u1","black_name":"Ada Lovelace",
             "white_name":"Cyborg Bot","white_is_bot":true,"black_rating_before":1425,
             "black_rating_after":1440,"ply":58},
            {"id":"g3","pool":"5+0","category":"duck","rated":true,"variant":"duck",
             "result":"1-0","white_user_id":"u1","black_user_id":"u3","white_name":"Ada Lovelace",
             "black_name":"Guest","white_rating_before":1280,"white_rating_after":1300,"ply":30}
          ]
        }
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(Profile.self, from: json)
    }()
}
