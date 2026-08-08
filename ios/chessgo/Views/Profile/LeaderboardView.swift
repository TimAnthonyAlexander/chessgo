import SwiftUI

/// Full leaderboard: a category toggle over a ranked list. Covers every
/// rating pool except Crazyhouse — the server has no leaderboard route for
/// it (`ProfileService.leaderboard` doc comment). Tapping a row opens that
/// player's profile.
struct LeaderboardView: View {
    private static let categories: [RatingCategory] = [
        .bullet, .blitz, .rapid, .classical, .puzzle, .duck, .antichess, .secretqueen,
    ]

    @State private var category: RatingCategory = .blitz
    @State private var entries: [LeaderboardEntry] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            categoryPicker
            content
        }
        .background(Theme.Colors.background)
        .navigationTitle("Leaderboard")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: category) { await load() }
    }

    private var categoryPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.xs) {
                ForEach(Self.categories, id: \.self) { cat in
                    Button {
                        category = cat
                    } label: {
                        Text(label(for: cat))
                            .font(Theme.body(13.5))
                            .fontWeight(.semibold)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.sm)
                    .foregroundStyle(cat == category ? Theme.Colors.accent : Theme.Colors.secondaryText)
                    .background(Capsule().fill(cat == category ? Theme.Colors.accent.opacity(0.12) : .clear))
                }
            }
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.sm)
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage {
            ContentUnavailableView(
                "Couldn't load the leaderboard.",
                systemImage: "wifi.slash",
                description: Text(errorMessage)
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if entries.isEmpty {
            ContentUnavailableView("No ranked players yet.", systemImage: "trophy")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            List(entries) { entry in
                NavigationLink {
                    ProfileView(name: entry.name)
                } label: {
                    leaderboardRow(entry)
                }
                .listRowBackground(Theme.Colors.background)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
        }
    }

    private func label(for category: RatingCategory) -> String {
        switch category {
        case .bullet: return "Bullet"
        case .blitz: return "Blitz"
        case .rapid: return "Rapid"
        case .classical: return "Classical"
        case .puzzle: return "Puzzles"
        case .duck: return "Duck"
        case .crazyhouse: return "Crazyhouse"
        case .antichess: return "Antichess"
        case .secretqueen: return "Secret Queen"
        }
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        do {
            let board = try await ProfileService.shared.leaderboard(category: category, limit: 50)
            entries = board.entries
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

/// Shared row rendering — a free function so both the live list and the
/// fixture-driven preview draw identical rows.
private func leaderboardRow(_ entry: LeaderboardEntry) -> some View {
    HStack(spacing: Theme.Spacing.md) {
        Text("\(entry.rank)")
            .font(.system(size: 13, weight: .bold, design: .monospaced))
            .foregroundStyle(Theme.Colors.secondaryText)
            .frame(width: 28, alignment: .trailing)
        Avatar(name: entry.name, size: 32)
        Text(entry.name)
            .font(Theme.body(15))
            .fontWeight(entry.rank == 1 ? .semibold : .regular)
            .foregroundStyle(Theme.Colors.primaryText)
            .lineLimit(1)
        Spacer()
        RatingBadge(rating: entry.rating, provisional: entry.provisional, size: 16)
    }
    .padding(.vertical, Theme.Spacing.xs)
}

#Preview("Live") {
    NavigationStack {
        LeaderboardView()
    }
}

#Preview("Rows") {
    List(LeaderboardEntry.previewStubs) { entry in
        leaderboardRow(entry)
    }
    .listStyle(.plain)
}

private extension LeaderboardEntry {
    static let previewStubs: [LeaderboardEntry] = {
        let json = Data("""
        [
          {"rank":1,"id":"u1","name":"Ada Lovelace","rating":2140,"games":410,"provisional":false},
          {"rank":2,"id":"u2","name":"Bobby Fischer","rating":2088,"games":560,"provisional":false},
          {"rank":3,"id":"u3","name":"Cleo","rating":1990,"games":12,"provisional":true}
        ]
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode([LeaderboardEntry].self, from: json)
    }()
}
