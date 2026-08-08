import SwiftUI

/// The small lobby widgets: today's puzzle, the leaderboard, a subtle stats
/// line, and the sign-up card (frontend-features.md "Widgets").

// MARK: - Daily puzzle

struct DailyPuzzleWidget: View {
    @State private var puzzle: PuzzleNext?
    @State private var loadFailed = false

    var body: some View {
        NavigationLink {
            PuzzlesView()
        } label: {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                HomeSectionHeader(title: "Daily puzzle", subtitle: "Find the best move")

                VStack(spacing: 0) {
                    topStrip
                    board
                    bottomStrip
                }
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .stroke(Theme.Colors.primaryText.opacity(0.06), lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            }
            .glassCard()
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
        .task {
            await load()
        }
    }

    @ViewBuilder
    private var topStrip: some View {
        HStack {
            if let puzzle {
                Text(puzzle.color == "b" ? "Black to move" : "White to move")
                    .font(Theme.headline(14))
                    .foregroundStyle(Theme.Colors.primaryText)
                Spacer()
                Text("Rated \(puzzle.rating)")
                    .font(Theme.caption(12).monospacedDigit())
                    .foregroundStyle(Theme.Colors.secondaryText)
            } else if loadFailed {
                Text("Daily puzzle")
                    .font(Theme.headline(14))
                    .foregroundStyle(Theme.Colors.primaryText)
                Spacer()
            } else {
                Text("Loading…")
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.secondaryText)
                Spacer()
            }
        }
        .padding(.horizontal, Theme.Spacing.sm)
        .frame(height: 28)
    }

    private var board: some View {
        BoardView(
            control: StaticBoardControl(
                fen: puzzle?.fen ?? ChessBoard.startFEN,
                orientation: (puzzle?.color == "b") ? .black : .white,
                lastMove: puzzle?.opponentMove
            )
        )
        .aspectRatio(1, contentMode: .fit)
        .allowsHitTesting(false)
    }

    @ViewBuilder
    private var bottomStrip: some View {
        HStack {
            if let puzzle {
                Text(themesLabel(for: puzzle))
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
                Spacer()
                Text("Solve →")
                    .font(Theme.headline(13))
                    .foregroundStyle(Theme.Colors.accent)
            } else if loadFailed {
                Text("Tap to try today's puzzle")
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.secondaryText)
                Spacer()
            } else {
                Spacer()
            }
        }
        .padding(.horizontal, Theme.Spacing.sm)
        .frame(height: 28)
    }

    private var accessibilityLabel: String {
        guard let puzzle else {
            return loadFailed ? "Daily puzzle, tap to try today's puzzle" : "Daily puzzle, loading"
        }
        let sideToMove = puzzle.color == "b" ? "Black" : "White"
        return "Daily puzzle, rated \(puzzle.rating), \(sideToMove) to move"
    }

    private func themesLabel(for puzzle: PuzzleNext) -> String {
        let themes = puzzle.themes.prefix(2).map(titleCaseTheme)
        guard !themes.isEmpty else { return "Tactics" }
        return themes.joined(separator: " · ")
    }

    /// "mateIn2" / "hanging_piece" / "back-rank-mate" → "Mate In 2" /
    /// "Hanging Piece" / "Back Rank Mate". Splits camelCase runs and any
    /// underscore/dash separators, then capitalizes each resulting word.
    private func titleCaseTheme(_ raw: String) -> String {
        var words: [String] = []
        var current = ""
        for char in raw {
            if char == "_" || char == "-" {
                if !current.isEmpty { words.append(current); current = "" }
            } else if char.isUppercase, !current.isEmpty {
                words.append(current)
                current = String(char)
            } else {
                current.append(char)
            }
        }
        if !current.isEmpty { words.append(current) }
        return words.map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    private func load() async {
        do {
            puzzle = try await PuzzleService.shared.daily()
        } catch {
            loadFailed = true
        }
    }
}

// MARK: - Leaderboard

struct LeaderboardWidget: View {
    @State private var category: RatingCategory = .blitz
    @State private var entries: [LeaderboardEntry] = []
    @State private var isLoading = false

    /// Crazyhouse has no leaderboard route (`ProfileService.leaderboard`'s
    /// own doc comment) — every other rating pool is toggleable.
    private static let categories: [RatingCategory] = RatingCategory.allCases.filter { $0 != .crazyhouse }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Leaderboard")
                .font(Theme.headline(16))
                .foregroundStyle(Theme.Colors.primaryText)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.xs) {
                    ForEach(Self.categories, id: \.self) { cat in
                        chip(cat)
                    }
                }
            }

            rows
        }
        .padding(Theme.Spacing.md)
        .glassCard()
        .task(id: category) {
            await load()
        }
    }

    @ViewBuilder
    private var rows: some View {
        if isLoading && entries.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Spacing.sm)
        } else if entries.isEmpty {
            Text("No ranked players yet.")
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
                .padding(.vertical, Theme.Spacing.xs)
        } else {
            VStack(spacing: Theme.Spacing.xs) {
                ForEach(entries) { entry in
                    HStack {
                        Text("\(entry.rank)")
                            .font(Theme.body(14).monospacedDigit())
                            .foregroundStyle(Theme.Colors.secondaryText)
                            .frame(width: 24, alignment: .leading)
                        Text(entry.name)
                            .font(Theme.body(15))
                            .foregroundStyle(Theme.Colors.primaryText)
                        Spacer()
                        Text("\(entry.rating)")
                            .font(Theme.body(15).monospacedDigit())
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(entry.rank). \(entry.name), \(entry.rating)")
                }
            }
        }
    }

    private func chip(_ cat: RatingCategory) -> some View {
        Button {
            category = cat
        } label: {
            Text(label(for: cat))
                .font(Theme.caption(12))
                .foregroundStyle(category == cat ? .white : Theme.Colors.primaryText)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, 6)
                .frame(minHeight: HomeMetrics.minTapTarget)
                .background(category == cat ? Theme.Colors.accent : Theme.Colors.surface, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label(for: cat))
        .accessibilityAddTraits(category == cat ? [.isButton, .isSelected] : .isButton)
    }

    private func label(for cat: RatingCategory) -> String {
        switch cat {
        case .bullet: return "Bullet"
        case .blitz: return "Blitz"
        case .rapid: return "Rapid"
        case .classical: return "Classical"
        case .puzzle: return "Puzzles"
        case .chess960: return "Chess960"
        case .duck: return "Duck"
        case .crazyhouse: return "Crazyhouse"
        case .antichess: return "Antichess"
        case .secretqueen: return "Secret Queen"
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        if let result = try? await ProfileService.shared.leaderboard(category: category, limit: 5) {
            entries = result.entries
        }
    }
}

// MARK: - Stats line

/// Subtle "N online / N games" strip — plain ints so callers never need to
/// hand-construct the `@Default`-wrapped `Stats` model just to preview this.
struct StatsLine: View {
    let playersOnline: Int
    let activeGames: Int

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            Label("\(playersOnline) online", systemImage: "person.2.fill")
            Label("\(activeGames) games", systemImage: "gamecontroller.fill")
        }
        .font(Theme.caption())
        .foregroundStyle(Theme.Colors.secondaryText)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Sign-up card

/// Richer guest → account nudge (replaces the old one-line `GuestNudge`),
/// modeled on the web's sign-up widget: perks list + two CTAs, both opening
/// the shared auth sheet (which carries its own login/signup tabs).
struct SignUpCard: View {
    let onSignIn: () -> Void

    private struct Perk {
        let icon: String
        let text: String
    }

    private static let perks: [Perk] = [
        Perk(icon: "tray.and.arrow.down.fill", text: "Save every game to your profile"),
        Perk(icon: "chart.bar.fill", text: "Earn a real rating in each time control"),
        Perk(icon: "trophy.fill", text: "Climb the leaderboard"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Play for keeps")
                    .font(Theme.headline(16))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text("You're playing as a guest")
                    .font(Theme.caption(13))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                ForEach(Self.perks, id: \.text) { perk in
                    perkRow(perk)
                }
            }

            VStack(spacing: Theme.Spacing.sm) {
                Button("Create account", action: onSignIn)
                    .frame(maxWidth: .infinity, minHeight: HomeMetrics.minTapTarget)
                    .prominentGlassButton()
                    .accessibilityLabel("Create account")

                Button("Log in", action: onSignIn)
                    .buttonStyle(.plain)
                    .font(Theme.body(15))
                    .foregroundStyle(Theme.Colors.accent)
                    .frame(minHeight: HomeMetrics.minTapTarget)
                    .accessibilityLabel("Log in")
            }
        }
        .glassCard()
    }

    private func perkRow(_ perk: Perk) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: perk.icon)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Colors.accent)
                .frame(width: 28, height: 28)
                .background(Theme.Colors.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))

            Text(perk.text)
                .font(Theme.body(14))
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }
}

#Preview("DailyPuzzleWidget") {
    NavigationStack {
        DailyPuzzleWidget()
            .padding(Theme.Spacing.lg)
    }
    .background(Theme.Colors.background)
    .environment(AuthStore.preview())
}

#Preview("LeaderboardWidget") {
    LeaderboardWidget()
        .padding(Theme.Spacing.lg)
        .background(Theme.Colors.background)
}

#Preview("StatsLine") {
    StatsLine(playersOnline: 812, activeGames: 341)
        .padding(Theme.Spacing.lg)
        .background(Theme.Colors.background)
}

#Preview("SignUpCard") {
    SignUpCard(onSignIn: {})
        .padding(Theme.Spacing.lg)
        .background(Theme.Colors.background)
}
