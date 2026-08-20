import SwiftUI

/// The live human-vs-human board screen. Purely a view over `SocketStore`'s
/// published state — every action (move, resign, draw/takeback, chat) goes
/// straight through the store's public senders; this file owns no game
/// logic of its own. Zen-ish minimal, per the brief: one board, two clocks,
/// a move list, an offer/chat strip, nothing decorative.
struct LiveGameView: View {
    let socket: SocketStore

    @State private var driver: LiveGameDriver
    @State private var armedDrop: PieceKind?
    @State private var showResignConfirm = false
    /// Admin best-move peek: the engine's suggested from/to squares (admins
    /// only) and whether the floating peek button is currently held.
    @State private var bestSquares: [Square] = []
    @State private var peeking = false
    @Environment(SettingsStore.self) private var settings

    /// Tracks the last `lastMove` we already sounded for, so the opponent-
    /// move sound (below) fires exactly once per arrival instead of once per
    /// `onChange` invocation quirk.
    @State private var soundedLastMove: String?

    init(socket: SocketStore) {
        self.socket = socket
        self._driver = State(initialValue: LiveGameDriver(socket: socket))
    }

    private var myColor: PieceColor { driver.orientation }
    private var opponentColor: PieceColor { myColor.opposite }

    /// Zen mode folds clocks/ratings away while the game is actively being
    /// played, matching web parity; they reappear once the game ends.
    private var zenModeActive: Bool {
        settings.zenMode && !(socket.game?.ended ?? true)
    }

    private var showMoveList: Bool {
        settings.showMoveList && !zenModeActive
    }

    var body: some View {
        ZStack(alignment: .top) {
            Theme.Colors.background.ignoresSafeArea()

            if let game = socket.game {
                content(for: game)
            } else if socket.connection == .open {
                Text("No active game.")
                    .font(Theme.body())
                    .foregroundStyle(Theme.Colors.secondaryText)
            } else {
                ProgressView("Connecting…")
                    .tint(Theme.Colors.accent)
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            if socket.connection != .open, !(socket.game?.ended ?? true) {
                ConnectionPill()
                    .padding(.top, Theme.Spacing.sm)
            }
        }
        .onAppear { driver.appSettings = settings }
        .onChange(of: socket.game?.lastMove) { _, _ in
            playOpponentMoveSoundIfNeeded()
        }
        .alert("Resign this game?", isPresented: $showResignConfirm) {
            Button("Resign", role: .destructive) { socket.resign() }
            Button("Cancel", role: .cancel) {}
        }
    }

    /// The opponent's move sounds once it lands: detected by the socket's
    /// `sideToMove` flipping to the human's own color (own moves already
    /// sound synchronously in `LiveGameDriver.submit`). Guarded by
    /// `soundedLastMove` so a re-render doesn't replay the same move.
    private func playOpponentMoveSoundIfNeeded() {
        guard let game = socket.game, let lastMove = game.lastMove, lastMove != soundedLastMove,
              game.sideToMove == game.color, let san = game.moves.last?.san
        else { return }
        soundedLastMove = lastMove
        let volume = settings.soundEnabled ? settings.soundVolume : 0
        SoundEngine.shared.playForSan(san, isGameOver: game.ended, volume: volume)
    }

    @ViewBuilder
    private func content(for game: LiveGameState) -> some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                header(game)

                if !zenModeActive {
                    Clock(
                        remainingMs: game.clock(for: opponentColor),
                        running: socket.isClockRunning(for: opponentColor),
                        capturedAt: socket.clockAt
                    )
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }

                BoardView(
                    control: driver,
                    armedDrop: $armedDrop,
                    displayOptions: BoardDisplayOptions(settings),
                    highlightSquares: peeking ? bestSquares : []
                )
                .aspectRatio(1, contentMode: .fit)

                if game.variant == "crazyhouse" {
                    PocketView(pocket: game.pocket, sideToMove: game.sideToMove == "w" ? .white : .black, armed: $armedDrop)
                }

                if !zenModeActive {
                    Clock(
                        remainingMs: game.clock(for: myColor),
                        running: socket.isClockRunning(for: myColor),
                        capturedAt: socket.clockAt
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                OfferBanner(title: "Draw offered", state: socket.drawOfferState, onAccept: socket.drawAccept, onDismiss: dismissDraw)
                OfferBanner(title: "Takeback requested", state: socket.takebackOfferState, onAccept: socket.takebackAccept, onDismiss: dismissTakeback)

                if !game.ended {
                    controlsRow(game)
                }

                AdminBestMove(
                    fen: driver.fen,
                    myTurn: driver.myTurn,
                    variant: game.variant,
                    duck: game.duck,
                    onBestMove: { bestSquares = $0 },
                    onPeek: { peeking = $0 }
                )

                if showMoveList {
                    MoveListView(moves: moveEntries(game), currentPly: nil) { _ in }
                        .frame(height: 180)
                        .glassCard(cornerRadius: Theme.Radius.md)
                }

                ChatPanel(messages: socket.messages, disabled: game.ended, onSend: socket.chat)

                if game.ended {
                    postGameCard(game)
                }
            }
            .padding(Theme.Spacing.md)
        }
    }

    @ViewBuilder
    private func header(_ game: LiveGameState) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(game.opponent.name.isEmpty ? "Opponent" : game.opponent.name)
                    .font(Theme.headline(16))
                    .foregroundStyle(Theme.Colors.primaryText)
                if !zenModeActive {
                    Text(game.opponent.anon ? "Guest" : "\(game.opponent.rating)")
                        .font(Theme.caption())
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Spacer()
            if !game.opponentOnline, !game.ended {
                DisconnectNotice(deadline: game.opponentGraceDeadline, outcome: game.opponentGraceOutcome)
            }
        }
    }

    private func controlsRow(_ game: LiveGameState) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Button {
                if settings.confirmResign {
                    showResignConfirm = true
                } else {
                    socket.resign()
                }
            } label: {
                Label("Resign", systemImage: "flag.fill")
                    .frame(maxWidth: .infinity)
            }
            .glassButton()

            Button {
                socket.drawOffer()
            } label: {
                Label("Draw", systemImage: "hand.raised.fill")
                    .frame(maxWidth: .infinity)
            }
            .glassButton()
            .disabled(socket.drawOfferState != .none)

            Button {
                socket.takebackOffer()
            } label: {
                Label("Takeback", systemImage: "arrow.uturn.backward")
                    .frame(maxWidth: .infinity)
            }
            .glassButton()
            .disabled(socket.takebackOfferState != .none || game.moves.isEmpty)
        }
    }

    @ViewBuilder
    private func postGameCard(_ game: LiveGameState) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(resultHeadline(game))
                .font(Theme.headline(18))
                .foregroundStyle(Theme.Colors.primaryText)

            if let reason = game.reason {
                Text(reasonText(reason))
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            if let delta = ratingDelta {
                Text(delta >= 0 ? "Rating +\(delta)" : "Rating \(delta)")
                    .font(Theme.body(15))
                    .foregroundStyle(delta >= 0 ? Theme.Colors.positive : Theme.Colors.negative)
            }

            Button("Done") { socket.leaveGame() }
                .prominentGlassButton()
                .padding(.top, Theme.Spacing.xs)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    // MARK: - Derived

    private func dismissDraw() {
        if socket.drawOfferState == .theirs { socket.drawDecline() } else { socket.dismissDrawOffer() }
    }

    private func dismissTakeback() {
        if socket.takebackOfferState == .theirs { socket.takebackDecline() } else { socket.dismissTakebackOffer() }
    }

    private func moveEntries(_ game: LiveGameState) -> [MoveListEntry] {
        game.moves.enumerated().map { MoveListEntry(ply: $0.offset + 1, san: $0.element.san, uci: $0.element.uci) }
    }

    private var ratingDelta: Int? {
        guard let postGame = socket.postGame, let game = socket.game else { return nil }
        let isWhite = game.color == "w"
        guard let before = isWhite ? postGame.whiteRatingBefore : postGame.blackRatingBefore,
              let after = isWhite ? postGame.whiteRatingAfter : postGame.blackRatingAfter
        else { return nil }
        return after - before
    }

    private func resultHeadline(_ game: LiveGameState) -> String {
        guard let result = game.result else {
            return game.reason == "connectionLost" ? "Connection lost" : "Game over"
        }
        if result == "1/2-1/2" { return "Draw" }
        let iWon = (result == "1-0" && myColor == .white) || (result == "0-1" && myColor == .black)
        return iWon ? "You won" : "You lost"
    }

    private func reasonText(_ reason: String) -> String {
        switch reason {
        case "connectionLost": return "Lost connection to the game."
        default: return reason.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}

#Preview("LiveGameView — mid-game") {
    LiveGameView(socket: .preview(game: .mock()))
        .environment(SettingsStore.preview())
        .environment(AuthStore.preview())
}

#Preview("LiveGameView — opponent offered a draw") {
    let store = SocketStore.preview(game: .mock())
    store.simulateDrawOffered()
    return LiveGameView(socket: store)
        .environment(SettingsStore.preview())
        .environment(AuthStore.preview())
}

#Preview("LiveGameView — game over, I won") {
    LiveGameView(socket: .preview(game: .mock(status: "checkmate", ended: true, result: "1-0", reason: "checkmate")))
        .environment(SettingsStore.preview())
        .environment(AuthStore.preview())
}

#Preview("LiveGameView — reconnecting") {
    LiveGameView(socket: .preview(game: .mock(), connection: .connecting))
        .environment(SettingsStore.preview())
        .environment(AuthStore.preview())
}
