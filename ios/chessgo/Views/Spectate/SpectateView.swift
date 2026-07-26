import SwiftUI

/// The read-only spectate screen: one game, watched over its own
/// `SpectateStore` (a fresh store per `gameId`, opened on appear, torn down
/// on disappear — spectating never shares a socket with the player's own
/// `SocketStore`). Board is always white-at-bottom and never accepts input.
struct SpectateView: View {
    @State private var store: SpectateStore
    @State private var control: SpectateBoardControl
    @Environment(SettingsStore.self) private var settings

    init(gameId: String) {
        let store = SpectateStore(gameId: gameId)
        _store = State(initialValue: store)
        _control = State(initialValue: SpectateBoardControl(store: store))
    }

    #if DEBUG
    /// Preview-only: inject an already-seeded store instead of opening a
    /// real socket. `.watch()` no-ops on a store that isn't `.closed`
    /// (previews start it `.open`/`.connecting`), so `body` below needs no
    /// preview-specific branch.
    init(previewStore: SpectateStore) {
        _store = State(initialValue: previewStore)
        _control = State(initialValue: SpectateBoardControl(store: previewStore))
    }
    #endif

    var body: some View {
        ZStack(alignment: .top) {
            Theme.Colors.background.ignoresSafeArea()

            if let game = store.game {
                content(for: game)
            } else if store.unavailable {
                unavailableView
            } else {
                ProgressView("Loading game…")
                    .tint(Theme.Colors.accent)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            if store.connection != .open, store.game != nil, !store.unavailable {
                ConnectionPill()
                    .padding(.top, Theme.Spacing.sm)
            }
        }
        .navigationTitle("Spectate")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { store.appSettings = settings }
        .task { store.watch() }
        .onDisappear { store.unwatch() }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(for game: SpectateGameState) -> some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                playerHeader(game.black)

                Clock(
                    remainingMs: store.remainingMs(for: .black),
                    running: store.isClockRunning(for: .black),
                    capturedAt: store.clockAt
                )
                .frame(maxWidth: .infinity, alignment: .trailing)

                BoardView(control: control)
                    .aspectRatio(1, contentMode: .fit)
                    // Read-only: no gesture — tap or drag — ever reaches the
                    // board. See `SpectateBoardControl`'s doc comment.
                    .allowsHitTesting(false)

                if game.variant == "crazyhouse" {
                    PocketView(pocket: game.pocket, sideToMove: game.sideToMove == "w" ? .white : .black, armed: .constant(nil))
                        .allowsHitTesting(false)
                }

                Clock(
                    remainingMs: store.remainingMs(for: .white),
                    running: store.isClockRunning(for: .white),
                    capturedAt: store.clockAt
                )
                .frame(maxWidth: .infinity, alignment: .leading)

                playerHeader(game.white)

                if store.unavailable {
                    unavailableBanner
                }

                if game.ended {
                    resultCard(game)
                }

                MoveListView(moves: moveEntries(game), currentPly: nil) { _ in }
                    .frame(height: 200)
                    .glassCard(cornerRadius: Theme.Radius.md)
            }
            .padding(Theme.Spacing.md)
        }
    }

    private func playerHeader(_ player: WsOpponent) -> some View {
        HStack {
            Avatar(name: player.name.isEmpty ? "Guest" : player.name, size: 32)
            Text(player.name.isEmpty ? "Guest" : player.name)
                .font(Theme.headline(15))
                .foregroundStyle(Theme.Colors.primaryText)
            Spacer()
            if !player.anon {
                RatingBadge(rating: player.rating, size: 16)
            }
        }
    }

    // MARK: - Banners / end states

    private var unavailableView: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Image(systemName: "eye.slash")
                .font(.system(size: 34))
                .foregroundStyle(Theme.Colors.secondaryText)
            Text("This game is no longer available.")
                .font(Theme.body())
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(Theme.Spacing.lg)
    }

    private var unavailableBanner: some View {
        Text("This game is no longer available.")
            .font(Theme.body(14))
            .foregroundStyle(Theme.Colors.secondaryText)
            .frame(maxWidth: .infinity)
            .glassCard(cornerRadius: Theme.Radius.md)
    }

    @ViewBuilder
    private func resultCard(_ game: SpectateGameState) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(resultHeadline(game))
                .font(Theme.headline(17))
                .foregroundStyle(Theme.Colors.primaryText)
            if let reason = game.reason {
                Text(reason.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    private func resultHeadline(_ game: SpectateGameState) -> String {
        guard let result = game.result else { return "Game over" }
        switch result {
        case "1-0": return "White won"
        case "0-1": return "Black won"
        case "1/2-1/2": return "Draw"
        default: return "Game over"
        }
    }

    private func moveEntries(_ game: SpectateGameState) -> [MoveListEntry] {
        game.moves.enumerated().map { MoveListEntry(ply: $0.offset + 1, san: $0.element.san, uci: $0.element.uci) }
    }
}

#Preview("SpectateView — mid-game") {
    NavigationStack {
        SpectateView(previewStore: .preview(game: .mock()))
    }
    .environment(SettingsStore.preview())
}

#Preview("SpectateView — game over") {
    NavigationStack {
        SpectateView(previewStore: .preview(game: .mock(status: "checkmate", ended: true, result: "1-0", reason: "checkmate")))
    }
    .environment(SettingsStore.preview())
}

#Preview("SpectateView — connecting") {
    NavigationStack {
        SpectateView(previewStore: .previewConnecting())
    }
    .environment(SettingsStore.preview())
}

#Preview("SpectateView — unavailable") {
    NavigationStack {
        SpectateView(previewStore: .previewUnavailable())
    }
    .environment(SettingsStore.preview())
}
