import SwiftUI

/// The bot game screen: board, eval bar (standard-rules variants only),
/// pocket (Crazyhouse), a controls row, and the move list.
///
/// Layout invariant (frontend-features.md): the board stays pinned to a
/// fixed square no matter what's around it — `boardArea` routes through
/// `BoardStage` (the shared iOS `BoardPage` equivalent), so the move list or
/// the post-game banner appearing below never resizes it, and the eval bar
/// (when shown) is always exactly the board's height.
struct BotGameView: View {
    let driver: BotGameDriver
    @Environment(\.dismiss) private var dismiss
    @Environment(SettingsStore.self) private var settings

    @State private var armedDrop: PieceKind?
    @State private var flipped = false
    @State private var showResignConfirm = false
    @State private var eval: EvalScore?
    /// Admin best-move peek: the from/to squares of the engine's suggestion
    /// (populated only for admins with the toggle on) and whether the floating
    /// peek button is currently held.
    @State private var bestSquares: [Square] = []
    @State private var peeking = false

    private static let evalDepthLadder = [4, 8, 12, 16]

    var body: some View {
        VStack(spacing: Theme.Spacing.md) {
            if driver.game == nil {
                loadingOrError
            } else {
                boardArea
                if driver.variant == .crazyhouse {
                    PocketView(pocket: driver.pocket, sideToMove: currentSideToMove, armed: $armedDrop)
                }
                if let outcome = driver.outcomeText {
                    outcomeBanner(outcome)
                }
                controlsRow
                AdminBestMove(
                    fen: driver.fen,
                    myTurn: driver.myTurn,
                    variant: driver.variant.rawValue,
                    duck: driver.duckSquare,
                    onBestMove: { bestSquares = $0 },
                    onPeek: { peeking = $0 }
                )
                if showMoveList {
                    MoveListView(moves: moveListEntries, currentPly: moveListEntries.last?.ply) { _ in }
                        .frame(height: 180)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.background)
        .navigationTitle(driver.variant.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { driver.appSettings = settings }
        .task(id: driver.fen) {
            await refreshEval()
        }
        .confirmationDialog("Resign this game?", isPresented: $showResignConfirm, titleVisibility: .visible) {
            Button("Resign", role: .destructive) { driver.resign() }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var loadingOrError: some View {
        if driver.isLoading {
            VStack(spacing: Theme.Spacing.md) {
                ProgressView()
                Text("Starting game…")
                    .font(Theme.body(15))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .frame(maxWidth: .infinity, minHeight: 240)
        } else if let errorMessage = driver.errorMessage {
            VStack(spacing: Theme.Spacing.md) {
                Text("Couldn't start the game")
                    .font(Theme.headline(16))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(errorMessage)
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .multilineTextAlignment(.center)
                Button("Try again") {
                    Task { await driver.start() }
                }
                .glassButton()
            }
            .frame(maxWidth: .infinity, minHeight: 240)
            .padding(Theme.Spacing.lg)
        }
    }

    // MARK: - Board + eval bar

    private var boardArea: some View {
        BoardStage(
            showsEvalBar: showEvalBar,
            evalBar: { EvalBar(eval: eval, sideToMove: currentSideToMove) },
            board: {
                BoardView(
                    control: driver,
                    armedDrop: $armedDrop,
                    flipped: flipped,
                    displayOptions: BoardDisplayOptions(settings),
                    highlightSquares: peeking ? bestSquares : []
                )
            }
        )
    }

    /// Zen mode hides the eval bar while a game is actively in progress
    /// (matches web parity: clocks/ratings/eval fold away, reappearing once
    /// the game ends).
    private var showEvalBar: Bool {
        guard settings.showEvalBar else { return false }
        if settings.zenMode, !driver.isGameOver { return false }
        switch driver.variant {
        case .standard, .chess960, .fading, .glassjaw, .doublemove: return true
        case .duck, .crazyhouse, .antichess: return false
        }
    }

    private var showMoveList: Bool {
        guard settings.showMoveList else { return false }
        if settings.zenMode, !driver.isGameOver { return false }
        return true
    }

    private var currentSideToMove: PieceColor {
        ChessBoard(fen: driver.fen).sideToMove
    }

    private func refreshEval() async {
        guard showEvalBar, driver.game != nil else {
            eval = nil
            return
        }
        let fen = driver.fen
        for depth in Self.evalDepthLadder {
            if Task.isCancelled { return }
            guard let result = try? await AnalysisService.shared.analyze(fen: fen, depth: depth) else { continue }
            if Task.isCancelled { return }
            eval = result.eval
        }
    }

    // MARK: - Outcome + controls

    private func outcomeBanner(_ text: String) -> some View {
        Text(text)
            .font(Theme.headline(16))
            .foregroundStyle(Theme.Colors.primaryText)
            .frame(maxWidth: .infinity)
            .glassCard()
    }

    private var controlsRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            controlButton("Undo", systemImage: "arrow.uturn.backward", disabled: !driver.canUndo) {
                Task { await driver.undo() }
            }
            controlButton("Resign", systemImage: "flag.fill", disabled: driver.isGameOver) {
                if settings.confirmResign {
                    showResignConfirm = true
                } else {
                    driver.resign()
                }
            }
            controlButton("New game", systemImage: "arrow.clockwise") {
                driver.newGame()
                dismiss()
            }
            controlButton("Flip", systemImage: "arrow.up.arrow.down") {
                flipped.toggle()
            }
        }
    }

    private func controlButton(
        _ title: String,
        systemImage: String,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: systemImage)
                    .font(.system(size: 18))
                Text(title)
                    .font(Theme.caption(11))
            }
            .frame(maxWidth: .infinity)
        }
        .foregroundStyle(disabled ? Theme.Colors.secondaryText.opacity(0.4) : Theme.Colors.primaryText)
        .disabled(disabled)
    }

    // MARK: - Move list

    private var moveListEntries: [MoveListEntry] {
        driver.moves.map { MoveListEntry(ply: $0.ply, san: $0.san, uci: $0.uci) }
    }
}

#Preview("BotGameView — mid-game") {
    NavigationStack {
        BotGameView(driver: .preview())
    }
    .environment(SettingsStore.preview())
    .environment(AuthStore.preview())
}

#Preview("BotGameView — Crazyhouse") {
    NavigationStack {
        BotGameView(driver: .preview(
            fen: "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R[Pp] w KQkq - 0 3",
            variant: .crazyhouse,
            legalMoves: ["P@e6", "P@d6", "g1f3", "b1c3"]
        ))
    }
    .environment(SettingsStore.preview())
    .environment(AuthStore.preview())
}

#Preview("BotGameView — game over") {
    NavigationStack {
        BotGameView(driver: .preview(yourTurn: false, status: "checkmate", result: "1-0"))
    }
    .environment(SettingsStore.preview())
    .environment(AuthStore.preview())
}
