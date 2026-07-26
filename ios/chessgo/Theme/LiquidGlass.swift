//
//  LiquidGlass.swift
//  chessgo
//
//  Fallback-aware Liquid Glass (iOS 26) primitives. SINGLE SOURCE OF TRUTH.
//
//  Deployment target is iOS 18.0, but every Liquid Glass API (`glassEffect`,
//  `.buttonStyle(.glass)`, `.glassProminent`) is iOS 26+. So glass is never
//  called raw — it always goes through the helpers below, gated behind
//  `#available(iOS 26.0, *)` with a frosted `.ultraThinMaterial` + hairline
//  stroke fallback beneath it. Feature views compose these; they don't
//  redefine their own glass wrappers.
//
//  Note: the Simulator does not render specular highlights — validate the
//  real glass path on device.
//

import SwiftUI

// MARK: - Low-level fallback wrapper

extension View {
    /// Glass material in `shape` on iOS 26+, frosted material + hairline
    /// stroke below it. Reach for `glassCard()` / button styles first —
    /// use this directly only for one-off shapes those don't cover.
    @ViewBuilder
    func glassed(in shape: some Shape = Capsule(), interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            let glass: Glass = interactive ? .regular.interactive() : .regular
            self.glassEffect(glass, in: shape)
        } else {
            self.background(
                shape.fill(.ultraThinMaterial)
                    .overlay(shape.stroke(Color.white.opacity(0.20), lineWidth: 1))
            )
        }
    }
}

// MARK: - Glass card surface

extension View {
    /// Content-card surface: glass on iOS 26+, a flat elevated-surface fill
    /// with a hairline stroke below it. Apply last in the modifier chain,
    /// after your own padding.
    @ViewBuilder
    func glassCard(cornerRadius: CGFloat = Theme.Radius.lg) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, *) {
            self
                .padding(Theme.Spacing.md)
                .glassEffect(.regular, in: shape)
        } else {
            self
                .padding(Theme.Spacing.md)
                .background(Theme.Colors.surfaceElevated, in: shape)
                .overlay(shape.stroke(Theme.Colors.primaryText.opacity(0.06), lineWidth: 1))
        }
    }
}

// MARK: - Button styles (fallback-aware)

/// Filled CTA look used below iOS 26 — the `.glassProminent` fallback.
struct FilledCapsuleButtonStyle: ButtonStyle {
    var tint: Color = Theme.Colors.accent

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.headline(16))
            .foregroundStyle(.white)
            .padding(.vertical, 14)
            .padding(.horizontal, Theme.Spacing.md)
            .frame(maxWidth: .infinity)
            .background(tint, in: Capsule())
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// Translucent secondary-action look used below iOS 26 — the `.glass`
/// fallback for non-prominent buttons (cancel, secondary picks, chips).
struct GlassCapsuleButtonStyle: ButtonStyle {
    var tint: Color = Theme.Colors.primaryText

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.body(16))
            .foregroundStyle(tint)
            .padding(.vertical, 14)
            .padding(.horizontal, Theme.Spacing.md)
            .frame(maxWidth: .infinity)
            .glassed(in: Capsule())
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

extension View {
    /// Primary CTA: opaque tinted `.glassProminent` on iOS 26+, a filled
    /// brass capsule below it. Apply to a `Button`.
    @ViewBuilder
    func prominentGlassButton(tint: Color = Theme.Colors.accent) -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glassProminent).tint(tint)
        } else {
            self.buttonStyle(FilledCapsuleButtonStyle(tint: tint))
        }
    }

    /// Secondary action: translucent `.buttonStyle(.glass)` on iOS 26+, a
    /// legacy translucent capsule below it. Apply to a `Button`.
    @ViewBuilder
    func glassButton() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glass)
        } else {
            self.buttonStyle(GlassCapsuleButtonStyle())
        }
    }
}

// MARK: - Previews

#Preview("Liquid Glass — Light") {
    LiquidGlassPreview()
        .preferredColorScheme(.light)
}

#Preview("Liquid Glass — Dark") {
    LiquidGlassPreview()
        .preferredColorScheme(.dark)
}

private struct LiquidGlassPreview: View {
    var body: some View {
        VStack(spacing: Theme.Spacing.lg) {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text("Ruy Lopez, move 14")
                    .font(Theme.headline())
                    .foregroundStyle(Theme.Colors.primaryText)
                Text("White to move. Engine eval +0.6.")
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard()

            Button("Start game") {}
                .prominentGlassButton()

            Button("Resign") {}
                .glassButton()
        }
        .padding(Theme.Spacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.background)
    }
}
