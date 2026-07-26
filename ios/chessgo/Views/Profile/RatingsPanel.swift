import SwiftUI

/// One row per rating pool: bullet/blitz/rapid/classical (the most-played one
/// highlighted) plus puzzle/duck/antichess below a divider. Takes plain row
/// data rather than `RatingSnapshot`/`PuzzleSnapshot` instances, so the caller
/// reads fields off whatever it decoded instead of hand-constructing a
/// `@Default*`-wrapped model.
struct RatingsPanel: View {
    struct Row: Identifiable {
        let id: String
        let icon: String // SF Symbol name
        let label: String
        let rating: Int
        let games: Int
        let provisional: Bool
        /// Custom subtitle (e.g. puzzle W/L split); `nil` falls back to "N games".
        let sub: String?
        let highlighted: Bool
    }

    let rows: [Row]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Ratings")
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)

            VStack(spacing: Theme.Spacing.xs) {
                ForEach(rows) { row in
                    rowView(row)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    private func rowView(_ row: Row) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Image(systemName: row.icon)
                .font(.system(size: 14))
                .foregroundStyle(row.highlighted ? Theme.Colors.accent : Theme.Colors.secondaryText)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 1) {
                Text(row.label)
                    .font(Theme.body(13.5))
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(row.sub ?? "\(row.games) \(row.games == 1 ? "game" : "games")")
                    .font(Theme.caption(11))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            Spacer()

            RatingBadge(rating: row.rating, provisional: row.provisional)
        }
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, Theme.Spacing.xs + 2)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                .fill(row.highlighted ? Theme.Colors.accent.opacity(0.10) : .clear)
        )
    }
}

#Preview {
    RatingsPanel(rows: [
        .init(id: "bullet", icon: "bolt.fill", label: "Bullet", rating: 1180, games: 12, provisional: true, sub: nil, highlighted: false),
        .init(id: "blitz", icon: "bolt.circle.fill", label: "Blitz", rating: 1450, games: 62, provisional: false, sub: nil, highlighted: true),
        .init(id: "rapid", icon: "hare.fill", label: "Rapid", rating: 1502, games: 31, provisional: false, sub: nil, highlighted: false),
        .init(id: "classical", icon: "tortoise.fill", label: "Classical", rating: 0, games: 0, provisional: false, sub: nil, highlighted: false),
        .init(id: "puzzle", icon: "puzzlepiece.fill", label: "Puzzles", rating: 1600, games: 300, provisional: false, sub: "210W 90L", highlighted: false),
        .init(id: "duck", icon: "bird.fill", label: "Duck", rating: 1300, games: 5, provisional: true, sub: nil, highlighted: false),
    ])
    .padding()
    .background(Theme.Colors.background)
}
