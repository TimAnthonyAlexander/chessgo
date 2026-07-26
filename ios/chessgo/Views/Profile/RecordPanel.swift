import SwiftUI

/// Overall win/loss/draw record: a win-rate headline over a proportional bar,
/// with a small legend below. Takes plain counts (not a `Record` model
/// instance) so callers never need to hand-construct one of the `@Default*`-
/// wrapped models — they just read the fields off whatever they decoded.
struct RecordPanel: View {
    let wins: Int
    let losses: Int
    let draws: Int
    let total: Int

    private var winRate: Int {
        total > 0 ? Int((Double(wins) / Double(total) * 100).rounded()) : 0
    }

    private func fraction(_ n: Int) -> CGFloat {
        total > 0 ? CGFloat(n) / CGFloat(total) : 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Record")
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)

            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.xs) {
                Text("\(winRate)%")
                    .font(.system(size: 30, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.Colors.accent)
                Text("win rate · \(total) \(total == 1 ? "game" : "games")")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.Colors.surface)
                    HStack(spacing: 0) {
                        Rectangle().fill(Theme.Colors.positive).frame(width: geo.size.width * fraction(wins))
                        Rectangle().fill(Theme.Colors.secondaryText.opacity(0.35)).frame(width: geo.size.width * fraction(draws))
                        Rectangle().fill(Theme.Colors.negative).frame(width: geo.size.width * fraction(losses))
                    }
                    .clipShape(Capsule())
                }
            }
            .frame(height: 10)

            HStack(spacing: Theme.Spacing.md) {
                legend(color: Theme.Colors.positive, label: "Wins", value: wins)
                legend(color: Theme.Colors.secondaryText, label: "Draws", value: draws)
                legend(color: Theme.Colors.negative, label: "Losses", value: losses)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    private func legend(color: Color, label: String, value: Int) -> some View {
        HStack(spacing: Theme.Spacing.xs) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(color)
                .frame(width: 8, height: 8)
            Text("\(value)")
                .font(.system(size: 13, weight: .bold, design: .monospaced))
                .foregroundStyle(Theme.Colors.primaryText)
            Text(label)
                .font(Theme.caption(11.5))
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }
}

#Preview {
    VStack(spacing: 16) {
        RecordPanel(wins: 42, losses: 20, draws: 8, total: 70)
        RecordPanel(wins: 0, losses: 0, draws: 0, total: 0)
    }
    .padding()
    .background(Theme.Colors.background)
}
