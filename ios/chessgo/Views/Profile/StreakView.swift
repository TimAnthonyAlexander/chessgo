import SwiftUI

/// Streak details: current + longest streak, freeze tokens, and whether today
/// already counts. Read-only, loads its own data via `ProfileService.streak()`.
struct StreakView: View {
    @State private var streak: Streak?
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if isLoading {
                ProgressView()
            } else if let errorMessage {
                ContentUnavailableView(
                    "Couldn't load your streak.",
                    systemImage: "flame",
                    description: Text(errorMessage)
                )
            } else if let streak {
                StreakSummary(streak: streak)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.background)
        .navigationTitle("Streak")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        do {
            streak = try await ProfileService.shared.streak()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

/// The streak's static presentation, split out so it previews from a plain
/// fixture without a network round trip.
struct StreakSummary: View {
    let streak: Streak

    var body: some View {
        VStack(spacing: Theme.Spacing.lg) {
            ZStack {
                Circle()
                    .fill(streak.current > 0 ? Theme.Colors.accent.opacity(0.14) : Theme.Colors.surface)
                    .frame(width: 120, height: 120)
                Image(systemName: "flame.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(streak.current > 0 ? Theme.Colors.accent : Theme.Colors.secondaryText)
                    .shadow(color: streak.activeToday ? Theme.Colors.accent.opacity(0.5) : .clear, radius: 10)
            }

            VStack(spacing: 2) {
                Text("\(streak.current)")
                    .font(.system(size: 42, weight: .bold, design: .monospaced))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text("day streak")
                    .font(Theme.body())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            if streak.activeToday {
                Label("Today already counts", systemImage: "checkmark.circle.fill")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.positive)
            } else {
                Label("Play today to keep it going", systemImage: "circle")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }

            HStack(spacing: Theme.Spacing.lg) {
                stat(label: "Longest", value: "\(streak.longest)")
                stat(label: "Freeze tokens", value: "\(streak.freezeTokens)")
            }
        }
        .padding(Theme.Spacing.lg)
    }

    private func stat(label: String, value: String) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.system(size: 20, weight: .bold, design: .monospaced))
                .foregroundStyle(Theme.Colors.primaryText)
            Text(label)
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .frame(minWidth: 96)
        .padding(.vertical, Theme.Spacing.sm)
        .glassCard()
    }
}

#Preview("Active") {
    StreakSummary(streak: .previewStub(current: 12, longest: 30, activeToday: true))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.background)
}

#Preview("Fresh") {
    StreakSummary(streak: .previewStub(current: 0, longest: 5, activeToday: false))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.background)
}

private extension Streak {
    static func previewStub(current: Int, longest: Int, activeToday: Bool) -> Streak {
        let json = Data("""
        {"current": \(current), "longest": \(longest), "last_active_date": null,
         "freeze_tokens": 2, "active_today": \(activeToday)}
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(Streak.self, from: json)
    }
}
