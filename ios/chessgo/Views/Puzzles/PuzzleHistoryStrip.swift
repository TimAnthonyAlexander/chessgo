import SwiftUI

/// Small win/loss chips for the current session, newest first.
struct PuzzleHistoryStrip: View {
    let history: [PuzzleOutcome]

    private var wins: Int { history.filter(\.win).count }
    private var losses: Int { history.count - wins }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack {
                Text("HISTORY")
                    .font(Theme.caption(11))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .tracking(1.2)
                Spacer()
                Text("\(wins)W \u{00B7} \(losses)L")
                    .font(Theme.caption(12).monospacedDigit())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.xs) {
                    ForEach(history.reversed()) { outcome in
                        chip(for: outcome)
                    }
                }
            }
        }
        .padding(Theme.Spacing.md)
        .glassCard()
    }

    private func chip(for outcome: PuzzleOutcome) -> some View {
        HStack(spacing: 3) {
            Image(systemName: outcome.win ? "checkmark" : "xmark")
            if let delta = outcome.delta {
                Text("\(delta >= 0 ? "+" : "")\(delta)")
            }
        }
        .font(Theme.caption(11).monospacedDigit().weight(.semibold))
        .foregroundStyle(outcome.win ? Theme.Colors.positive : Theme.Colors.negative)
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, 5)
        .background(
            (outcome.win ? Theme.Colors.positive : Theme.Colors.negative).opacity(0.14),
            in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
        )
    }
}

#Preview("History strip") {
    PuzzleHistoryStrip(history: [
        PuzzleOutcome(win: true, delta: 8),
        PuzzleOutcome(win: false, delta: -5),
        PuzzleOutcome(win: true, delta: 6),
        PuzzleOutcome(win: true, delta: nil),
    ])
    .padding()
    .background(Theme.Colors.background)
}
