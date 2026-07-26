import SwiftUI

/// The `over` mode card: session summary (solved/missed/net rating) plus
/// Play again / Change actions.
struct PuzzleSummaryScreen: View {
    let history: [PuzzleOutcome]
    let theme: PuzzleTheme
    let timeFormat: PuzzleTimeFormat
    let isSignedIn: Bool
    let onPlayAgain: () -> Void
    let onChangeSettings: () -> Void

    private var wins: Int { history.filter(\.win).count }
    private var losses: Int { history.count - wins }
    private var net: Int { history.reduce(0) { $0 + ($1.delta ?? 0) } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                header

                HStack(spacing: Theme.Spacing.sm) {
                    stat(value: "\(wins)", label: "Solved", color: Theme.Colors.positive)
                    stat(value: "\(losses)", label: "Missed", color: Theme.Colors.negative)
                    if isSignedIn {
                        stat(
                            value: "\(net >= 0 ? "+" : "")\(net)",
                            label: "Rating",
                            color: net >= 0 ? Theme.Colors.positive : Theme.Colors.negative
                        )
                    }
                }

                if !history.isEmpty {
                    PuzzleHistoryStrip(history: history)
                }

                VStack(spacing: Theme.Spacing.sm) {
                    Button {
                        onPlayAgain()
                    } label: {
                        Label("Play again", systemImage: "arrow.counterclockwise")
                    }
                    .prominentGlassButton()

                    Button {
                        onChangeSettings()
                    } label: {
                        Label("Change theme or time", systemImage: "slider.horizontal.3")
                    }
                    .glassButton()
                }
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(Theme.Colors.accent.opacity(0.14))
                Image(systemName: "trophy.fill")
                    .foregroundStyle(Theme.Colors.accent)
            }
            .frame(width: 40, height: 40)

            VStack(alignment: .leading, spacing: 2) {
                Text("Session complete")
                    .font(Theme.title(22))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text("\(theme.label) \u{00B7} \(timeFormat.tag)")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    private func stat(value: String, label: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(Theme.headline(24).monospacedDigit())
                .foregroundStyle(color)
            Text(label.uppercased())
                .font(Theme.caption(10))
                .foregroundStyle(Theme.Colors.secondaryText)
                .tracking(1.0)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Spacing.sm + 4)
        .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
    }
}

#Preview("Summary") {
    NavigationStack {
        PuzzleSummaryScreen(
            history: [
                PuzzleOutcome(win: true, delta: 8),
                PuzzleOutcome(win: false, delta: -5),
                PuzzleOutcome(win: true, delta: 6),
                PuzzleOutcome(win: true, delta: 7),
            ],
            theme: .fork,
            timeFormat: .blitz,
            isSignedIn: true,
            onPlayAgain: {},
            onChangeSettings: {}
        )
        .background(Theme.Colors.background)
    }
}

#Preview("Summary — guest, no history") {
    NavigationStack {
        PuzzleSummaryScreen(
            history: [],
            theme: .all,
            timeFormat: .untimed,
            isSignedIn: false,
            onPlayAgain: {},
            onChangeSettings: {}
        )
        .background(Theme.Colors.background)
    }
}
