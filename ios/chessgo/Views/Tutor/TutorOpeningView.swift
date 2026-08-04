import SwiftUI

/// `/tutor/:reportId/:category/opening/:color/:family` — one opening from
/// one side, with the games behind it. Served from the stored report
/// payload, so it re-analyzes nothing. There is no web page wired to this
/// endpoint yet (`getTutorOpening` is unused in `frontend/src/pages`) — this
/// view is a first-principles design of the same idea already fully
/// specified in `client.ts`.
struct TutorOpeningView: View {
    let reportId: String
    let category: String
    /// "w" | "b".
    let color: String
    let family: String

    private enum Phase {
        case loading
        case failed(String)
        case loaded(TutorOpeningDetail)
    }

    @State private var phase: Phase = .loading

    var body: some View {
        Group {
            switch phase {
            case .loading:
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .failed(message):
                ContentUnavailableView(
                    "Couldn't load this opening.",
                    systemImage: "wifi.slash",
                    description: Text(message)
                )
            case let .loaded(detail):
                loadedBody(detail)
            }
        }
        .background(Theme.Colors.background)
        .navigationTitle(family)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func loadedBody(_ detail: TutorOpeningDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                header(detail)

                if let comparison = detail.comparison {
                    TutorComparisonRow(
                        comparison: comparison,
                        tone: comparison.grade < 0 ? .weakness : .strength
                    )
                    .padding(.horizontal, Theme.Spacing.sm)
                    .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                } else {
                    peerBanner(detail)
                    summaryBlock(detail)
                }

                if let drill = detail.drill {
                    NavigationLink {
                        TutorBotLaunchView(startFen: nil, humanColor: drill.color, openingLabel: drill.opening)
                    } label: {
                        HStack {
                            Text("Drill this opening")
                            Image(systemName: "arrow.right")
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .prominentGlassButton()
                }

                if !detail.games.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        TutorSectionLabel(text: "Games")
                        VStack(spacing: 0) {
                            ForEach(Array(detail.games.enumerated()), id: \.offset) { index, game in
                                gameRow(game)
                                if index < detail.games.count - 1 { Divider().opacity(0.3) }
                            }
                        }
                    }
                }
            }
            .padding(Theme.Spacing.lg)
        }
    }

    private func header(_ detail: TutorOpeningDetail) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(family)
                .font(Theme.title(20))
                .foregroundStyle(Theme.Colors.primaryText)
            Text("As \(detail.color == "b" ? "Black" : "White") · \(TutorFormat.cap(detail.category.isEmpty ? category : detail.category))")
                .font(Theme.caption(12))
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private func peerBanner(_ detail: TutorOpeningDetail) -> some View {
        let peer = detail.effectivePeer
        return Group {
            if peer.tier == "none" {
                Text("Not enough peer data for this opening — the numbers below are yours alone.")
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    private func summaryBlock(_ detail: TutorOpeningDetail) -> some View {
        HStack(spacing: Theme.Spacing.lg) {
            stat(label: "Games", value: "\(detail.summary?.games ?? detail.games.count)")
            if let score = detail.summary?.score {
                stat(label: "Score", value: TutorFormat.value(score, unit: "percent"))
            }
            if let accuracy = detail.summary?.accuracy {
                stat(label: "Accuracy", value: TutorFormat.value(accuracy, unit: "percent"))
            }
        }
    }

    private func stat(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label.uppercased())
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(Theme.Colors.secondaryText.opacity(0.8))
            Text(value)
                .font(Theme.headline(18))
                .foregroundStyle(Theme.Colors.primaryText)
        }
    }

    private func gameRow(_ game: TutorGameRow) -> some View {
        NavigationLink {
            AnalysisView(gameId: game.gameId)
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(resultLabel(game))
                        .font(Theme.body(13))
                        .fontWeight(.semibold)
                        .foregroundStyle(resultColor(game))
                    if let playedAt = game.playedAt {
                        Text(TutorFormat.date(playedAt))
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                Spacer()
                if let accuracy = game.accuracy {
                    Text(TutorFormat.value(accuracy, unit: "percent"))
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, Theme.Spacing.xs + 2)
    }

    private func resultLabel(_ game: TutorGameRow) -> String {
        switch game.result {
        case "1-0": return game.color == "w" ? "Win" : "Loss"
        case "0-1": return game.color == "b" ? "Win" : "Loss"
        default: return game.result.isEmpty ? "—" : "Draw"
        }
    }

    private func resultColor(_ game: TutorGameRow) -> Color {
        switch resultLabel(game) {
        case "Win": return Theme.Colors.positive
        case "Loss": return Theme.Colors.negative
        default: return Theme.Colors.secondaryText
        }
    }

    private func load() async {
        phase = .loading
        do {
            let detail = try await TutorService.shared.opening(
                reportId: reportId, category: category, color: color, family: family
            )
            phase = .loaded(detail)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

#Preview {
    NavigationStack {
        TutorOpeningView(reportId: "preview", category: "blitz", color: "b", family: "Sicilian Defense")
    }
    .environment(AuthStore.preview())
    .environment(SettingsStore.preview())
}
