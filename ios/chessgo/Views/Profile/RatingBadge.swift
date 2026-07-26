import SwiftUI

/// A rating number with a provisional "?" suffix, monospaced for column
/// alignment across the ratings panel, leaderboard rows, and the profile
/// hero's headline call-out.
struct RatingBadge: View {
    let rating: Int
    var provisional: Bool = false
    var size: CGFloat = 18
    var color: Color = Theme.Colors.primaryText

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 1) {
            Text("\(rating)")
                .font(.system(size: size, weight: .bold, design: .monospaced))
                .foregroundStyle(color)
            if provisional {
                Text("?")
                    .font(.system(size: size * 0.72, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }
}

#Preview {
    VStack(alignment: .leading, spacing: 12) {
        RatingBadge(rating: 1450)
        RatingBadge(rating: 900, provisional: true)
        RatingBadge(rating: 2100, size: 34, color: Theme.Colors.accent)
    }
    .padding()
    .background(Theme.Colors.background)
}
