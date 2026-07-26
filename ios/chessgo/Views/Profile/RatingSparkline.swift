import SwiftUI

/// A tiny rating-trend line: a normalized polyline with a soft area fill and
/// an endpoint dot, drawn as a SwiftUI `Path`. Mirrors the geometry of the
/// web's `RatingSparkline.tsx`. Renders nothing for fewer than 2 points.
struct RatingSparkline: View {
    let series: [Int]
    var color: Color = Theme.Colors.accent
    var width: CGFloat = 128
    var height: CGFloat = 40

    private static let pad: CGFloat = 3

    var body: some View {
        if series.count >= 2 {
            let points = normalizedPoints()
            ZStack {
                areaPath(points)
                    .fill(color.opacity(0.12))
                linePath(points)
                    .stroke(color, style: StrokeStyle(lineWidth: 1.75, lineCap: .round, lineJoin: .round))
                if let last = points.last {
                    Circle()
                        .fill(color)
                        .frame(width: 5.5, height: 5.5)
                        .position(last)
                }
            }
            .frame(width: width, height: height)
        }
    }

    private func normalizedPoints() -> [CGPoint] {
        let pad = Self.pad
        let minValue = CGFloat(series.min() ?? 0)
        let maxValue = CGFloat(series.max() ?? 0)
        let span = max(maxValue - minValue, 1)
        let stepX = series.count > 1 ? (width - pad * 2) / CGFloat(series.count - 1) : 0

        return series.enumerated().map { index, value in
            let x = pad + CGFloat(index) * stepX
            let y = pad + (height - pad * 2) * (1 - (CGFloat(value) - minValue) / span)
            return CGPoint(x: x, y: y)
        }
    }

    private func linePath(_ points: [CGPoint]) -> Path {
        var path = Path()
        guard let first = points.first else { return path }
        path.move(to: first)
        for point in points.dropFirst() { path.addLine(to: point) }
        return path
    }

    private func areaPath(_ points: [CGPoint]) -> Path {
        var path = linePath(points)
        guard let first = points.first, let last = points.last else { return path }
        path.addLine(to: CGPoint(x: last.x, y: height - Self.pad))
        path.addLine(to: CGPoint(x: first.x, y: height - Self.pad))
        path.closeSubpath()
        return path
    }
}

#Preview {
    VStack(spacing: 20) {
        RatingSparkline(series: [1400, 1420, 1390, 1450, 1470, 1462, 1500])
        RatingSparkline(series: [1500, 1480, 1420, 1390], color: Theme.Colors.negative)
        RatingSparkline(series: [1200]) // fewer than 2 points — renders nothing
    }
    .padding()
    .background(Theme.Colors.background)
}
