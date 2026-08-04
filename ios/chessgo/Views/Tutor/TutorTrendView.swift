import SwiftUI

/// `/tutor/trend` — how each measured metric has moved across every report
/// you've built, grouped by category with an optional single-category
/// filter. Mirrors the web's `pages/TutorTrend.tsx`.
struct TutorTrendView: View {
    private enum Phase {
        case loading
        case failed(String)
        case loaded(TutorTrendResponse)
    }

    @State private var phase: Phase = .loading
    @State private var filter: String?

    var body: some View {
        Group {
            switch phase {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .failed(message):
                ContentUnavailableView(
                    "Couldn't load the trend.",
                    systemImage: "wifi.slash",
                    description: Text(message)
                )
            case let .loaded(data) where data.reports < 2:
                ContentUnavailableView(
                    "Build at least two reports to see a trend.",
                    systemImage: "chart.line.uptrend.xyaxis"
                )
            case let .loaded(data):
                loadedBody(data)
            }
        }
        .background(Theme.Colors.background)
        .navigationTitle("Trend")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: filter) { await load() }
    }

    private func loadedBody(_ data: TutorTrendResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Theme.Spacing.xs) {
                        filterChip(label: "All", isActive: filter == nil) { filter = nil }
                        ForEach(data.categories, id: \.self) { category in
                            filterChip(label: TutorFormat.cap(category), isActive: filter == category) {
                                filter = category
                            }
                        }
                    }
                }

                ForEach(data.categories.filter { data.series[$0] != nil }, id: \.self) { category in
                    if let metrics = data.series[category], !metrics.isEmpty {
                        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                            Text(TutorFormat.cap(category))
                                .font(Theme.headline(17))
                                .foregroundStyle(Theme.Colors.primaryText)
                            VStack(spacing: 0) {
                                ForEach(metrics.keys.sorted(), id: \.self) { key in
                                    if let series = metrics[key] {
                                        TutorTrendRow(series: series)
                                        if key != metrics.keys.sorted().last {
                                            Divider().opacity(0.3)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private func filterChip(label: String, isActive: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(isActive ? Color.white : Theme.Colors.secondaryText)
                .padding(.horizontal, Theme.Spacing.sm + 2)
                .padding(.vertical, 6)
                .background(Capsule().fill(isActive ? Theme.Colors.accent : Theme.Colors.surface))
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        phase = .loading
        do {
            let data = try await TutorService.shared.trend(category: filter)
            phase = .loaded(data)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

/// One metric's history: a small line chart (the same `Path`-based idiom as
/// `RatingSparkline`, generalized to `Double` since Tutor values can be
/// fractional percentages/centipawns) plus its net change. Direction is an
/// arrow, not a red/green verdict — a single metric drifting isn't a ranked
/// weakness the way `strengths`/`weaknesses` are.
private struct TutorTrendRow: View {
    let series: TutorTrendSeries

    private var values: [Double] { series.plottedValues }
    private var last: TutorTrendPoint? { series.points.last }

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            VStack(alignment: .leading, spacing: 4) {
                Text(series.label)
                    .font(Theme.body(13.5))
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.Colors.primaryText)
                HStack(spacing: 4) {
                    Image(systemName: series.improved ? "arrow.up" : "arrow.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(series.improved ? Theme.Colors.accent : Theme.Colors.secondaryText)
                    Text(TutorFormat.delta(series.delta, unit: series.unit))
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(series.improved ? Theme.Colors.accent : Theme.Colors.secondaryText)
                    if let last {
                        Text("· now \(TutorFormat.value(last.value ?? 0, unit: series.unit)) · \(last.sample) games")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Theme.Colors.secondaryText.opacity(0.8))
                    }
                }
                if series.mixedTiers {
                    Text("Peer tier changed between reports — raw values only.")
                        .font(.system(size: 10.5))
                        .foregroundStyle(Theme.Colors.secondaryText.opacity(0.7))
                }
            }
            Spacer(minLength: 0)
            if values.count >= 2 {
                TutorSparkline(
                    series: values,
                    color: series.improved ? Theme.Colors.accent : Theme.Colors.secondaryText
                )
            }
        }
        .padding(.vertical, Theme.Spacing.sm)
    }
}

/// `RatingSparkline`'s geometry, generalized to `[Double]` — Tutor's metric
/// values (percent/cp) are fractional, unlike a rating series.
struct TutorSparkline: View {
    let series: [Double]
    var color: Color = Theme.Colors.accent
    var width: CGFloat = 112
    var height: CGFloat = 34

    private static let pad: CGFloat = 3

    var body: some View {
        if series.count >= 2 {
            let points = normalizedPoints()
            ZStack {
                areaPath(points).fill(color.opacity(0.12))
                linePath(points)
                    .stroke(color, style: StrokeStyle(lineWidth: 1.75, lineCap: .round, lineJoin: .round))
                if let last = points.last {
                    Circle().fill(color).frame(width: 5.5, height: 5.5).position(last)
                }
            }
            .frame(width: width, height: height)
        }
    }

    private func normalizedPoints() -> [CGPoint] {
        let pad = Self.pad
        let minValue = series.min() ?? 0
        let maxValue = series.max() ?? 0
        let span = max(maxValue - minValue, 1e-6)
        let stepX = series.count > 1 ? (width - pad * 2) / CGFloat(series.count - 1) : 0

        return series.enumerated().map { index, value in
            let x = pad + CGFloat(index) * stepX
            let y = pad + (height - pad * 2) * (1 - CGFloat((value - minValue) / span))
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
    NavigationStack {
        TutorTrendView()
    }
    .environment(AuthStore.preview())
}
