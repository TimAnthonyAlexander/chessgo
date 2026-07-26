import SwiftUI
import UIKit

/// Create a private invite, or join one by code. Mirrors the web's
/// challenge dialog (frontend-features.md): time control, color, variant,
/// a rated toggle forced off for guests, then a shareable 6-char code with
/// a "waiting for your friend…" spinner. Closing the sheet (any way —
/// button or swipe) withdraws an open invite; `socket.challengeInfo` is the
/// single source of truth for which phase to show.
struct ChallengeSheet: View {
    let socket: SocketStore

    @Environment(AuthStore.self) private var authStore
    @Environment(\.dismiss) private var dismiss

    @State private var baseMinutes = 5
    @State private var incrementSeconds = 3
    @State private var color = "w"
    @State private var variant: Variant = .standard
    @State private var rated = true
    @State private var joinCode = ""
    @State private var joinError: String?

    /// Live-play-sensible variants only — fading/glassjaw/doublemove decay
    /// strength server-side for bot games and don't apply here.
    private let variants: [Variant] = [.standard, .chess960, .duck, .crazyhouse, .antichess]

    private var pool: String { "\(baseMinutes)+\(incrementSeconds)" }

    /// Explicit, because the synthesized memberwise init would be `private`
    /// (Swift demotes it to match the least-accessible stored property —
    /// here, every `@State private var` above) and unusable from `HomeView`,
    /// a different file. Same reasoning as `LiveGameView`'s custom init.
    init(socket: SocketStore) {
        self.socket = socket
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if let info = socket.challengeInfo {
                        waitingCard(info)
                    } else {
                        setupCard
                        joinCard
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .background(Theme.Colors.background)
            .navigationTitle("Play a friend")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
        .onChange(of: authStore.isAuthenticated) { _, isAuthenticated in
            if !isAuthenticated { rated = false }
        }
        .onChange(of: socket.game?.id) { _, newValue in
            if newValue != nil { dismiss() }
        }
        .onDisappear {
            // A real match clears `challengeInfo` itself; only withdraw a
            // still-open invite (covers both the Close button and a swipe).
            if socket.challengeInfo != nil, socket.game == nil {
                socket.cancelChallenge()
            }
        }
    }

    // MARK: - Create

    private var setupCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            Text("Create an invite")
                .font(Theme.headline(16))
                .foregroundStyle(Theme.Colors.primaryText)

            timeControlControl
            variantControl
            colorControl
            ratedControl

            Button("Create invite") {
                socket.createChallenge(pool: pool, color: color, rated: rated, variant: variant.rawValue)
            }
            .prominentGlassButton()
            .disabled(pool == "0+0")
        }
        .padding(Theme.Spacing.md)
        .glassCard()
    }

    private var timeControlControl: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Time control")
                .font(Theme.body(15))
                .foregroundStyle(Theme.Colors.primaryText)

            Stepper(value: $baseMinutes, in: 0...180) {
                HStack {
                    Text("Minutes").foregroundStyle(Theme.Colors.secondaryText)
                    Spacer()
                    Text("\(baseMinutes)").monospacedDigit().foregroundStyle(Theme.Colors.primaryText)
                }
            }
            Stepper(value: $incrementSeconds, in: 0...60) {
                HStack {
                    Text("Increment").foregroundStyle(Theme.Colors.secondaryText)
                    Spacer()
                    Text("\(incrementSeconds)s").monospacedDigit().foregroundStyle(Theme.Colors.primaryText)
                }
            }

            if pool == "0+0" {
                Text("0+0 isn't playable — add a minute or an increment.")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.negative)
            }
        }
        .font(Theme.body(15))
    }

    private var variantControl: some View {
        Picker("Variant", selection: $variant) {
            ForEach(variants, id: \.self) { v in
                Text(v.displayName).tag(v)
            }
        }
        .pickerStyle(.menu)
    }

    private var colorControl: some View {
        Picker("Play as", selection: $color) {
            Text("White").tag("w")
            Text("Black").tag("b")
            Text("Random").tag("random")
        }
        .pickerStyle(.segmented)
    }

    private var ratedControl: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle("Rated", isOn: ratedBinding)
                .tint(Theme.Colors.accent)
                .disabled(!authStore.isAuthenticated)
            if !authStore.isAuthenticated {
                Text("Sign in to play rated games.")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    private var ratedBinding: Binding<Bool> {
        Binding(
            get: { authStore.isAuthenticated && rated },
            set: { rated = $0 }
        )
    }

    // MARK: - Waiting

    private func waitingCard(_ info: ChallengeInfo) -> some View {
        VStack(spacing: Theme.Spacing.md) {
            Text("Invite ready")
                .font(Theme.headline(16))
                .foregroundStyle(Theme.Colors.primaryText)

            Text(info.code)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .tracking(4)
                .foregroundStyle(Theme.Colors.accent)

            Text(summary(for: info))
                .font(Theme.body(14))
                .foregroundStyle(Theme.Colors.primaryText)

            Text(shareLink(for: info.code))
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
                .lineLimit(1)
                .truncationMode(.middle)

            HStack(spacing: Theme.Spacing.sm) {
                if let url = URL(string: shareLink(for: info.code)) {
                    ShareLink(item: url) {
                        Label("Share", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .glassButton()
                }

                Button {
                    UIPasteboard.general.string = shareLink(for: info.code)
                } label: {
                    Label("Copy link", systemImage: "doc.on.doc")
                        .frame(maxWidth: .infinity)
                }
                .glassButton()
            }

            HStack(spacing: Theme.Spacing.sm) {
                ProgressView()
                Text("Waiting for your friend…")
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .padding(.top, Theme.Spacing.xs)

            Button("Cancel invite") {
                socket.cancelChallenge()
            }
            .glassButton()
        }
        .frame(maxWidth: .infinity)
        .padding(Theme.Spacing.md)
        .glassCard()
    }

    private func shareLink(for code: String) -> String {
        "https://chessgo.timanthonyalexander.de/challenge/\(code)"
    }

    /// "5+3 · Blitz · White · Rated" — the invite's own terms, since the
    /// code alone doesn't say what was created.
    private func summary(for info: ChallengeInfo) -> String {
        let speed = TimeControlCategory.classify(pool: info.pool).label
        let variantName = Variant(rawValue: info.variant)?.displayName ?? info.variant
        let colorLabel = ["w": "White", "b": "Black", "random": "Random"][info.color] ?? info.color
        let ratedLabel = info.rated ? "Rated" : "Casual"
        return "\(info.pool) · \(speed) · \(variantName) · \(colorLabel) · \(ratedLabel)"
    }

    // MARK: - Join

    private var joinCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Join by code")
                .font(Theme.headline(16))
                .foregroundStyle(Theme.Colors.primaryText)

            HStack(spacing: Theme.Spacing.sm) {
                TextField("6-character code", text: $joinCode)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .font(Theme.body(16))
                    .padding(.vertical, 12)
                    .padding(.horizontal, Theme.Spacing.md)
                    .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))

                Button("Join") {
                    joinByCode()
                }
                .glassButton()
                .disabled(trimmedJoinCode.count != 6)
            }

            if let joinError {
                Text(joinError)
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.negative)
            }
        }
        .padding(Theme.Spacing.md)
        .glassCard()
    }

    private var trimmedJoinCode: String {
        joinCode.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func joinByCode() {
        let code = trimmedJoinCode.uppercased()
        guard code.count == 6 else {
            joinError = "Codes are 6 characters."
            return
        }
        joinError = nil
        socket.joinChallenge(code: code)
    }
}

#Preview("ChallengeSheet — create") {
    Color.clear
        .sheet(isPresented: .constant(true)) {
            ChallengeSheet(socket: SocketStore())
        }
        .environment(AuthStore.preview())
}

#Preview("ChallengeSheet — waiting") {
    let store = SocketStore()
    store.challengeInfo = ChallengeInfo(code: "7K2QAB", pool: "5+3", color: "w", rated: true, variant: "standard")
    return Color.clear
        .sheet(isPresented: .constant(true)) {
            ChallengeSheet(socket: store)
        }
        .environment(AuthStore.preview(user: nil))
}
