import SwiftUI

/// The status/feedback strip beneath the board: what's happening right now
/// (loading/solving/checking), the solve/miss outcome with rating delta, a
/// solution reveal on a miss, and the Next/Skip + Stop controls. Plain,
/// confident copy — "Solved" / "Not quite", no exclamation points.
struct PuzzleStatusCard: View {
    let driver: PuzzleDriver
    let onNext: () -> Void
    let onStop: () -> Void

    private var terminal: Bool { driver.phase == .solved || driver.phase == .failed }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            headline

            if terminal, let rating = driver.result?.rating {
                Text("Rating \(rating.value) (\(rating.delta >= 0 ? "+" : "")\(rating.delta))")
                    .font(Theme.body(14).monospacedDigit())
                    .foregroundStyle(rating.delta >= 0 ? Theme.Colors.positive : Theme.Colors.negative)
            }

            if driver.phase == .failed, let solution = driver.result?.solution, !solution.isEmpty {
                SolutionReveal(solution: solution)
            }

            if terminal, let themes = driver.result?.themes, !themes.isEmpty {
                ThemeTags(themes: themes)
            }

            VStack(spacing: Theme.Spacing.sm) {
                Button(action: onNext) {
                    HStack {
                        Text(terminal ? "Next puzzle" : "Skip")
                        Image(systemName: terminal ? "chevron.right" : "forward.fill")
                    }
                }
                .prominentGlassButton()

                Button("Stop session", action: onStop)
                    .glassButton()
            }
        }
        .padding(Theme.Spacing.md)
        .glassCard()
    }

    @ViewBuilder
    private var headline: some View {
        switch driver.phase {
        case .loading:
            HStack(spacing: Theme.Spacing.sm) {
                ProgressView()
                Text("Loading puzzle\u{2026}")
                    .font(Theme.body(15))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        case .empty:
            Text(driver.errorMessage ?? "No puzzle found for this filter.")
                .font(Theme.body(15))
                .foregroundStyle(Theme.Colors.secondaryText)
        case .intro, .solving, .checking:
            VStack(alignment: .leading, spacing: 2) {
                Text("\(driver.orientation == .white ? "White" : "Black") to move")
                    .font(Theme.headline(19))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text("Find the best move.")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        case .solved:
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(Theme.Colors.positive)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Solved")
                        .font(Theme.headline(19))
                        .foregroundStyle(Theme.Colors.positive)
                    if driver.result?.alternative == true {
                        Text("Not the book line, but it holds.")
                            .font(Theme.caption())
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
            }
        case .failed:
            HStack(spacing: Theme.Spacing.sm) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(Theme.Colors.negative)
                Text("Not quite")
                    .font(Theme.headline(19))
                    .foregroundStyle(Theme.Colors.negative)
            }
        }
    }
}

private struct SolutionReveal: View {
    let solution: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("SOLUTION")
                .font(Theme.caption(11))
                .foregroundStyle(Theme.Colors.secondaryText)
                .tracking(1.2)
            Text(solution.joined(separator: "  "))
                .font(Theme.body(14).monospaced())
                .foregroundStyle(Theme.Colors.primaryText)
        }
        .padding(Theme.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
    }
}

private struct ThemeTags: View {
    let themes: [String]

    var body: some View {
        HStack {
            ForEach(themes.prefix(6), id: \.self) { tag in
                Text(tag)
                    .font(Theme.caption(11))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .padding(.horizontal, Theme.Spacing.sm)
                    .padding(.vertical, 3)
                    .background(Theme.Colors.surface, in: Capsule())
            }
        }
    }
}

#Preview("Status — solving") {
    PuzzleStatusCard(driver: .preview(phase: .solving), onNext: {}, onStop: {})
        .padding()
        .background(Theme.Colors.background)
}

#Preview("Status — solved") {
    PuzzleStatusCard(
        driver: .preview(
            phase: .solved,
            result: PuzzleMoveResult(correct: true, complete: true, solved: true, fen: nil,
                                      rating: PuzzleRating(value: 1650, delta: 8, games: 42))
        ),
        onNext: {},
        onStop: {}
    )
    .padding()
    .background(Theme.Colors.background)
}

#Preview("Status — failed") {
    PuzzleStatusCard(
        driver: .preview(
            phase: .failed,
            result: PuzzleMoveResult(correct: false, complete: true, solution: ["e2e4", "e7e5"], fen: nil,
                                      themes: ["fork", "middlegame"],
                                      rating: PuzzleRating(value: 1642, delta: -6, games: 43))
        ),
        onNext: {},
        onStop: {}
    )
    .padding()
    .background(Theme.Colors.background)
}
