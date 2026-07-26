import Foundation
import SwiftUI

/// The `running` mode screen: the board plus the status/feedback strip below
/// it. Theme/time format are locked for the session (`PuzzlesView` set them
/// when starting); this view only renders what the driver reports.
struct PuzzleSessionScreen: View {
    let driver: PuzzleDriver
    let theme: PuzzleTheme
    let timeFormat: PuzzleTimeFormat
    let remainingMs: Int
    let history: [PuzzleOutcome]
    let onNext: () -> Void
    let onStop: () -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                topBar

                BoardView(control: driver)
                    .aspectRatio(1, contentMode: .fit)
                    .padding(.horizontal, Theme.Spacing.md)

                PuzzleStatusCard(driver: driver, onNext: onNext, onStop: onStop)
                    .padding(.horizontal, Theme.Spacing.md)

                if !history.isEmpty {
                    PuzzleHistoryStrip(history: history)
                        .padding(.horizontal, Theme.Spacing.md)
                }
            }
            .padding(.vertical, Theme.Spacing.md)
        }
    }

    private var topBar: some View {
        HStack {
            clockView
            Spacer()
            themeChip
        }
        .padding(.horizontal, Theme.Spacing.md)
    }

    private var clockView: some View {
        let lowTime = timeFormat.seconds != nil && remainingMs <= 10_000
        return HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: timeFormat.seconds == nil ? "infinity" : "clock")
            if timeFormat.seconds != nil {
                Text(Self.format(ms: remainingMs))
                    .font(Theme.headline(20).monospacedDigit())
            } else {
                Text("Untimed")
                    .font(Theme.body(15))
            }
        }
        .foregroundStyle(lowTime ? Theme.Colors.negative : Theme.Colors.secondaryText)
    }

    private var themeChip: some View {
        Text(theme.label)
            .font(Theme.caption())
            .foregroundStyle(Theme.Colors.secondaryText)
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.vertical, 4)
            .background(Theme.Colors.surface, in: Capsule())
    }

    private static func format(ms: Int) -> String {
        let totalSeconds = max(0, ms) / 1_000
        return String(format: "%d:%02d", totalSeconds / 60, totalSeconds % 60)
    }
}

#Preview("Session — solving") {
    NavigationStack {
        PuzzleSessionScreen(
            driver: .preview(phase: .solving),
            theme: .fork,
            timeFormat: .blitz,
            remainingMs: 47_000,
            history: [PuzzleOutcome(win: true, delta: 8)],
            onNext: {},
            onStop: {}
        )
        .background(Theme.Colors.background)
    }
}

#Preview("Session — low time") {
    NavigationStack {
        PuzzleSessionScreen(
            driver: .preview(phase: .solving),
            theme: .all,
            timeFormat: .sprint,
            remainingMs: 6_400,
            history: [],
            onNext: {},
            onStop: {}
        )
        .background(Theme.Colors.background)
    }
}

#Preview("Session — untimed") {
    NavigationStack {
        PuzzleSessionScreen(
            driver: .preview(phase: .solving),
            theme: .endgame,
            timeFormat: .untimed,
            remainingMs: 0,
            history: [],
            onNext: {},
            onStop: {}
        )
        .background(Theme.Colors.background)
    }
}
