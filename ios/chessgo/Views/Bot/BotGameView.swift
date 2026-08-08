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

    /// Secret Queen only: the game doesn't exist yet and this variant's
    /// pre-game step is designation, not a loading spinner — `designationArea`
    /// takes over in place of `loadingOrError` for exactly this window.
    /// `BotSetupView`'s Play button deliberately skips calling `driver.start()`
    /// for this variant so this stays true until the player confirms a pick.
    private var isDesignating: Bool { driver.variant == .secretqueen && driver.game == nil }

    var body: some View {
        VStack(spacing: Theme.Spacing.md) {
            if isDesignating {
                designationArea
            } else if driver.game == nil {
                loadingOrError
            } else {
                if let openingLabel = driver.openingLabel {
                    openingBanner(openingLabel)
                }
                boardArea
                if driver.variant == .crazyhouse {
                    PocketView(pocket: driver.pocket, sideToMove: currentSideToMove, armed: $armedDrop)
                }
                if let note = driver.revealNote {
                    revealBanner(note)
                }
                if let outcome = driver.outcomeText {
                    outcomeBanner(outcome)
                }
                controlsRow
                // Secret Queen sends a redacted, bracket-suffixed FEN the
                // standard `/analyze` endpoint was never built to read (same
                // reason it gets no eval bar — see `showEvalBar`), so the
                // admin best-move peek stays off for it entirely rather than
                // routing to yet another dedicated engine, like Duck/Antichess
                // do — out of scope for v1 (docs/tasks/open/secret-queen.md).
                if driver.variant != .secretqueen {
                    AdminBestMove(
                        fen: driver.fen,
                        myTurn: driver.myTurn,
                        variant: driver.variant.rawValue,
                        duck: driver.duckSquare,
                        onBestMove: { bestSquares = $0 },
                        onPeek: { peeking = $0 }
                    )
                }
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

    // MARK: - Secret Queen designation

    /// The pre-game step: the real board (oriented to the player's side, home
    /// rank pawns pickable, everything else dimmed — all driven by
    /// `boardArea`'s `pickTargets`/`onPick`) with a ribbon over it and a
    /// prompt card below. Nothing here talks to the network until
    /// `designationPrompt`'s Start button fires `driver.start(secretSquare:)`
    /// — matches the web's `DesignationPrompt`/`DesignationOverlay`
    /// (`frontend/src/pages/BotGame.tsx`), rebuilt board-native rather than as
    /// a file-letter form (the owner rejected that shape on the web first).
    private var designationArea: some View {
        VStack(spacing: Theme.Spacing.md) {
            ZStack(alignment: .top) {
                boardArea
                designationRibbon.padding(.top, Theme.Spacing.sm)
            }
            designationPrompt
        }
    }

    /// Fixed, not theme-derived — floats over whichever of the 16 board
    /// palettes is active, same reasoning as `BoardView`'s crown badge.
    private static let designationChromeBackground = Color(red: 16.0 / 255, green: 17.0 / 255, blue: 21.0 / 255).opacity(0.86)
    private static let designationGold = Color(red: 0xE9 / 255.0, green: 0xC1 / 255.0, blue: 0x68 / 255.0)

    private var designationRibbon: some View {
        HStack(spacing: 6) {
            Image(systemName: "crown.fill")
                .font(.system(size: 11))
                .foregroundStyle(Self.designationGold)
            Text(designationPickSquare.map { "\($0.algebraic) is your queen — or pick another" } ?? "Pick one of your pawns")
                .font(Theme.headline(13))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 8)
        .background(Self.designationChromeBackground, in: Capsule())
        .overlay(Capsule().stroke(Color.white.opacity(0.14), lineWidth: 1))
        .allowsHitTesting(false)
    }

    private var designationPickSquare: Square? {
        driver.designationPick.flatMap { Square(algebraic: $0) }
    }

    private var designationPrompt: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Choose your secret queen")
                    .font(Theme.headline(20))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text("Tap one of your eight pawns. It moves like a queen, but Zugzwang sees an ordinary pawn until the first move only a queen could make.")
                    .font(Theme.body(13.5))
                    .foregroundStyle(Theme.Colors.secondaryText)
                Text("You're playing \(driver.orientation == .white ? "White" : "Black"). Zugzwang is choosing one too, and you won't be told which.")
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.secondaryText.opacity(0.85))
            }

            VStack(spacing: Theme.Spacing.sm) {
                Button {
                    guard let pick = designationPickSquare else { return }
                    Task { await driver.start(secretSquare: pick.algebraic) }
                } label: {
                    HStack {
                        if driver.isLoading { ProgressView().tint(.white) }
                        Text(startButtonLabel)
                    }
                    .frame(maxWidth: .infinity)
                }
                .disabled(designationPickSquare == nil || driver.isLoading)
                .prominentGlassButton()

                HStack(spacing: Theme.Spacing.sm) {
                    Button {
                        // Picks AND confirms in one tap — the server validates
                        // the square either way, this just skips the ring
                        // showing for a beat first.
                        guard let random = SecretQueen.homeRankSquares(for: driver.orientation).randomElement() else { return }
                        driver.pickDesignation(random)
                        Task { await driver.start(secretSquare: random.algebraic) }
                    } label: {
                        Label("Surprise me", systemImage: "crown.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(driver.isLoading)
                    .glassButton()

                    Button {
                        dismiss()
                    } label: {
                        Label("Back", systemImage: "chevron.left")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(driver.isLoading)
                    .glassButton()
                }
            }

            if let errorMessage = driver.errorMessage {
                Text(errorMessage)
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.negative)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    private var startButtonLabel: String {
        if driver.isLoading { return "Starting…" }
        if let pick = designationPickSquare { return "Start game with \(pick.algebraic)" }
        return "Pick a pawn to continue"
    }

    /// Plain-words reveal toast ("Black's e-pawn was a secret queen.") — the
    /// driver auto-clears `revealNote` after a few seconds, same lifecycle as
    /// the web's version. Styled like `outcomeBanner` but with the crown
    /// accent so the two read as distinct kinds of news.
    private func revealBanner(_ text: String) -> some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: "crown.fill")
                .font(.system(size: 13))
                .foregroundStyle(Theme.Colors.accent)
            Text(text)
                .font(Theme.body(14))
                .foregroundStyle(Theme.Colors.primaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    // MARK: - Tutor "drill this opening" banner

    private func openingBanner(_ opening: String) -> some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: "graduationcap.fill")
                .font(.system(size: 12))
            Text("Drilling: \(opening)")
                .font(Theme.caption(12))
                .fontWeight(.semibold)
        }
        .foregroundStyle(Theme.Colors.accent)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Board + eval bar

    /// Shared by both the designation step and live play — same sizing, same
    /// eval-bar gutter logic — so the board never jumps between the two.
    /// `pickTargets`/`onPick` are the only things that differ: `nil` once
    /// `isDesignating` flips false, which hands normal move input straight
    /// back to `driver` with no other wiring change.
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
                    highlightSquares: peeking ? bestSquares : [],
                    pickTargets: isDesignating ? Set(SecretQueen.homeRankSquares(for: driver.orientation)) : nil,
                    onPick: isDesignating ? { driver.pickDesignation($0) } : nil
                )
            }
        )
    }

    /// Zen mode hides the eval bar while a game is actively in progress
    /// (matches web parity: clocks/ratings/eval fold away, reappearing once
    /// the game ends). Secret Queen never gets one — same reason as Duck/
    /// Antichess (its redacted FEN isn't what the standard engine expects) —
    /// and there's nothing to evaluate yet during designation either way.
    private var showEvalBar: Bool {
        guard settings.showEvalBar else { return false }
        if isDesignating { return false }
        if settings.zenMode, !driver.isGameOver { return false }
        switch driver.variant {
        case .standard, .chess960, .fading, .glassjaw, .doublemove: return true
        case .duck, .crazyhouse, .antichess, .secretqueen: return false
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

#Preview("BotGameView — Secret Queen designation") {
    // No `.preview(...)` here on purpose — that factory always calls
    // `apply(_:)`, i.e. already has a game. This is the pre-game step, so a
    // plain driver (game == nil) is exactly what BotSetupView hands off.
    NavigationStack {
        BotGameView(driver: BotGameDriver(settings: BotSettings(variant: .secretqueen, rating: 1500, humanColor: "w")))
    }
    .environment(SettingsStore.preview())
    .environment(AuthStore.preview())
}

#Preview("BotGameView — Secret Queen mid-game") {
    NavigationStack {
        BotGameView(driver: .preview(
            fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2 [d2|-]",
            variant: .secretqueen,
            legalMoves: ["g1f3", "b1c3", "d2d3", "d2d4", "f1c4", "f1b5"],
            moves: [
                GameMove(ply: 1, uci: "e2e4", san: "e4", by: "human", fen: "rnbqkbnr/pppppppp/8/8/8/4P3/PPPP1PPP/RNBQKBNR b KQkq - 0 1 [d2|-]", eval: nil, duck: nil, reveal: RevealInfo(moved: false, captured: false, promoted: false, square: nil)),
                GameMove(ply: 2, uci: "e7e5", san: "e5", by: "bot", fen: "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2 [d2|-]", eval: nil, duck: nil, reveal: RevealInfo(moved: false, captured: false, promoted: false, square: nil)),
            ],
            secretSquare: "d2"
        ))
    }
    .environment(SettingsStore.preview())
    .environment(AuthStore.preview())
}
