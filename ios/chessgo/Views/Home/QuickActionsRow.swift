import SwiftUI

/// The four primary modes as one glanceable row, right under `IdentityHeader`.
/// Computer/Puzzles/Analysis/Friend — the modes buried below the fold before
/// this redesign, with Analysis getting its first entry point anywhere in the
/// app. Assumes it's rendered inside a `NavigationStack` (the caller — Home —
/// provides one).
struct QuickActionsRow: View {
    let onChallenge: () -> Void

    private let columns = Array(repeating: GridItem(.flexible(), spacing: Theme.Spacing.sm), count: 4)

    var body: some View {
        LazyVGrid(columns: columns, spacing: Theme.Spacing.sm) {
            NavigationLink {
                BotSetupView()
            } label: {
                cell(title: "Computer", systemImage: "cpu")
            }
            .buttonStyle(.plain)

            NavigationLink {
                PuzzlesView()
            } label: {
                cell(title: "Puzzles", systemImage: "puzzlepiece.fill")
            }
            .buttonStyle(.plain)

            NavigationLink {
                AnalysisView()
            } label: {
                cell(title: "Analysis", systemImage: "chart.line.uptrend.xyaxis")
            }
            .buttonStyle(.plain)

            Button(action: onChallenge) {
                cell(title: "Friend", systemImage: "person.2.fill")
            }
            .buttonStyle(.plain)
        }
    }

    private func cell(title: String, systemImage: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.system(size: 20))
                .foregroundStyle(Theme.Colors.accent)
            Text(title)
                .font(Theme.headline(12))
                .foregroundStyle(Theme.Colors.primaryText)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity, minHeight: HomeMetrics.minTapTarget)
        .padding(.vertical, Theme.Spacing.sm)
        .glassed(in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isButton)
    }
}

#Preview("QuickActionsRow") {
    NavigationStack {
        ScrollView {
            QuickActionsRow(onChallenge: {})
                .padding(Theme.Spacing.lg)
        }
        .background(Theme.Colors.background)
    }
    .environment(AuthStore.preview())
}
