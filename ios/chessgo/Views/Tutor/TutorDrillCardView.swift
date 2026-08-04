import SwiftUI

/// The point of the whole feature: what to actually DO about a weakness.
/// Exactly one PRIMARY action per card — kind-specific rows underneath (a
/// theme chip, a position, a game) are plain secondary tap targets, never a
/// second competing button. Mirrors `components/tutor/DrillCard.tsx`.
struct TutorDrillCardView: View {
    let drill: TutorDrill

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(drill.title)
                .font(Theme.headline(16))
                .foregroundStyle(Theme.Colors.primaryText)
            Text(drill.blurb)
                .font(Theme.caption(12.5))
                .foregroundStyle(Theme.Colors.secondaryText)

            switch TutorDrillKind(rawValue: drill.kind) {
            case .puzzles: puzzlesBody
            case .replay: replayBody
            case .opening: openingBody
            case .games: gamesBody
            case nil: EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassCard()
    }

    // MARK: - Puzzles

    @ViewBuilder
    private var puzzlesBody: some View {
        if let first = drill.themes.first {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                NavigationLink {
                    PuzzlesView(deepLinkThemeTag: first)
                } label: {
                    primaryLabel("Drill these")
                }
                .prominentGlassButton()

                let rest = drill.themes.dropFirst()
                if !rest.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Theme.Spacing.xs) {
                            ForEach(Array(rest), id: \.self) { tag in
                                NavigationLink {
                                    PuzzlesView(deepLinkThemeTag: tag)
                                } label: {
                                    Text(TutorFormat.themeLabel(tag))
                                        .font(.system(size: 11.5, design: .monospaced))
                                        .foregroundStyle(Theme.Colors.secondaryText)
                                        .padding(.horizontal, Theme.Spacing.sm)
                                        .padding(.vertical, 5)
                                        .overlay(
                                            Capsule().stroke(Theme.Colors.primaryText.opacity(0.12), lineWidth: 1)
                                        )
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Replay

    @ViewBuilder
    private var replayBody: some View {
        let positions = Array(drill.positions.prefix(5))
        if let first = positions.first {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                NavigationLink {
                    TutorBotLaunchView(startFen: first.fen, humanColor: first.color, openingLabel: nil)
                } label: {
                    primaryLabel("Replay these positions")
                }
                .prominentGlassButton()

                VStack(spacing: 0) {
                    ForEach(positions) { position in
                        NavigationLink {
                            TutorBotLaunchView(startFen: position.fen, humanColor: position.color, openingLabel: nil)
                        } label: {
                            positionRow(position)
                        }
                        .buttonStyle(.plain)
                        if position.id != positions.last?.id {
                            Divider().opacity(0.3)
                        }
                    }
                }
            }
        }
    }

    private func positionRow(_ position: TutorDrillPosition) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(position.san ?? "Position")
                    .font(Theme.body(13))
                    .foregroundStyle(Theme.Colors.primaryText)
                if let playedAt = position.playedAt {
                    Text(TutorFormat.date(playedAt))
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            Spacer()
            Text("-\(Int(position.swing.rounded())) cp")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(Theme.Colors.negative)
        }
        .padding(.vertical, Theme.Spacing.xs + 2)
        .contentShape(Rectangle())
    }

    // MARK: - Opening

    @ViewBuilder
    private var openingBody: some View {
        if let opening = drill.opening {
            NavigationLink {
                TutorBotLaunchView(startFen: nil, humanColor: drill.color, openingLabel: opening)
            } label: {
                primaryLabel("Drill this opening")
            }
            .prominentGlassButton()
        }
    }

    // MARK: - Games

    @ViewBuilder
    private var gamesBody: some View {
        if !drill.games.isEmpty {
            VStack(spacing: 0) {
                ForEach(drill.games) { ref in
                    NavigationLink {
                        AnalysisView(gameId: ref.gameId)
                    } label: {
                        HStack {
                            Text("Game \(ref.gameId.prefix(8))")
                                .font(Theme.body(13))
                                .foregroundStyle(Theme.Colors.secondaryText)
                            Spacer()
                            Text(TutorFormat.date(ref.playedAt))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Theme.Colors.secondaryText.opacity(0.8))
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, Theme.Spacing.xs + 2)
                    if ref.id != drill.games.last?.id {
                        Divider().opacity(0.3)
                    }
                }
            }
        }
    }

    private func primaryLabel(_ text: String) -> some View {
        HStack {
            Text(text)
            Image(systemName: "arrow.right")
                .font(.system(size: 12, weight: .semibold))
        }
        .frame(maxWidth: .infinity)
    }
}

/// Creates a `BotGameDriver` on first appearance and starts it — the shared
/// destination for every Tutor drill that hands off into a bot game
/// (`replay`/`opening` kinds), and also `TutorOpeningView`'s own "Drill this
/// opening" button. Reuses the player's persisted bot settings (strength,
/// variant) except for the fields the drill dictates. Internal (not
/// `private`) so both call sites can push it directly.
struct TutorBotLaunchView: View {
    let startFen: String?
    let humanColor: String?
    let openingLabel: String?

    @State private var driver: BotGameDriver?

    var body: some View {
        Group {
            if let driver {
                BotGameView(driver: driver)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            guard driver == nil else { return }
            var settings = BotSettingsStore.load()
            // A drill replays a real position from a finished game — always
            // standard rules, regardless of whatever variant the player last
            // set up a bot game with.
            if startFen != nil { settings.variant = .standard }
            if let humanColor { settings.humanColor = humanColor }
            let created = BotGameDriver(settings: settings, startFen: startFen, openingLabel: openingLabel)
            driver = created
            Task { await created.start() }
        }
    }
}

#Preview {
    NavigationStack {
        ScrollView {
            VStack(spacing: Theme.Spacing.md) {
                TutorDrillCardView(drill: .previewPuzzles)
                TutorDrillCardView(drill: .previewReplay)
                TutorDrillCardView(drill: .previewOpening)
                TutorDrillCardView(drill: .previewGames)
            }
            .padding(Theme.Spacing.lg)
        }
        .background(Theme.Colors.background)
    }
    .environment(AuthStore.preview())
    .environment(SettingsStore.preview())
}

private extension TutorDrill {
    static func decoded(_ json: String) -> TutorDrill {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(TutorDrill.self, from: Data(json.utf8))
    }

    static let previewPuzzles = decoded("""
    {"kind":"puzzles","metric":"tacticalAwareness","dimension":"","label":"Tactical awareness",
     "title":"Sharpen your tactics","blurb":"You miss forks and pins more than other 1500s.",
     "themes":["fork","pin","skewer"]}
    """)

    static let previewReplay = decoded("""
    {"kind":"replay","metric":"acpl","dimension":"phase:endgame","label":"Endgame accuracy",
     "title":"Replay your worst endgame moments","blurb":"Five positions where you gave back the most.",
     "positions":[
       {"fen":"8/8/4k3/8/4K3/8/8/8 w - - 0 1","gameId":"g1","ply":54,"color":"w","san":"Kd4","swing":180,"playedAt":"2026-06-01T12:00:00Z"},
       {"fen":"8/8/4k3/8/4K3/8/8/8 b - - 0 1","gameId":"g2","ply":61,"color":"b","san":"Kf6","swing":95,"playedAt":null}
     ]}
    """)

    static let previewOpening = decoded("""
    {"kind":"opening","metric":"score","dimension":"opening:Sicilian Defense","label":"Sicilian Defense",
     "title":"Drill the Sicilian as Black","blurb":"You score well below peers with this opening.",
     "opening":"Sicilian Defense","color":"b"}
    """)

    static let previewGames = decoded("""
    {"kind":"games","metric":"flagging","dimension":"","label":"Flagging",
     "title":"Games lost on the clock","blurb":"No honest drill for time trouble — here's the evidence.",
     "games":[{"gameId":"abcdef1234567890","playedAt":"2026-06-02T09:00:00Z"}]}
    """)
}
