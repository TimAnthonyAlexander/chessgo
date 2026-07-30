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

/// Same slot as `ResumeBanner`, for a game this device isn't seated in yet —
/// the account got matched on the laptop while the phone sat in the lobby. All
/// we know is the time control and variant (an `activeGame` push carries no
/// board), so tapping is what fetches the game.
struct ElsewhereBanner: View {
    let notice: ActiveGameNotice
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: Theme.Spacing.md) {
                Image(systemName: "arrow.forward.circle.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(Theme.Colors.accent)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Game in progress")
                        .font(Theme.headline(15))
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text(subtitle)
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

    private var subtitle: String {
        let base = "Playing on another device"
        guard !notice.pool.isEmpty else { return base }
        if notice.variant.isEmpty || notice.variant == "standard" {
            return "\(base) · \(notice.pool)"
        }
        return "\(base) · \(notice.variant.capitalized) \(notice.pool)"
    }
}

#Preview("ResumeBanner") {
    ResumeBanner(game: .mock(), onResume: {})
        .padding(Theme.Spacing.lg)
        .background(Theme.Colors.background)
}

#Preview("ElsewhereBanner") {
    ElsewhereBanner(notice: ActiveGameNotice(id: "g1", pool: "3+0", variant: "standard"), onOpen: {})
        .padding(Theme.Spacing.lg)
        .background(Theme.Colors.background)
}
