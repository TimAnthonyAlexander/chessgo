import SwiftUI

/// One-line blurbs shown next to each variant so a first-time player knows
/// what they're picking without leaving the setup screen.
extension Variant {
    var oneLineDescription: String {
        switch self {
        case .standard: return "Classic chess, no twists."
        case .chess960: return "Randomized back rank, same rules."
        case .duck: return "A duck blocks one square each turn."
        case .crazyhouse: return "Captures go to your pocket — drop them back in."
        case .antichess: return "Captures are forced. Lose every piece to win."
        case .fading: return "The bot gets weaker every move it makes."
        case .glassjaw: return "The bot is strong until you land a check, then it wilts."
        case .doublemove: return "Each side plays two moves in a row."
        }
    }
}

/// Reusable variant selector: a vertical list of rows, each the variant name
/// plus its blurb, with the current pick checked. Deliberately not a
/// segmented control — eight items with real descriptions read better as a
/// list than as cramped equal-width segments.
struct VariantPicker: View {
    @Binding var selection: Variant

    var body: some View {
        VStack(spacing: Theme.Spacing.xs) {
            ForEach(Variant.allCases, id: \.self) { variant in
                row(for: variant)
            }
        }
    }

    private func row(for variant: Variant) -> some View {
        let isSelected = selection == variant
        return Button {
            selection = variant
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(variant.displayName)
                        .font(Theme.body(16))
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text(variant.oneLineDescription)
                        .font(Theme.caption(12))
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                Spacer(minLength: Theme.Spacing.sm)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Theme.Colors.accent)
                }
            }
            .padding(.vertical, Theme.Spacing.sm)
            .padding(.horizontal, Theme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                    .fill(isSelected ? Theme.Colors.surface : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

#Preview("VariantPicker") {
    VariantPickerPreview()
}

private struct VariantPickerPreview: View {
    @State private var selection: Variant = .standard

    var body: some View {
        ScrollView {
            VariantPicker(selection: $selection)
                .padding(Theme.Spacing.lg)
        }
        .background(Theme.Colors.background)
    }
}
