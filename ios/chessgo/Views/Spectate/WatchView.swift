import SwiftUI

/// The spectate lobby: a polling grid of live games (`GET /watch`), each a
/// small read-only board preview + both players + clocks. Tapping a card
/// opens `SpectateView`, which opens its own real-time socket — this screen
/// itself never opens a WebSocket, just polls the flat REST snapshot.
struct WatchView: View {
    @State private var games: [WatchGame] = []
    @State private var fetchedAt: Date = .now
    @State private var isLoading = true
    @State private var loadFailed = false

    private static let columns = [GridItem(.adaptive(minimum: 188), spacing: Theme.Spacing.md)]

    var body: some View {
        NavigationStack {
            ScrollView {
                content
                    .padding(Theme.Spacing.md)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Watch")
            .task { await pollLoop() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading, games.isEmpty {
            ProgressView("Loading live games…")
                .tint(Theme.Colors.accent)
                .frame(maxWidth: .infinity, minHeight: 240)
        } else if games.isEmpty {
            ContentUnavailableView(
                "No live games right now",
                systemImage: "eye.slash",
                description: Text(loadFailed ? "Couldn't reach the server. Pull to retry." : "Check back in a moment.")
            )
            .frame(maxWidth: .infinity, minHeight: 240)
        } else {
            LazyVGrid(columns: Self.columns, spacing: Theme.Spacing.md) {
                ForEach(games) { game in
                    NavigationLink {
                        SpectateView(gameId: game.id)
                    } label: {
                        WatchGameCard(game: game, fetchedAt: fetchedAt)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// The very first `/watch` poll is also what wakes the hub's JIT filler
    /// pool, so an empty first response is expected for a couple of seconds
    /// while those engine-vs-engine games spin up. Mirror the web
    /// `LiveTvWidget` warm-up: retry a few times on a short backoff before
    /// revealing the empty state, so the tab shows a loader instead of
    /// flashing "No live games" on entry. The steady poll below is the
    /// longer-term backstop.
    private static let warmupBackoffMs: [UInt64] = [0, 1200, 2600]

    /// `.task` cancels this automatically when the view leaves the hierarchy
    /// (tab switch), so there's no explicit teardown to write.
    private func pollLoop() async {
        await warmUp()
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard !Task.isCancelled else { return }
            await refresh()
        }
    }

    /// Poll on a short backoff, keeping the loader up until a game lands or the
    /// attempts are exhausted — only then reveal the empty/error state.
    private func warmUp() async {
        for delay in Self.warmupBackoffMs {
            if Task.isCancelled { return }
            if delay > 0 {
                try? await Task.sleep(nanoseconds: delay * 1_000_000)
                if Task.isCancelled { return }
            }
            await refresh()
            if !games.isEmpty {
                isLoading = false
                return
            }
        }
        isLoading = false
    }

    /// Fetches the lobby list. Deliberately does NOT flip `isLoading` — that's
    /// owned by `warmUp` so an empty warm-up response keeps the loader up
    /// instead of blanking to "No live games".
    private func refresh() async {
        do {
            let response = try await WatchService.shared.liveGames()
            games = response.games
            fetchedAt = Date()
            loadFailed = false
        } catch {
            Log.warn("WatchView.refresh: \(error.localizedDescription)")
            loadFailed = true
        }
    }
}

/// One lobby card: mini board + both players + live-ticking clocks + a
/// pool/rated/variant strip. Every row is built to survive the grid's
/// minimum card width without clipping or pushing the clock out — long
/// names truncate, the clock never does.
private struct WatchGameCard: View {
    let game: WatchGame
    /// When this card's data was fetched — `CompactClock` interpolates
    /// locally from here between polls so the ms value doesn't look frozen
    /// for 2.5s.
    let fetchedAt: Date

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            BoardView(control: MiniBoardControl(game: game))
                .aspectRatio(1, contentMode: .fit)
                .allowsHitTesting(false)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))

            VStack(alignment: .leading, spacing: 4) {
                playerRow(game.black, ms: game.clockB, running: game.sideToMove == "b")
                playerRow(game.white, ms: game.clockW, running: game.sideToMove == "w")
            }

            footer
        }
        .padding(Theme.Spacing.sm)
        .glassCard(cornerRadius: Theme.Radius.md)
    }

    /// Name gets `maxWidth: .infinity` + a 1-line truncating `Text`, so it's
    /// the only element in the row that shrinks — rating and clock keep
    /// their intrinsic width and are never pushed off the card.
    private func playerRow(_ player: WatchPlayer, ms: Int, running: Bool) -> some View {
        HStack(spacing: Theme.Spacing.xs) {
            Text(player.name.isEmpty ? "Guest" : player.name)
                .font(Theme.body(13))
                .foregroundStyle(Theme.Colors.primaryText)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(0)
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)

            if !player.anon {
                Text("\(player.rating)")
                    .font(Theme.caption(11).monospacedDigit())
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
                    .layoutPriority(1)
                    .fixedSize()
            }

            CompactClock(remainingMs: ms, running: running, capturedAt: fetchedAt)
                .layoutPriority(1)
        }
    }

    /// Pool + (non-standard) variant collapse into one truncating line so a
    /// long combination never crowds the rated seal off the trailing edge;
    /// the seal itself is fixed-size and always fully visible.
    private var footer: some View {
        HStack(spacing: Theme.Spacing.xs) {
            if !footerLabel.isEmpty {
                Text(footerLabel)
                    .font(Theme.caption(11))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
            } else {
                Spacer(minLength: 0)
            }
            if game.rated {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.Colors.accent)
                    .fixedSize()
            }
        }
    }

    private var footerLabel: String {
        var parts: [String] = []
        if !game.pool.isEmpty { parts.append(game.pool) }
        if game.variant != "standard", !game.variant.isEmpty { parts.append(game.variant.capitalized) }
        return parts.joined(separator: " · ")
    }
}

/// Small inline clock sized for a lobby card — same elapsed-interpolation
/// contract as `Views/Board/Clock.swift` (`remainingMs` + `capturedAt`,
/// self-ticking via `TimelineView`), but built LOCALLY here rather than
/// reusing `Clock`: that view's headline-18 text and capsule chrome are too
/// large for a grid card and were the main source of the old card's overflow.
/// "Side to move" emphasis is a subtle text-weight/color change, not a
/// background pill.
private struct CompactClock: View {
    let remainingMs: Int
    let running: Bool
    let capturedAt: Date

    var body: some View {
        TimelineView(.periodic(from: capturedAt, by: 0.5)) { timeline in
            let elapsedMs = running ? max(0, timeline.date.timeIntervalSince(capturedAt) * 1000) : 0
            let displayMs = max(0, remainingMs - Int(elapsedMs))

            Text(Self.format(displayMs))
                .font(Theme.caption(12).monospacedDigit())
                .fontWeight(running ? .semibold : .regular)
                .foregroundStyle(running ? Theme.Colors.primaryText : Theme.Colors.secondaryText)
                .lineLimit(1)
                .fixedSize()
        }
    }

    /// mm:ss down to the minute/second — a lobby glance doesn't need the
    /// sub-10s tenths precision the in-game `Clock` shows.
    private static func format(_ ms: Int) -> String {
        let totalSeconds = ms / 1000
        return String(format: "%d:%02d", totalSeconds / 60, totalSeconds % 60)
    }
}

/// Non-interactive board renderer for a lobby card: a single FEN snapshot,
/// no live updates, no legal moves. Deliberately NOT `SpectateBoardControl`
/// (that opens a live per-game WebSocket) — opening one socket per lobby
/// card just to render a still frame would spam the hub; this only ever
/// reads whatever `/watch` last returned.
private final class MiniBoardControl: BoardControl {
    let fen: String
    let orientation: PieceColor = .white
    let myTurn = false
    let legalMoves: [String] = []
    let lastMove: String?
    let inCheck = false
    let canPremove = false
    let duckSquare: String?

    init(game: WatchGame) {
        self.fen = game.fen.isEmpty ? ChessBoard.startFEN : game.fen
        self.lastMove = game.lastMove.isEmpty ? nil : game.lastMove
        self.duckSquare = game.duck.isEmpty ? nil : game.duck
    }

    func submit(_ uci: String) {}
}

#Preview("WatchView — populated") {
    WatchViewPreview(games: [
        .mock(), .mockDuck(),
        .mock(id: "third1", whiteName: "Petrosianista", blackName: "Rook_Endgame"),
        .mock(id: "fourth1", whiteName: "GrandmasterOfDisasterOnTheChessboard", blackName: "AnotherVeryLongUsernameHere"),
    ])
}

#Preview("WatchView — empty") {
    WatchViewPreview(games: [])
}

/// Preview-only shim: `WatchView` fetches its own list over the network, so
/// previews render the card grid directly instead of exercising `WatchView`
/// itself.
private struct WatchViewPreview: View {
    let games: [WatchGame]

    var body: some View {
        NavigationStack {
            ScrollView {
                if games.isEmpty {
                    ContentUnavailableView("No live games right now", systemImage: "eye.slash", description: Text("Check back in a moment."))
                        .frame(maxWidth: .infinity, minHeight: 240)
                        .padding(Theme.Spacing.md)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 188), spacing: Theme.Spacing.md)], spacing: Theme.Spacing.md) {
                        ForEach(games) { game in
                            WatchGameCard(game: game, fetchedAt: .now)
                        }
                    }
                    .padding(Theme.Spacing.md)
                }
            }
            .background(Theme.Colors.background)
            .navigationTitle("Watch")
        }
    }
}
