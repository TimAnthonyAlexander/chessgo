import SwiftUI

/// The analysis board screen: board + eval bar, a scrubber, the opening
/// explorer, the live engine-lines panel, and the move list.
///
/// Layout invariant (frontend-features.md): the board stays pinned to a
/// fixed square — `boardArea` routes through `BoardStage` (the shared iOS
/// `BoardPage` equivalent), which is the one place board+eval-bar geometry
/// lives, so nothing below it (panels, move list) can resize it.
struct AnalysisView: View {
    @State private var driver: AnalysisDriver
    @State private var flipped = false

    /// Game review: load the cached post-mortem for a finished game.
    init(gameId: String) {
        _driver = State(initialValue: AnalysisDriver(gameId: gameId))
    }

    /// Free explore: start from `fen` (or the standard start position) with
    /// no server analysis — the user plays moves to explore.
    init(fen: String? = nil) {
        _driver = State(initialValue: AnalysisDriver(fen: fen))
    }

    #if DEBUG
    /// Preview-only: inject an already-seeded driver (e.g. `.previewReview`)
    /// without going through either public entry point's own setup.
    fileprivate init(previewDriver: AnalysisDriver) {
        _driver = State(initialValue: previewDriver)
    }
    #endif

    var body: some View {
        VStack(spacing: Theme.Spacing.md) {
            header
            if driver.unsupported {
                unsupportedBanner
            } else if driver.mode == .review, driver.steps.isEmpty {
                loadingOrErrorBanner
            } else {
                boardArea
                controlsRow
                ScrollView {
                    belowBoardPanels
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.background)
        .navigationTitle(driver.mode == .review ? "Analysis" : "Explore")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if driver.mode == .review { await driver.load() }
        }
        .onDisappear {
            driver.cancelLiveEval()
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: Theme.Spacing.sm) {
            if driver.mode == .review, let white = driver.whiteName, let black = driver.blackName {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(white) vs \(black)")
                        .font(Theme.headline(16))
                        .foregroundStyle(Theme.Colors.primaryText)
                    if let result = driver.result {
                        Text(result)
                            .font(Theme.caption())
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
            } else {
                Text("Free explore")
                    .font(Theme.headline(16))
                    .foregroundStyle(Theme.Colors.primaryText)
            }
            Spacer()
            judgmentBadge
            Button {
                flipped.toggle()
            } label: {
                Image(systemName: "arrow.up.arrow.down")
            }
            .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    @ViewBuilder
    private var judgmentBadge: some View {
        if driver.mode == .review, let judgment = driver.currentStep?.judgment, !judgment.isEmpty {
            Text(judgment.capitalized)
                .font(Theme.caption(12).bold())
                .foregroundStyle(.white)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, 4)
                .background(judgmentColor(judgment), in: Capsule())
        }
    }

    private func judgmentColor(_ judgment: String) -> Color {
        switch judgment {
        case "best", "good": return Theme.Colors.positive
        case "inaccuracy": return Theme.Colors.warning
        case "mistake", "blunder": return Theme.Colors.negative
        default: return Theme.Colors.secondaryText
        }
    }

    // MARK: - Unsupported / loading / error

    private var unsupportedBanner: some View {
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundStyle(Theme.Colors.secondaryText)
            Text("Analysis not available for this variant.")
                .font(Theme.body(15))
                .foregroundStyle(Theme.Colors.secondaryText)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 240)
    }

    @ViewBuilder
    private var loadingOrErrorBanner: some View {
        if driver.isLoading {
            VStack(spacing: Theme.Spacing.md) {
                ProgressView()
                Text("Loading analysis…")
                    .font(Theme.body(15))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .frame(maxWidth: .infinity, minHeight: 240)
        } else if let loadError = driver.loadError {
            VStack(spacing: Theme.Spacing.md) {
                Text("Couldn't load analysis")
                    .font(Theme.headline(16))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(loadError)
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .multilineTextAlignment(.center)
                Button("Try again") {
                    Task { await driver.load() }
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
            showsEvalBar: true,
            evalBar: { EvalBar(eval: displayEval, sideToMove: sideToMove) },
            board: {
                BoardView(control: driver)
                    .rotationEffect(.degrees(flipped ? 180 : 0))
            }
        )
    }

    // MARK: - Below-board panels

    /// `OpeningPanel`/`EngineLinesPanel` each opt into `.glassCard()`
    /// (native `.glassEffect` on iOS 26+) independently. Stacked in a plain
    /// `VStack` those render as separate glass surfaces, each with its own
    /// specular highlight + drop shadow — close together that reads as a
    /// heavy, "stacked glass" mess. `GlassEffectContainer` is Apple's fix for
    /// exactly this: it unifies nearby `.glassEffect` descendants into one
    /// coherent render pass instead of compounding shadows. Below iOS 26
    /// `glassCard()` already falls back to a flat fill + hairline stroke, so
    /// no container is needed there.
    @ViewBuilder
    private var belowBoardPanels: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: Theme.Spacing.md) {
                belowBoardStack
            }
        } else {
            belowBoardStack
        }
    }

    private var belowBoardStack: some View {
        VStack(spacing: Theme.Spacing.md) {
            OpeningPanel(fen: driver.fen, history: driver.historyUci)
            EngineLinesPanel(driver: driver)
            moveListCard
        }
    }

    /// `MoveListView` has no card styling of its own — give it the same
    /// flat, hairline-bordered surface as the `.glassCard()` fallback (no
    /// shadow) instead of leaving it a bare floating list.
    private var moveListCard: some View {
        MoveListView(moves: moveListEntries, currentPly: currentPly) { ply in
            driver.jump(toPly: ply)
        }
        .frame(height: 180)
        .background(
            Theme.Colors.surface,
            in: RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .stroke(Theme.Colors.primaryText.opacity(0.06), lineWidth: 1)
        )
    }

    private var sideToMove: PieceColor { ChessBoard(fen: driver.fen).sideToMove }

    /// Prefers the live ladder's freshest read; falls back to the review
    /// step's cached white-relative eval (converted to side-to-move-relative,
    /// `EvalBar`'s expected input shape) until the ladder's first rung lands.
    private var displayEval: EvalScore? {
        if let live = driver.liveEval?.eval { return live }
        guard let whiteEval = driver.currentStep?.evalWhite else { return nil }
        let sideRelative = sideToMove == .white ? whiteEval.value : -whiteEval.value
        return EvalScore(type: whiteEval.type, value: sideRelative)
    }

    // MARK: - Step controls

    private var controlsRow: some View {
        HStack(spacing: Theme.Spacing.sm) {
            stepButton("backward.end.fill", disabled: driver.currentIndex == 0) { driver.stepToStart() }
            stepButton("chevron.backward", disabled: driver.currentIndex == 0) { driver.stepBack() }
            stepButton("chevron.forward", disabled: isAtEnd) { driver.stepForward() }
            stepButton("forward.end.fill", disabled: isAtEnd) { driver.stepToEnd() }
        }
    }

    private var isAtEnd: Bool { driver.currentIndex >= driver.steps.count - 1 }

    private func stepButton(_ systemImage: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 18))
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Spacing.sm)
        }
        // Every other icon-only Button in this app is `.plain` — without it,
        // iOS 26's default button style adds its own glass chrome + drop
        // shadow, which is the "weird shadow on the move-control buttons"
        // the user is seeing here.
        .buttonStyle(.plain)
        .foregroundStyle(disabled ? Theme.Colors.secondaryText.opacity(0.4) : Theme.Colors.primaryText)
        .disabled(disabled)
    }

    // MARK: - Move list

    private var moveListEntries: [MoveListEntry] {
        driver.steps.compactMap { step in
            guard step.ply > 0, let san = step.san, let uci = step.uci else { return nil }
            return MoveListEntry(ply: step.ply, san: san, uci: uci)
        }
    }

    private var currentPly: Int? {
        let ply = driver.currentStep?.ply ?? 0
        return ply > 0 ? ply : nil
    }
}

#if DEBUG
#Preview("AnalysisView — free explore") {
    NavigationStack {
        AnalysisView(fen: nil)
    }
}

#Preview("AnalysisView — game review") {
    NavigationStack {
        AnalysisView(previewDriver: .previewReview())
    }
}
#endif
