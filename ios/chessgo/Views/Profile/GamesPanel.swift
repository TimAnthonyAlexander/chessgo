import SwiftUI

/// Server-paginated, filterable game history. Owns its paging/filter state
/// and re-fetches via `ProfileService.userGames` whenever a chip or page
/// changes; the parent only supplies the already-loaded first page plus the
/// set of pools this player actually has games in.
///
/// Tapping a row with `ply > 0` opens the analysis board. **Assumption:** the
/// Analysis screen (built in parallel) exposes `AnalysisView(gameId: String)`
/// — if the real initializer differs, update the one call site in `row(_:)`.
struct GamesPanel: View {
    let profileId: String
    let profileName: String
    let availableCategories: [String]
    let perPage: Int

    @State private var games: [GameSummary]
    @State private var total: Int
    @State private var page = 1
    @State private var category: String?
    @State private var result: String?
    @State private var isLoading = false
    @State private var loadFailed = false

    init(
        profileId: String,
        profileName: String,
        availableCategories: [String],
        initialGames: [GameSummary],
        initialTotal: Int,
        perPage: Int
    ) {
        self.profileId = profileId
        self.profileName = profileName
        self.availableCategories = availableCategories
        self.perPage = max(perPage, 1)
        _games = State(initialValue: initialGames)
        _total = State(initialValue: initialTotal)
    }

    private var totalPages: Int {
        max(1, Int((Double(total) / Double(perPage)).rounded(.up)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            header

            if availableCategories.count >= 2 {
                categoryChips
            }

            if loadFailed {
                Text("Couldn't refresh games — showing the last loaded page.")
                    .font(Theme.caption(11.5))
                    .foregroundStyle(Theme.Colors.negative)
            }

            list
                .opacity(isLoading ? 0.5 : 1)
                .animation(.easeOut(duration: 0.15), value: isLoading)

            if totalPages > 1 {
                paginator
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    // MARK: - Header (result filter)

    private var header: some View {
        HStack {
            Text("Games")
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
            Spacer()
            HStack(spacing: Theme.Spacing.xs) {
                chip(label: "All", isActive: result == nil) { setResult(nil) }
                chip(label: "W", isActive: result == "win") { setResult("win") }
                chip(label: "L", isActive: result == "loss") { setResult("loss") }
                chip(label: "D", isActive: result == "draw") { setResult("draw") }
            }
        }
    }

    // MARK: - Category chips

    private var categoryChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.xs) {
                chip(label: "All", isActive: category == nil) { setCategory(nil) }
                ForEach(availableCategories, id: \.self) { cat in
                    chip(label: cat.capitalized, isActive: category == cat) { setCategory(cat) }
                }
            }
        }
    }

    private func chip(label: String, isActive: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, 4)
        .foregroundStyle(isActive ? Theme.Colors.accent : Theme.Colors.secondaryText)
        .background(Capsule().fill(isActive ? Theme.Colors.accent.opacity(0.12) : .clear))
    }

    // MARK: - List

    @ViewBuilder
    private var list: some View {
        if games.isEmpty {
            Text(category == nil && result == nil ? "No games played yet." : "No games match this filter.")
                .font(Theme.body(13.5))
                .foregroundStyle(Theme.Colors.secondaryText)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Spacing.lg)
        } else {
            VStack(spacing: 0) {
                ForEach(Array(games.enumerated()), id: \.element.id) { index, game in
                    if index > 0 {
                        Divider().opacity(0.3)
                    }
                    row(game)
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ game: GameSummary) -> some View {
        if game.ply > 0 {
            NavigationLink {
                AnalysisView(gameId: game.id)
            } label: {
                GameRow(game: game, profileId: profileId)
            }
            .buttonStyle(.plain)
        } else {
            GameRow(game: game, profileId: profileId)
        }
    }

    // MARK: - Paginator

    private var paginator: some View {
        HStack {
            Button {
                guard page > 1 else { return }
                page -= 1
                reload()
            } label: {
                Image(systemName: "chevron.left")
            }
            .disabled(page <= 1 || isLoading)

            Spacer()
            Text("Page \(page) of \(totalPages)")
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
            Spacer()

            Button {
                guard page < totalPages else { return }
                page += 1
                reload()
            } label: {
                Image(systemName: "chevron.right")
            }
            .disabled(page >= totalPages || isLoading)
        }
        .padding(.top, Theme.Spacing.xs)
        .tint(Theme.Colors.primaryText)
    }

    // MARK: - Filter actions (all reset to page 1, mirroring the web)

    private func setResult(_ value: String?) {
        guard result != value else { return }
        result = value
        page = 1
        reload()
    }

    private func setCategory(_ value: String?) {
        guard category != value else { return }
        category = value
        page = 1
        reload()
    }

    // MARK: - Fetch

    private func reload() {
        let requestedPage = page
        let requestedCategory = category
        let requestedResult = result
        isLoading = true
        Task {
            do {
                let response = try await ProfileService.shared.userGames(
                    name: profileName,
                    page: requestedPage,
                    category: requestedCategory,
                    result: requestedResult
                )
                games = response.games
                total = response.total
                loadFailed = false
            } catch {
                loadFailed = true
            }
            isLoading = false
        }
    }
}

// MARK: - Row

/// One game-history row: outcome badge, opponent, variant glyph, and the
/// profiled player's rating delta. Perspective is relative to `profileId` —
/// the player whose history this is — NOT the signed-in viewer.
private struct GameRow: View {
    let game: GameSummary
    let profileId: String

    private var isWhite: Bool { game.whiteUserId == profileId }

    private var outcomeLabel: String {
        if game.result == "1-0" { return isWhite ? "W" : "L" }
        if game.result == "0-1" { return isWhite ? "L" : "W" }
        return "D"
    }

    private var outcomeColor: Color {
        switch outcomeLabel {
        case "W": return Theme.Colors.positive
        case "L": return Theme.Colors.negative
        default: return Theme.Colors.secondaryText
        }
    }

    private var opponentName: String {
        (isWhite ? game.blackName : game.whiteName) ?? "Anonymous"
    }

    private var opponentIsBot: Bool {
        isWhite ? game.blackIsBot : game.whiteIsBot
    }

    private var delta: Int? {
        let before = isWhite ? game.whiteRatingBefore : game.blackRatingBefore
        let after = isWhite ? game.whiteRatingAfter : game.blackRatingAfter
        guard let before, let after else { return nil }
        return after - before
    }

    private var categoryLabel: String {
        if let category = game.category, !category.isEmpty { return category.capitalized }
        return "Casual"
    }

    private var subtitle: String {
        var parts: [String] = [
            categoryLabel,
            game.pool ?? "—",
            "as \(isWhite ? "White" : "Black")",
        ]
        if !game.rated { parts.append("casual") }
        if game.ply <= 0 { parts.append("no moves") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text(outcomeLabel)
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundStyle(outcomeColor)
                .frame(width: 24, height: 24)
                .overlay(Circle().stroke(outcomeColor, lineWidth: 1))

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text("vs \(opponentName)")
                        .font(Theme.body(14))
                        .fontWeight(.semibold)
                        .foregroundStyle(Theme.Colors.primaryText)
                        .lineLimit(1)
                    if opponentIsBot {
                        Image(systemName: "cpu")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    if let glyph = variantGlyph(game.variant) {
                        Image(systemName: glyph.systemImage)
                            .font(.system(size: 11))
                            .foregroundStyle(glyph.tint)
                    }
                }
                Text(subtitle)
                    .font(Theme.caption(11))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
            }

            Spacer()

            if let delta, game.rated {
                Text(delta > 0 ? "+\(delta)" : "\(delta)")
                    .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(delta > 0 ? Theme.Colors.positive : (delta < 0 ? Theme.Colors.negative : Theme.Colors.secondaryText))
            }
        }
        .padding(.vertical, Theme.Spacing.xs + 2)
        .contentShape(Rectangle())
    }

    private func variantGlyph(_ variant: String?) -> (systemImage: String, tint: Color)? {
        switch variant {
        case "duck": return ("bird.fill", Theme.Colors.accent)
        case "crazyhouse": return ("arrow.triangle.2.circlepath", Theme.Colors.accent)
        case "antichess": return ("xmark.seal.fill", Theme.Colors.secondaryText)
        case "secretqueen": return ("crown.fill", Theme.Colors.accent)
        case "chess960": return ("shuffle", Theme.Colors.accent)
        default: return nil
        }
    }
}

#Preview {
    NavigationStack {
        ScrollView {
            GamesPanel(
                profileId: "u1",
                profileName: "ada",
                availableCategories: ["blitz", "duck"],
                initialGames: GameSummary.previewStubs,
                initialTotal: 24,
                perPage: 10
            )
            .padding()
        }
        .background(Theme.Colors.background)
    }
}

private extension GameSummary {
    /// Decoded, not memberwise-constructed — several fields are `@Default*`
    /// wrapped, so this fixture goes through the same JSON-literal decode
    /// pattern as `AccountView`'s `User.previewStub`.
    static let previewStubs: [GameSummary] = {
        let json = Data("""
        [
          {"id":"g1","pool":"5+0","category":"blitz","rated":true,"variant":"standard",
           "result":"1-0","white_user_id":"u1","black_user_id":"u2","white_name":"Ada Lovelace",
           "black_name":"Bobby Fischer","white_rating_before":1440,"white_rating_after":1450,
           "black_rating_before":1500,"black_rating_after":1490,"ply":42},
          {"id":"g2","pool":"5+0","category":"duck","rated":true,"variant":"duck",
           "result":"0-1","white_user_id":"u2","black_user_id":"u1","black_name":"Ada Lovelace",
           "white_name":"Cyborg Bot","white_is_bot":true,"black_rating_before":1200,
           "black_rating_after":1214,"ply":30},
          {"id":"g3","pool":"5+0","category":"blitz","rated":false,"variant":"standard",
           "result":"1/2-1/2","white_user_id":"u1","black_user_id":"u3","white_name":"Ada Lovelace",
           "black_name":"Guest","ply":0}
        ]
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode([GameSummary].self, from: json)
    }()
}
