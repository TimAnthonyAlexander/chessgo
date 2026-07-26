import SwiftUI

/// The most urgent thing Home can show: a live game already in progress.
/// Pinned above everything else when present — matches frontend-features.md
/// ("ResumeBanner at top ... most urgent thing shown").
struct ResumeBanner: View {
    let game: LiveGameState
    let onResume: () -> Void

    var body: some View {
        Button(action: onResume) {
            HStack(spacing: Theme.Spacing.md) {
                Image(systemName: "arrow.forward.circle.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(Theme.Colors.accent)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Game in progress")
                        .font(Theme.headline(15))
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text("vs \(opponentLabel)")
                        .font(Theme.caption())
                        .foregroundStyle(Theme.Colors.secondaryText)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .padding(Theme.Spacing.md)
        }
        .buttonStyle(.plain)
        .glassCard()
    }

    private var opponentLabel: String {
        game.opponent.anon ? "Guest" : (game.opponent.name.isEmpty ? "Opponent" : game.opponent.name)
    }
}

#Preview("ResumeBanner") {
    ResumeBanner(game: .mock(), onResume: {})
        .padding(Theme.Spacing.lg)
        .background(Theme.Colors.background)
}
