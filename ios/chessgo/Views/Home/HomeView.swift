import SwiftUI

/// Play tab root — the lobby. Redesigned around the FOLD: the first screen now
/// holds a complete lobby (who you are, the primary modes, and the quick-pairing
/// grid) instead of a single 700pt time-control wall that buried every other
/// action. Order, top to bottom:
///
///   1. Resume banner (only when a live game is in progress — the accent hero).
///   2. Identity strip — greeting + your ratings (guest: a sign-in nudge). This
///      replaces the old large "Play" nav title (which just repeated the tab
///      label) and the throwaway caption, reclaiming ~110pt of prime space.
///   3. Quick actions — Computer · Puzzles · Analysis · Friend, one tap each,
///      ABOVE the fold (Computer used to be below it; Analysis had no entry at
///      all). Matches the web mobile layout's priority.
///   4. Quick pairing — one dense grid (was four tall labeled sections).
///   5. Daily puzzle (real board preview) · leaderboard · stats · sign-up.
///
/// Whitespace over nested cards, one brass accent, Dynamic-Type-aware type
/// (VIBECODING.md). The engine still owns the rules — this is just the hub.
struct HomeView: View {
    @Environment(SocketStore.self) private var socket
    @Environment(AuthStore.self) private var authStore

    @State private var isPresentingChallenge = false
    @State private var isPresentingAuthSheet = false
    @State private var stats: Stats?
    /// The id of a game the player has explicitly backed out of into the
    /// lobby (via the live-game cover's "Lobby" button) — the game keeps
    /// running server-side; this just stops re-presenting the cover for it
    /// until a genuinely new match arrives.
    @State private var dismissedGameID: String?

    var body: some View {
        // Read once, directly, so the Observation system registers this as a
        // tracked dependency of `body` regardless of where it's used below
        // (the derived `fullScreenCover` binding's closures just consume this
        // captured snapshot rather than re-reading `socket.game`).
        let liveGame = socket.game

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if let liveGame, !liveGame.ended {
                        ResumeBanner(game: liveGame) { dismissedGameID = nil }
                    }

                    IdentityHeader { isPresentingAuthSheet = true }

                    QuickActionsRow { isPresentingChallenge = true }

                    QuickPairingPanel()

                    DailyPuzzleWidget()

                    LeaderboardWidget()

                    if let stats {
                        StatsLine(playersOnline: stats.playersOnline, activeGames: stats.activeGames)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }

                    if !authStore.isAuthenticated {
                        SignUpCard { isPresentingAuthSheet = true }
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .background(Theme.Colors.background)
            .refreshable { await refreshStatsOnce() }
            // The identity strip carries the "who/where you are" the large
            // title used to — hide the nav bar on the root so the lobby starts
            // at the top of the screen. Pushed destinations keep their own bars.
            .toolbar(.hidden, for: .navigationBar)
        }
        .onAppear { socket.connect() }
        .task { await pollStats() }
        .sheet(isPresented: $isPresentingChallenge) {
            ChallengeSheet(socket: socket)
        }
        .sheet(isPresented: $isPresentingAuthSheet) {
            AuthSheet()
        }
        .fullScreenCover(isPresented: liveGameBinding(for: liveGame)) {
            liveGameCover
        }
    }

    // MARK: - Live game cover

    /// `LiveGameView(socket:)` already exists (Views/Live) and drives itself
    /// entirely off `SocketStore` — Home just decides WHEN to show it full
    /// screen. A thin "Lobby" bar sits above it (not inside Views/Live) so
    /// there's a way back to Home mid-game without touching that file.
    private func liveGameBinding(for game: LiveGameState?) -> Binding<Bool> {
        Binding(
            get: { game != nil && game?.ended == false && game?.id != dismissedGameID },
            set: { isShowing in
                if !isShowing { dismissedGameID = game?.id }
            }
        )
    }

    private var liveGameCover: some View {
        VStack(spacing: 0) {
            HStack {
                Button {
                    dismissedGameID = socket.game?.id
                } label: {
                    Label("Lobby", systemImage: "chevron.down")
                        .font(Theme.caption(13))
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Spacer()
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .background(Theme.Colors.background)

            LiveGameView(socket: socket)
        }
    }

    // MARK: - Stats poll

    /// `GET /stats` every 10s while Home is alive (frontend-features.md
    /// "poll GET /stats every 10s") — `.task` auto-cancels when the view
    /// leaves the hierarchy. Pull-to-refresh reuses the single-shot fetch.
    private func pollStats() async {
        while !Task.isCancelled {
            await refreshStatsOnce()
            try? await Task.sleep(nanoseconds: 10_000_000_000)
        }
    }

    private func refreshStatsOnce() async {
        if let fetched = try? await StatsService.shared.stats() {
            stats = fetched
        }
    }
}

#Preview("HomeView — guest") {
    HomeView()
        .environment(SocketStore())
        .environment(AuthStore.preview())
}

#Preview("HomeView — signed in") {
    HomeView()
        .environment(SocketStore())
        .environment(AuthStore.preview(user: .homePreviewStub))
}

#Preview("HomeView — game in progress") {
    HomeView()
        .environment(SocketStore.preview(game: .mock()))
        .environment(AuthStore.preview())
}

private extension User {
    /// Decoded (not memberwise-initialized, per SPEC.md's `@Default`
    /// construction gotcha) so every other rating field falls back to its
    /// normal decode default.
    static let homePreviewStub: User = {
        let json = Data("""
        {"id":"preview","name":"Ada Lovelace","email":"ada@example.com",
         "rating_bullet":1180,"rating_blitz":1450,"rating_rapid":1502,"rating_classical":1610}
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(User.self, from: json)
    }()
}
