import SwiftUI

/// `/tutor/:reportId` — one built report: the headline, an optional theme
/// profile, a category picker, and that category's full breakdown. Mirrors
/// the web's `pages/TutorReport.tsx` + `components/tutor/CategorySection.tsx`.
struct TutorReportView: View {
    let reportId: String

    private enum Phase {
        case loading
        case notFound
        case failed(String)
        case loaded(TutorReportSummary, TutorPayload)
    }

    @State private var phase: Phase = .loading
    @State private var active: String?

    var body: some View {
        Group {
            switch phase {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .notFound:
                ContentUnavailableView("Report not found.", systemImage: "doc.questionmark")
            case let .failed(message):
                ContentUnavailableView(
                    "Couldn't load this report.",
                    systemImage: "wifi.slash",
                    description: Text(message)
                )
            case let .loaded(report, payload):
                loadedBody(report, payload)
            }
        }
        .background(Theme.Colors.background)
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: reportId) { await load() }
    }

    private var navigationTitle: String {
        if case let .loaded(report, _) = phase, !report.rangeLabel.isEmpty { return "Tutor · \(report.rangeLabel)" }
        return "Tutor"
    }

    // MARK: - Loaded

    @ViewBuilder
    private func loadedBody(_ report: TutorReportSummary, _ payload: TutorPayload) -> some View {
        if report.statusKind != .ready {
            ContentUnavailableView(statusMessage(report), systemImage: "hourglass")
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    headlineBlock(payload, report)

                    if let themeProfile = payload.themeProfile, !themeProfile.themes.isEmpty {
                        themeProfileBlock(themeProfile)
                    }

                    if !payload.categories.isEmpty || !payload.insufficient.isEmpty {
                        categoryPicker(payload)
                    }

                    if let key = active, let category = payload.categories[key] {
                        TutorCategorySection(category: category, reportId: reportId)
                    } else if !payload.categories.isEmpty {
                        Text("Pick a category to see its breakdown.")
                            .font(Theme.body(14))
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                .padding(Theme.Spacing.lg)
            }
        }
    }

    private func statusMessage(_ report: TutorReportSummary) -> String {
        switch report.statusKind {
        case .failed: return report.error ?? "This report failed to build."
        case .insufficient: return "There weren't enough games in this range to build a report."
        default: return "This report is still building."
        }
    }

    // MARK: - Headline

    @ViewBuilder
    private func headlineBlock(_ payload: TutorPayload, _ report: TutorReportSummary) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            if let headline = payload.headline, !headline.text.isEmpty {
                Text(headline.text)
                    .font(Theme.title(22))
                    .foregroundStyle(Theme.Colors.primaryText)
                HStack(spacing: Theme.Spacing.lg) {
                    statTile(label: "You", value: plainNumber(headline.mine))
                    statTile(label: "Peer", value: plainNumber(headline.peer))
                    Text("\(headline.sample) games · \(TutorFormat.cap(headline.category))")
                        .font(Theme.caption(12))
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            } else {
                Text("Not enough data yet for a headline.")
                    .font(Theme.headline(18))
                    .foregroundStyle(Theme.Colors.primaryText)
            }

            Text(rangeCaption(payload, report))
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private func rangeCaption(_ payload: TutorPayload, _ report: TutorReportSummary) -> String {
        var text = "\(TutorFormat.date(payload.rangeFrom ?? report.rangeFrom)) – \(TutorFormat.date(payload.rangeTo ?? report.rangeTo))"
        text += " · \(report.gamesUsed) of \(report.gamesConsidered) games"
        if report.capHit { text += " (capped)" }
        if let builtAt = report.builtAt { text += " · built \(TutorFormat.date(builtAt))" }
        return text
    }

    private func statTile(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(Theme.Colors.secondaryText.opacity(0.8))
            Text(value)
                .font(Theme.headline(20))
                .foregroundStyle(Theme.Colors.primaryText)
        }
    }

    /// The headline carries no `unit`, unlike `TutorComparison` — round to one
    /// decimal only when it isn't already a whole number.
    private func plainNumber(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
    }

    // MARK: - Theme profile (player-level puzzle solve rates)

    private func themeProfileBlock(_ profile: TutorThemeProfile) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            TutorSectionLabel(text: "Puzzle themes")
            Text(profile.note.isEmpty ? "From your puzzle history — no peer comparison, own numbers only." : profile.note)
                .font(Theme.caption(11.5))
                .foregroundStyle(Theme.Colors.secondaryText)

            VStack(spacing: 0) {
                ForEach(profile.themes.sorted { $0.rate < $1.rate }.prefix(8)) { entry in
                    HStack {
                        Text(TutorFormat.themeLabel(entry.theme))
                            .font(Theme.body(13))
                            .foregroundStyle(Theme.Colors.primaryText)
                        Spacer()
                        Text("\(entry.solved)/\(entry.attempts) · \(TutorFormat.value(entry.rate, unit: "percent"))")
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    .padding(.vertical, Theme.Spacing.xs + 2)
                    if entry.id != profile.themes.sorted(by: { $0.rate < $1.rate }).prefix(8).last?.id {
                        Divider().opacity(0.3)
                    }
                }
            }
        }
        .glassCard()
    }

    // MARK: - Category picker

    private func categoryPicker(_ payload: TutorPayload) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.sm) {
                    ForEach(payload.orderedCategoryKeys, id: \.self) { key in
                        categoryChip(key, category: payload.categories[key])
                    }
                }
            }

            if !payload.insufficient.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(payload.insufficient.keys.sorted(), id: \.self) { key in
                        if let info = payload.insufficient[key] {
                            Text("\(TutorFormat.cap(key)): \(info.games) of \(info.games + info.need) games. Play \(info.need) more.")
                                .font(Theme.caption(11.5))
                                .foregroundStyle(Theme.Colors.secondaryText.opacity(0.7))
                        }
                    }
                }
            }
        }
    }

    private func categoryChip(_ key: String, category: TutorCategoryReport?) -> some View {
        let isActive = key == active
        return Button {
            active = key
        } label: {
            VStack(spacing: 1) {
                Text(TutorFormat.cap(key))
                    .font(.system(size: 13, weight: .semibold))
                Text("\(category?.games ?? 0) games")
                    .font(.system(size: 10.5, design: .monospaced))
            }
            .foregroundStyle(isActive ? Theme.Colors.accent : Theme.Colors.primaryText)
            .padding(.horizontal, Theme.Spacing.sm + 2)
            .padding(.vertical, Theme.Spacing.xs + 2)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                    .fill(isActive ? Theme.Colors.accent.opacity(0.14) : Theme.Colors.surface)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Load

    private func load() async {
        phase = .loading
        active = nil
        do {
            let response = try await TutorService.shared.report(id: reportId)
            phase = .loaded(response.report, response.payload)
            active = response.payload.orderedCategoryKeys.first
        } catch let error as APIError where error.statusCode == 404 {
            phase = .notFound
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

// MARK: - One category's full breakdown

/// Mirrors `components/tutor/CategorySection.tsx`.
private struct TutorCategorySection: View {
    let category: TutorCategoryReport
    let reportId: String

    private var noPeer: Bool { category.effectivePeer.tier == "none" }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            TutorPeerBanner(category: category)

            if !noPeer, !category.strengths.isEmpty {
                strengthsWeaknesses(title: "Strengths", rows: category.strengths, tone: .strength)
            }
            if !noPeer, !category.weaknesses.isEmpty {
                strengthsWeaknesses(title: "Weaknesses", rows: category.weaknesses, tone: .weakness)
            }

            if !category.weaknesses.isEmpty {
                VStack(spacing: Theme.Spacing.md) {
                    ForEach(Array(category.weaknesses.enumerated()), id: \.offset) { _, weakness in
                        if let drill = category.drill(for: weakness) {
                            TutorDrillCardView(drill: drill)
                        }
                    }
                }
            }

            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                TutorSectionLabel(text: "All metrics")
                TutorMetricsTable(category: category)
            }

            breakdownGroup(title: "Phases", items: category.phases)
            breakdownGroup(title: "Pieces", items: category.pieces)
            openingsGroup(title: "As White", items: category.openingsWhite, color: "w")
            openingsGroup(title: "As Black", items: category.openingsBlack, color: "b")
        }
    }

    private func strengthsWeaknesses(
        title: String,
        rows: [TutorComparison],
        tone: TutorComparisonRow.Tone
    ) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            TutorSectionLabel(text: title)
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, comparison in
                    TutorComparisonRow(comparison: comparison, tone: tone)
                    if index < rows.count - 1 { Divider().opacity(0.3) }
                }
            }
        }
    }

    @ViewBuilder
    private func breakdownGroup(title: String, items: [TutorComparison]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                TutorSectionLabel(text: title)
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        TutorBarCompare(
                            label: item.name ?? TutorFormat.cap(item.dimension),
                            mine: item.mine,
                            peer: item.peer,
                            sample: item.sample,
                            peerSample: item.peerSample,
                            unit: item.unit,
                            showPeer: !noPeer
                        )
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func openingsGroup(title: String, items: [TutorComparison], color: String) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                TutorSectionLabel(text: title)
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                        NavigationLink {
                            TutorOpeningView(
                                reportId: reportId,
                                category: category.category,
                                color: color,
                                family: openingFamily(item)
                            )
                        } label: {
                            TutorBarCompare(
                                label: item.name ?? TutorFormat.cap(openingFamily(item)),
                                mine: item.mine,
                                peer: item.peer,
                                sample: item.sample,
                                peerSample: item.peerSample,
                                unit: item.unit,
                                showPeer: !noPeer,
                                isLinked: true
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    /// `dimension` is "opening:<Family Name>" — `name` already carries the
    /// stripped label when present, but the drilldown request needs the raw
    /// family string, so this strips the prefix itself either way.
    private func openingFamily(_ comparison: TutorComparison) -> String {
        if let name = comparison.name, !name.isEmpty { return name }
        let prefix = "opening:"
        return comparison.dimension.hasPrefix(prefix) ? String(comparison.dimension.dropFirst(prefix.count)) : comparison.dimension
    }
}

#Preview {
    NavigationStack {
        TutorReportView(reportId: "preview")
    }
    .environment(AuthStore.preview())
    .environment(SettingsStore.preview())
}
