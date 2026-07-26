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

/// Reusable variant selector: a compact dropdown (a native `Menu`) rather than
/// a stacked list — eight variants as full rows ate ~90% of the setup screen.
/// The field shows the current pick's name + blurb; tapping opens the menu with
/// a checkmark on the active variant.
struct VariantPicker: View {
    @Binding var selection: Variant

    var body: some View {
        Menu {
            ForEach(Variant.allCases, id: \.self) { variant in
                Button {
                    selection = variant
                } label: {
                    if selection == variant {
                        Label(variant.displayName, systemImage: "checkmark")
                    } else {
                        Text(variant.displayName)
                    }
                }
            }
        } label: {
            field
        }
        .buttonStyle(.plain)
    }

    private var field: some View {
        HStack(spacing: Theme.Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text(selection.displayName)
                    .font(Theme.body(16))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(selection.oneLineDescription)
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
            }
            Spacer(minLength: Theme.Spacing.sm)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Theme.Spacing.sm)
        .padding(.horizontal, Theme.Spacing.md)
        .frame(minHeight: HomeMetrics.minTapTarget)
        .background(
            Theme.Colors.surface,
            in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .stroke(Theme.Colors.primaryText.opacity(0.08), lineWidth: 1)
        )
        .contentShape(Rectangle())
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
