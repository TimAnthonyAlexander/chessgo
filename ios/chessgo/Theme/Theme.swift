//
//  Theme.swift
//  chessgo
//
//  Design tokens: colors, spacing, radius, type. Single source of truth —
//  views compose these, they never hardcode a Color or a raw font size.
//
//  PALETTE RATIONALE
//  ------------------
//  chessgo is a chess platform, not a generic AI dashboard. The brief rules
//  out purple/indigo gradients and asks for "lean, calm, tactile, a little
//  classic." We picked a warm walnut-and-brass board room, not a screen:
//
//   - Dominant neutral: warm paper (light) / warm charcoal (dark) — never
//     pure white or pure black. Paper and dark wood, not a phone screen.
//   - One accent: antique brass/gold. It reads as a Staunton-set trophy
//     plaque, not a "brand blue." Used sparingly — primary CTAs, focus,
//     the last-move glow — so it stays meaningful instead of decorative.
//   - Board squares: ivory and walnut brown, i.e. a real wooden set,
//     instead of the teal/lilac boards every chess site now defaults to.
//   - Semantic feedback (positive/negative/warning) stays low-saturation
//     and separate from the accent so a win/loss/low-time signal never
//     gets mistaken for a call to action.
//
//  Every color adapts to light/dark via a dynamic UIColor provider, so a
//  single `Theme.Colors.x` call is correct in both appearances.
//

import SwiftUI
import UIKit

enum Theme {

    // MARK: - Colors

    enum Colors {

        /// Builds a `Color` that switches between light/dark hex values at
        /// render time (system appearance, not a stored preference).
        private static func dynamic(light: UInt32, dark: UInt32, alpha: CGFloat = 1) -> Color {
            Color(uiColor: UIColor { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(hex: dark, alpha: alpha)
                    : UIColor(hex: light, alpha: alpha)
            })
        }

        // Surfaces
        static let background       = dynamic(light: 0xFAF6EF, dark: 0x15120E)
        static let surface           = dynamic(light: 0xF2EBDC, dark: 0x1E1A14)
        static let surfaceElevated  = dynamic(light: 0xFFFFFF, dark: 0x27221A)

        // Text
        static let primaryText   = dynamic(light: 0x201C15, dark: 0xF3EEE2)
        static let secondaryText = dynamic(light: 0x6C6355, dark: 0xA79A85)

        // Accent — antique brass/gold. The one color allowed to mean "act on this."
        static let accent = dynamic(light: 0xA9793A, dark: 0xD4AA5F)

        // Semantic feedback — deliberately distinct from accent so a rating
        // delta or a clock warning never reads as a button.
        static let positive = dynamic(light: 0x3E6B49, dark: 0x6FA97D)
        static let negative = dynamic(light: 0xA23B2E, dark: 0xE07A64)
        static let warning  = dynamic(light: 0xBD7A2A, dark: 0xE0A34F)

        // Board — a real wooden set: ivory + walnut, not screen teal/lilac.
        static let boardLight     = dynamic(light: 0xEDE1C6, dark: 0xD9C9A3)
        static let boardDark      = dynamic(light: 0x9C6F4A, dark: 0x5B4230)
        static let boardHighlight = dynamic(light: 0xC9A24E, dark: 0xD4AA5F, alpha: 0.55)
        static let lastMove       = dynamic(light: 0xC9A24E, dark: 0xD4AA5F, alpha: 0.38)
        static let check          = dynamic(light: 0xB8402E, dark: 0xD9614A, alpha: 0.55)
    }

    // MARK: - Spacing

    enum Spacing {
        static let xs: CGFloat = 4
        static let sm: CGFloat = 8
        static let md: CGFloat = 16
        static let lg: CGFloat = 24
        static let xl: CGFloat = 32
    }

    // MARK: - Radius

    enum Radius {
        static let sm: CGFloat = 8
        static let md: CGFloat = 12
        static let lg: CGFloat = 20
    }

    // MARK: - Type
    //
    // One typeface (system), two weights (regular for body text, semibold
    // for anything that needs to lead). No serif, no third weight, no
    // per-screen font sizes — reach for these four instead.
    //
    // ACCESSIBILITY: these DON'T return a fixed-point `.system(size:)` — that
    // ignores the user's Dynamic Type setting entirely. Instead each requested
    // size is mapped to the nearest built-in text style, which SwiftUI scales
    // with the accessibility text-size slider. At the default (`.large`) setting
    // the resolved size stays within ~1pt of the number passed in, so every
    // existing screen looks unchanged today — but now grows for users who need
    // larger text. The passed `size` is a design intent, not a hard pixel count.

    static func title(_ size: CGFloat = 28) -> Font {
        .system(textStyle(for: size), design: .default).weight(.semibold)
    }

    static func headline(_ size: CGFloat = 20) -> Font {
        .system(textStyle(for: size), design: .default).weight(.semibold)
    }

    static func body(_ size: CGFloat = 16) -> Font {
        .system(textStyle(for: size), design: .default).weight(.regular)
    }

    static func caption(_ size: CGFloat = 13) -> Font {
        .system(textStyle(for: size), design: .default).weight(.regular)
    }

    /// Nearest system text style for a design size, by each style's default
    /// (`.large` Dynamic Type) point size. Keeps our numeric scale while
    /// handing SwiftUI a style it knows how to scale for accessibility.
    private static func textStyle(for size: CGFloat) -> Font.TextStyle {
        switch size {
        case 31...:     return .largeTitle   // 34
        case 25..<31:   return .title        // 28
        case 21..<25:   return .title2       // 22
        case 18.5..<21: return .title3       // 20
        case 16.5..<18.5: return .body       // 17
        case 15.5..<16.5: return .callout    // 16
        case 14..<15.5: return .subheadline  // 15
        case 12.5..<14: return .footnote     // 13
        case 11.5..<12.5: return .caption    // 12
        default:        return .caption2      // 11
        }
    }
}

private extension UIColor {
    /// `0xRRGGBB` → UIColor. Internal token helper only.
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        let r = CGFloat((hex >> 16) & 0xFF) / 255
        let g = CGFloat((hex >> 8) & 0xFF) / 255
        let b = CGFloat(hex & 0xFF) / 255
        self.init(red: r, green: g, blue: b, alpha: alpha)
    }
}

#Preview("Theme — Light") {
    ThemeSwatchPreview()
        .preferredColorScheme(.light)
}

#Preview("Theme — Dark") {
    ThemeSwatchPreview()
        .preferredColorScheme(.dark)
}

private struct ThemeSwatchPreview: View {
    private let swatches: [(String, Color)] = [
        ("background", Theme.Colors.background),
        ("surface", Theme.Colors.surface),
        ("surfaceElevated", Theme.Colors.surfaceElevated),
        ("accent", Theme.Colors.accent),
        ("positive", Theme.Colors.positive),
        ("negative", Theme.Colors.negative),
        ("warning", Theme.Colors.warning),
        ("boardLight", Theme.Colors.boardLight),
        ("boardDark", Theme.Colors.boardDark),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text("chessgo theme")
                    .font(Theme.title())
                    .foregroundStyle(Theme.Colors.primaryText)
                Text("Warm walnut board room, one brass accent.")
                    .font(Theme.body())
                    .foregroundStyle(Theme.Colors.secondaryText)

                VStack(spacing: Theme.Spacing.sm) {
                    ForEach(swatches, id: \.0) { name, color in
                        HStack {
                            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                .fill(color)
                                .frame(width: 44, height: 44)
                                .overlay(
                                    RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                                        .stroke(Theme.Colors.primaryText.opacity(0.08), lineWidth: 1)
                                )
                            Text(name)
                                .font(Theme.body(14))
                                .foregroundStyle(Theme.Colors.primaryText)
                            Spacer()
                        }
                    }
                }
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
            }
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.Colors.background)
    }
}
