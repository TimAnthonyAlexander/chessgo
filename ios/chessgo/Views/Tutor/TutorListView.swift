import SwiftUI

/// `/tutor` — your shelf of built reports, a range picker, and a build
/// button. Mirrors the web's `pages/Tutor.tsx`. Auth-only: `AccountView`'s
/// entry point is signed-in-only, and an unauthenticated load surfaces its
/// 401 through the ordinary error state rather than a bespoke guest screen.
struct TutorListView: View {
    private static let rangeLabels: [String: String] = [
        "1m": "1 month", "3m": "3 months", "6m": "6 months", "12m": "12 months",
    ]
    private static let fallbackRanges = ["1m", "3m", "6m", "12m"]
    private static let pollIntervalNs: UInt64 = 5_000_000_000

    private enum Phase {
        case loading
        case loaded(TutorReportsResponse)
        case failed(String)
    }

    @State private var phase: Phase = .loading
    @State private var range = "6m"
    @State private var building = false
    @State private var buildError: String?

    var body: some View {
        Group {
            switch phase {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .failed(message):
                ContentUnavailableView(
                    "Couldn't load Tutor.",
                    systemImage: "wifi.slash",
                    description: Text(message)
                )
            case let .loaded(data):
                content(data)
            }
        }
        .background(Theme.Colors.background)
        .navigationTitle("Tutor")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if readyCount >= 2 {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink {
                        TutorTrendView()
                    } label: {
                        Image(systemName: "chart.line.uptrend.xyaxis")
                    }
                }
            }
        }
        .task { await load() }
        .task(id: hasPending) {
            guard hasPending else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: Self.pollIntervalNs)
                guard !Task.isCancelled else { return }
                await load()
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func content(_ data: TutorReportsResponse) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                if data.reports.isEmpty {
                    Text(
                        "Tutor reads your recent games and measures how you actually play — accuracy, " +
                        "time use, phase and piece strength — against players in your own rating band. " +
                        "Build a report to see where you're ahead, where you're behind, and a drill for " +
                        "each weakness it finds."
                    )
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.Colors.secondaryText)
                }

                buildControls(data)

                if !data.reports.isEmpty {
                    VStack(spacing: 0) {
                        ForEach(data.reports) { report in
                            reportRow(report)
                            if report.id != data.reports.last?.id {
                                Divider().opacity(0.3)
                            }
                        }
                    }
                    .glassCard()
                }
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private func buildControls(_ data: TutorReportsResponse) -> some View {
        let eligibility = data.eligibility ?? TutorEligibility()
        let ranges = data.ranges.isEmpty ? Self.fallbackRanges : data.ranges

        return VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(spacing: Theme.Spacing.sm) {
                rangeMenu(ranges)
                Button {
                    build()
                } label: {
                    if building {
                        ProgressView().tint(.white)
                    } else {
                        Text("Build report")
                    }
                }
                .prominentGlassButton()
                .disabled(!eligibility.canRequest || building)
            }

            if !eligibility.canRequest, let reason = eligibility.reason {
                Text(reason)
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            if let buildError {
                Text(buildError)
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.negative)
            }
        }
    }

    private func rangeMenu(_ ranges: [String]) -> some View {
        Menu {
            ForEach(ranges, id: \.self) { option in
                Button {
                    range = option
                } label: {
                    if option == range {
                        Label(Self.rangeLabels[option] ?? option, systemImage: "checkmark")
                    } else {
                        Text(Self.rangeLabels[option] ?? option)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(Self.rangeLabels[range] ?? range)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11))
            }
            .font(Theme.body(14))
            .foregroundStyle(Theme.Colors.primaryText)
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.vertical, Theme.Spacing.sm)
            .glassed(in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
        }
        .disabled(building)
    }

    private func reportRow(_ report: TutorReportSummary) -> some View {
        Group {
            if report.statusKind == .ready {
                NavigationLink {
                    TutorReportView(reportId: report.id)
                } label: {
                    reportRowBody(report)
                }
                .buttonStyle(.plain)
            } else {
                reportRowBody(report)
            }
        }
    }

    private func reportRowBody(_ report: TutorReportSummary) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(TutorFormat.date(report.rangeFrom)) – \(TutorFormat.date(report.rangeTo))")
                    .font(Theme.body(13.5))
                    .fontWeight(.semibold)
                    .foregroundStyle(Theme.Colors.primaryText)

                switch report.statusKind {
                case .ready:
                    if let text = report.headline?.text, !text.isEmpty {
                        Text(text)
                            .font(Theme.caption(12))
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                case .failed:
                    Text(report.error ?? "Build failed.")
                        .font(Theme.caption(12))
                        .foregroundStyle(Theme.Colors.negative)
                case .insufficient:
                    Text("Not enough games in this range (\(report.gamesConsidered) found).")
                        .font(Theme.caption(12))
                        .foregroundStyle(Theme.Colors.secondaryText)
                case .queued:
                    Text("Queued…")
                        .font(Theme.caption(12))
                        .foregroundStyle(Theme.Colors.secondaryText)
                case .building:
                    Text("Building…")
                        .font(Theme.caption(12))
                        .foregroundStyle(Theme.Colors.secondaryText)
                case .unknown:
                    EmptyView()
                }
            }

            Spacer(minLength: Theme.Spacing.sm)

            VStack(alignment: .trailing, spacing: 4) {
                if report.isPending {
                    ProgressView().controlSize(.small)
                }
                Text("\(report.gamesUsed) games")
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
        .padding(.vertical, Theme.Spacing.sm)
        .contentShape(Rectangle())
    }

    // MARK: - State

    private var hasPending: Bool {
        if case let .loaded(data) = phase { return data.reports.contains { $0.isPending } }
        return false
    }

    private var readyCount: Int {
        if case let .loaded(data) = phase { return data.reports.filter { $0.statusKind == .ready }.count }
        return 0
    }

    private func load() async {
        do {
            let data = try await TutorService.shared.reports()
            phase = .loaded(data)
        } catch {
            if case .loaded = phase { return } // keep showing the last good shelf on a poll hiccup
            phase = .failed(error.localizedDescription)
        }
    }

    private func build() {
        guard !building else { return }
        building = true
        buildError = nil
        Task {
            do {
                _ = try await TutorService.shared.requestReport(range: range)
                await load()
            } catch {
                buildError = error.localizedDescription
            }
            building = false
        }
    }
}

#Preview {
    NavigationStack {
        TutorListView()
    }
    .environment(AuthStore.preview())
}
