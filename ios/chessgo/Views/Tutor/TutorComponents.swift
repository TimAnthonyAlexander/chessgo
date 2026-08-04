import SwiftUI

/// Shared display pieces for the Tutor report screens — mirrors the web's
/// `components/tutor/*.tsx` (`PeerBanner`, `ComparisonRow`, `MetricsTable`,
/// `BarCompare`, `DrillCard`), one file since each is small.

// MARK: - Peer banner

/// States plainly what a category's numbers are being compared against —
/// required per-category context, since a bare "78%" means nothing without it.
struct TutorPeerBanner: View {
    let category: TutorCategoryReport

    var body: some View {
        let peer = category.effectivePeer
        VStack(alignment: .leading, spacing: 2) {
            Text(text(for: peer))
                .font(Theme.caption(12.5))
                .foregroundStyle(Theme.Colors.secondaryText)
            Text("Based on \(category.games) of your \(category.gamesAvailable) games\(category.capHit ? " (capped)" : "").")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Spacing.sm + 4)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
    }

    private func text(for peer: TutorPeerInfo) -> String {
        switch peer.tier {
        case "widened":
            return "Compared to players rated \(peer.bandFrom)–\(peer.bandTo) (band widened for a bigger sample)."
        case "band":
            return "Compared to players rated \(peer.bandFrom)–\(peer.bandTo)."
        default:
            return "Not enough peer data to compare yet — numbers below are yours alone."
        }
    }
}

// MARK: - Comparison row (strengths / weaknesses)

/// One row in the strengths or weaknesses list. Only `.weakness` uses
/// `Theme.Colors.negative` — strengths use the site accent, never a second
/// "good" color, so the section doesn't turn into a red/green scoreboard.
struct TutorComparisonRow: View {
    enum Tone { case strength, weakness }

    let comparison: TutorComparison
    let tone: Tone

    private var valueColor: Color {
        tone == .weakness ? Theme.Colors.negative : Theme.Colors.accent
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(comparison.label)
                    .font(Theme.body(13.5))
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.Colors.primaryText)
                Spacer(minLength: Theme.Spacing.sm)
                Text(TutorFormat.value(comparison.mine, unit: comparison.unit))
                    .font(.system(size: 13, weight: .bold, design: .monospaced))
                    .foregroundStyle(valueColor)
            }
            HStack(alignment: .firstTextBaseline) {
                Text("\(comparison.wording) · peer \(TutorFormat.value(comparison.peer, unit: comparison.unit))")
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.secondaryText)
                Spacer(minLength: Theme.Spacing.sm)
                Text(sampleText)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Theme.Colors.secondaryText.opacity(0.8))
            }
        }
        .padding(.vertical, Theme.Spacing.xs + 3)
    }

    private var sampleText: String {
        var text = "\(comparison.sample) \(comparison.sample == 1 ? "game" : "games")"
        if let percentile = comparison.percentile { text += " · \(percentile)th pct" }
        return text
    }
}

// MARK: - Bar compare (phases / pieces / openings)

/// A horizontal bar comparing "yours" against a peer figure — the hand-rolled
/// chart primitive Tutor uses for breakdowns with no charting library
/// involved. The peer figure is drawn as a thin tick over the same track
/// rather than its own bar. Neutral coloring always.
struct TutorBarCompare: View {
    let label: String
    let mine: Double
    let peer: Double
    let sample: Int
    let peerSample: Int?
    let unit: String
    var showPeer: Bool = true
    /// Purely cosmetic — draws a trailing chevron when this row is the label
    /// of a `NavigationLink` (the openings breakdown drills into
    /// `TutorOpeningView`). This view has no gesture handling of its own; the
    /// wrapping `NavigationLink`/`Button` owns the tap, so it's never nested
    /// inside one of its own.
    var isLinked: Bool = false

    private var maxMagnitude: Double { max(abs(mine), abs(peer), 1e-6) }
    private var minePct: Double { min(100, abs(mine) / maxMagnitude * 100) }
    private var peerPct: Double { min(100, abs(peer) / maxMagnitude * 100) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(Theme.body(13))
                    .foregroundStyle(Theme.Colors.primaryText)
                Spacer(minLength: Theme.Spacing.sm)
                Text(valueText)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.Colors.secondaryText)
                if isLinked {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.Colors.secondaryText.opacity(0.6))
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.Colors.surface)
                    Capsule()
                        .fill(Theme.Colors.accent)
                        .frame(width: geo.size.width * CGFloat(minePct / 100))
                    if showPeer {
                        Capsule()
                            .fill(Theme.Colors.secondaryText)
                            .frame(width: 2)
                            .offset(x: geo.size.width * CGFloat(peerPct / 100) - 1)
                    }
                }
            }
            .frame(height: 6)
            Text(sampleText)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Theme.Colors.secondaryText.opacity(0.8))
        }
        .contentShape(Rectangle())
        .padding(.vertical, Theme.Spacing.xs + 2)
    }

    private var valueText: String {
        showPeer
            ? "\(TutorFormat.value(mine, unit: unit)) · peer \(TutorFormat.value(peer, unit: unit))"
            : TutorFormat.value(mine, unit: unit)
    }

    private var sampleText: String {
        var text = "\(sample) \(sample == 1 ? "game" : "games")"
        if showPeer, let peerSample { text += " · peer sample \(peerSample)" }
        return text
    }
}

// MARK: - Metrics table

/// The full metric dump for a category — every row carries its own sample
/// size, since a number without one is an argument, not a fact. Neutral
/// coloring throughout; scrolls horizontally rather than letting the page
/// itself go sideways.
struct TutorMetricsTable: View {
    let category: TutorCategoryReport

    private var noPeer: Bool { category.effectivePeer.tier == "none" }

    private var rows: [(key: String, metric: TutorMetricValue, comparison: TutorComparison?)] {
        category.metrics
            .map { key, value -> (key: String, metric: TutorMetricValue, comparison: TutorComparison?) in
                (key: key, metric: value, comparison: category.comparisons.first { $0.metric == key && $0.dimension.isEmpty })
            }
            .sorted { $0.key < $1.key }
    }

    var body: some View {
        if !rows.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: Theme.Spacing.md, verticalSpacing: 8) {
                    GridRow {
                        header("Metric")
                        header("You")
                        if !noPeer { header("Peer") }
                        header("Sample")
                    }
                    Divider()
                    ForEach(rows, id: \.key) { row in
                        GridRow {
                            Text(row.metric.label)
                                .font(Theme.body(12.5))
                                .foregroundStyle(Theme.Colors.primaryText)
                            Text(TutorFormat.value(row.metric.value, unit: row.metric.unit))
                                .font(.system(size: 12.5, design: .monospaced))
                                .foregroundStyle(Theme.Colors.secondaryText)
                            if !noPeer {
                                Text(row.comparison.map { TutorFormat.value($0.peer, unit: $0.unit) } ?? "—")
                                    .font(.system(size: 12.5, design: .monospaced))
                                    .foregroundStyle(Theme.Colors.secondaryText)
                            }
                            Text(sampleText(row))
                                .font(.system(size: 12.5, design: .monospaced))
                                .foregroundStyle(Theme.Colors.secondaryText)
                        }
                    }
                }
                .padding(.vertical, Theme.Spacing.xs)
            }
        }
    }

    private func sampleText(_ row: (key: String, metric: TutorMetricValue, comparison: TutorComparison?)) -> String {
        guard !noPeer, let comparison = row.comparison else { return "\(row.metric.sample)" }
        return "\(row.metric.sample) · peer \(comparison.peerSample)"
    }

    private func header(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(Theme.Colors.secondaryText.opacity(0.8))
    }
}

// MARK: - Section label

struct TutorSectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold, design: .monospaced))
            .tracking(1.0)
            .foregroundStyle(Theme.Colors.secondaryText.opacity(0.85))
    }
}
