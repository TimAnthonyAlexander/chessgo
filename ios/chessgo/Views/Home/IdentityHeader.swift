import SwiftUI

/// Compact identity strip at the very top of the home scroll — "who you are"
/// before "what to play," matching Chess.com/Lichess. Signed in: name + a
/// horizontal strip of rating pills (streak first, if any). Guest: a plain
/// "sign in" nudge. Bare header, no card chrome — stays under ~84pt tall.
struct IdentityHeader: View {
    let onSignIn: () -> Void

    @Environment(AuthStore.self) private var authStore

    var body: some View {
        Group {
            if let user = authStore.user {
                signedIn(user)
            } else {
                guest
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Signed in

    private static let pillCategories: [RatingCategory] = [.bullet, .blitz, .rapid, .classical]

    private func signedIn(_ user: User) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Hi, \(user.name)")
                .font(Theme.headline(20))
                .foregroundStyle(Theme.Colors.primaryText)
                .lineLimit(1)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.sm) {
                    if user.currentStreak > 0 {
                        pillChrome {
                            Label("\(user.currentStreak)", systemImage: "flame.fill")
                                .font(Theme.caption(12).monospacedDigit())
                                .foregroundStyle(Theme.Colors.accent)
                        }
                        .accessibilityLabel("\(user.currentStreak) day streak")
                    }

                    ForEach(Self.pillCategories, id: \.self) { category in
                        ratingPill(for: category, user: user)
                    }
                }
            }
        }
    }

    private func ratingPill(for category: RatingCategory, user: User) -> some View {
        let value = user.rating(for: category)
        return pillChrome {
            HStack(spacing: 4) {
                Text(shortLabel(for: category))
                    .font(Theme.caption(11))
                    .foregroundStyle(Theme.Colors.secondaryText)
                Text("\(value)")
                    .font(Theme.caption(12).monospacedDigit())
                    .foregroundStyle(Theme.Colors.primaryText)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(shortLabel(for: category)) rating \(value)")
    }

    private func pillChrome(@ViewBuilder content: () -> some View) -> some View {
        content()
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.vertical, 6)
            .background(Theme.Colors.surface, in: Capsule())
    }

    private func shortLabel(for category: RatingCategory) -> String {
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

    // MARK: - Guest

    private var guest: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Playing as a guest")
                .font(Theme.headline(20))
                .foregroundStyle(Theme.Colors.primaryText)

            HStack {
                Text("Sign in to save your rating")
                    .font(Theme.caption(13))
                    .foregroundStyle(Theme.Colors.secondaryText)

                Spacer()

                Button("Sign in", action: onSignIn)
                    .font(Theme.headline(14))
                    .foregroundStyle(Theme.Colors.accent)
                    .buttonStyle(.plain)
                    .frame(minHeight: HomeMetrics.minTapTarget)
                    .accessibilityLabel("Sign in")
            }
        }
    }
}

#Preview("IdentityHeader — guest") {
    IdentityHeader(onSignIn: {})
        .padding(Theme.Spacing.lg)
        .background(Theme.Colors.background)
        .environment(AuthStore.preview())
}

#Preview("IdentityHeader — signed in") {
    IdentityHeader(onSignIn: {})
        .padding(Theme.Spacing.lg)
        .background(Theme.Colors.background)
        .environment(AuthStore.preview(user: .identityHeaderPreviewStub))
}

private extension User {
    /// Decoded (not memberwise-initialized, per `User`'s `@Default`
    /// construction gotcha) so every other rating field falls back to its
    /// normal decode default. Mirrors `HomeView.homePreviewStub`.
    static let identityHeaderPreviewStub: User = {
        let json = Data("""
        {"id":"preview","name":"Ada Lovelace","email":"ada@example.com",
         "rating_bullet":1180,"rating_blitz":1450,"rating_rapid":1502,"rating_classical":1610,
         "current_streak":6}
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(User.self, from: json)
    }()
}
