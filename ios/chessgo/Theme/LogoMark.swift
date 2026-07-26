import SwiftUI

/// The chessgo brand mark — a geometric knight silhouette, the same shape the
/// web uses for its favicon and navbar logo (`frontend/src/components/Logo.tsx`,
/// `KNIGHT_PATH`). Drawn as a `Canvas` from the identical 64×64 path so it stays
/// crisp at any size and tints with the brass accent. The eye is punched out in
/// the background color, matching the web mark.
struct LogoMark: View {
    var size: CGFloat = 24
    var tint: Color = Theme.Colors.accent
    /// The color the eye is cut out in — should match whatever sits behind the
    /// mark so it reads as a notch (default: the app background).
    var eye: Color = Theme.Colors.background

    /// The knight outline on a 64×64 grid — a straight port of `KNIGHT_PATH`
    /// (one move + a run of lines, closed). Facing left.
    private static let points: [CGPoint] = [
        CGPoint(x: 42, y: 5.5), CGPoint(x: 47.5, y: 15), CGPoint(x: 49, y: 24),
        CGPoint(x: 50.5, y: 34), CGPoint(x: 51, y: 50), CGPoint(x: 53.5, y: 50),
        CGPoint(x: 53.5, y: 57.5), CGPoint(x: 15, y: 57.5), CGPoint(x: 15, y: 50),
        CGPoint(x: 25.5, y: 50), CGPoint(x: 27, y: 41), CGPoint(x: 18.5, y: 38),
        CGPoint(x: 10.5, y: 35), CGPoint(x: 8.5, y: 28.5), CGPoint(x: 15, y: 26.5),
        CGPoint(x: 21, y: 24), CGPoint(x: 24, y: 18.5), CGPoint(x: 28, y: 13.5),
        CGPoint(x: 35, y: 8.5),
    ]

    var body: some View {
        Canvas { context, canvasSize in
            let s = canvasSize.width / 64

            var knight = Path()
            knight.move(to: scaled(Self.points[0], s))
            for point in Self.points.dropFirst() {
                knight.addLine(to: scaled(point, s))
            }
            knight.closeSubpath()
            context.fill(knight, with: .color(tint))

            let r: CGFloat = 2.1 * s
            let eyeRect = CGRect(x: 30.5 * s - r, y: 21 * s - r, width: r * 2, height: r * 2)
            context.fill(Path(ellipseIn: eyeRect), with: .color(eye))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func scaled(_ p: CGPoint, _ s: CGFloat) -> CGPoint {
        CGPoint(x: p.x * s, y: p.y * s)
    }
}

#Preview("LogoMark") {
    HStack(spacing: Theme.Spacing.md) {
        LogoMark(size: 22)
        LogoMark(size: 32)
        LogoMark(size: 48)
    }
    .padding(Theme.Spacing.lg)
    .background(Theme.Colors.background)
}
