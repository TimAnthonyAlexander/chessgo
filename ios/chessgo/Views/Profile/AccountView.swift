import SwiftUI

/// Profile tab root: account state (signed-in summary + log out, or a guest
/// prompt to sign in) plus entry points into the full profile, leaderboard,
/// and streak screens.
struct AccountView: View {
    @Environment(AuthStore.self) private var authStore
    @State private var isPresentingAuthSheet = false
    @State private var isLoggingOut = false
    @State private var streak: Streak?

    var body: some View {
        NavigationStack {
            Group {
                if let user = authStore.user {
                    signedIn(user)
                } else {
                    guest
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.Colors.background)
            .navigationTitle("Profile")
            .sheet(isPresented: $isPresentingAuthSheet) {
                AuthSheet()
            }
        }
        .task(id: authStore.user?.id) { await loadStreak() }
    }

    // MARK: - Signed in

    private func signedIn(_ user: User) -> some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.xl) {
                VStack(spacing: Theme.Spacing.xs) {
                    Avatar(name: user.name, size: 64)
                    Text(user.name)
                        .font(Theme.title())
                        .foregroundStyle(Theme.Colors.primaryText)
                    Text(user.email)
                        .font(Theme.body(14))
                        .foregroundStyle(Theme.Colors.secondaryText)
                }

                if let streak {
                    streakChip(streak)
                }

                HStack(spacing: Theme.Spacing.md) {
                    ratingTile(label: "Blitz", value: user.ratingBlitz)
                    ratingTile(label: "Rapid", value: user.ratingRapid)
                }

                VStack(spacing: Theme.Spacing.sm) {
                    NavigationLink {
                        ProfileView(name: user.name)
                    } label: {
                        Label("View my profile", systemImage: "person.crop.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .glassButton()

                    NavigationLink {
                        LeaderboardView()
                    } label: {
                        Label("Leaderboard", systemImage: "trophy")
                            .frame(maxWidth: .infinity)
                    }
                    .glassButton()

                    NavigationLink {
                        TutorListView()
                    } label: {
                        Label("Tutor", systemImage: "graduationcap")
                            .frame(maxWidth: .infinity)
                    }
                    .glassButton()

                    NavigationLink {
                        StreakView()
                    } label: {
                        Label("Streak details", systemImage: "flame")
                            .frame(maxWidth: .infinity)
                    }
                    .glassButton()
                }
                .frame(maxWidth: 280)

                Button {
                    logOut()
                } label: {
                    ZStack {
                        Text("Log out").opacity(isLoggingOut ? 0 : 1)
                        if isLoggingOut {
                            ProgressView()
                        }
                    }
                }
                .glassButton()
                .disabled(isLoggingOut)
                .frame(maxWidth: 200)
            }
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity)
        }
    }

    private func streakChip(_ streak: Streak) -> some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: "flame.fill")
                .foregroundStyle(streak.current > 0 ? Theme.Colors.accent : Theme.Colors.secondaryText)
            Text("\(streak.current)-day streak")
                .font(Theme.body(14))
                .fontWeight(.semibold)
                .foregroundStyle(Theme.Colors.primaryText)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .glassed(in: Capsule())
    }

    private func loadStreak() async {
        guard authStore.user != nil else {
            streak = nil
            return
        }
        streak = try? await ProfileService.shared.streak()
    }

    private func ratingTile(label: String, value: Int) -> some View {
        VStack(spacing: Theme.Spacing.xs) {
            Text("\(value)")
                .font(Theme.headline(24))
                .foregroundStyle(Theme.Colors.primaryText)
            Text(label)
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .frame(width: 96)
        .padding(.vertical, Theme.Spacing.md)
        .glassCard()
    }

    private func logOut() {
        guard !isLoggingOut else { return }
        isLoggingOut = true
        Task {
            await authStore.logout()
            isLoggingOut = false
        }
    }

    // MARK: - Guest

    private var guest: some View {
        VStack(spacing: Theme.Spacing.lg) {
            Image(systemName: "person.crop.circle")
                .font(.system(size: 44))
                .foregroundStyle(Theme.Colors.secondaryText)

            Text("Play as guest or sign in to save your rating")
                .font(Theme.body())
                .foregroundStyle(Theme.Colors.secondaryText)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)

            Button("Sign in") {
                isPresentingAuthSheet = true
            }
            .prominentGlassButton()
            .frame(maxWidth: 200)

            NavigationLink {
                LeaderboardView()
            } label: {
                Label("Leaderboard", systemImage: "trophy")
                    .frame(maxWidth: .infinity)
            }
            .glassButton()
            .frame(maxWidth: 200)
        }
        .padding(Theme.Spacing.lg)
    }
}

#Preview("Signed in") {
    AccountView()
        .environment(AuthStore.preview(user: .previewStub))
}

#Preview("Guest") {
    AccountView()
        .environment(AuthStore.preview())
}

private extension User {
    /// Decoded (not memberwise-initialized) so the many `@Default*`-wrapped
    /// rating fields fall back to their normal decode defaults — only the
    /// fields this preview cares about are given values.
    static let previewStub: User = {
        let json = Data("""
        {"id":"preview","name":"Ada Lovelace","email":"ada@example.com",
         "rating_blitz":1450,"games_blitz":62,"rating_rapid":1502,"games_rapid":31}
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(User.self, from: json)
    }()
}
