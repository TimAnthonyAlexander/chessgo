import SwiftUI

/// Centered matchmaking modal shown while `socket.lobby == .queued` — a small
/// dialog over a dimmed backdrop, mirroring the web's `SearchingDialog` (NOT a
/// bottom sheet). The only way out is Cancel (or letting the match land): the
/// backdrop is deliberately inert so a stray tap can't silently strand the
/// queue entry server-side. Presented via `.fullScreenCover` with a clear
/// presentation background so the dim + card compose over the whole screen.
struct SearchingModal: View {
    let socket: SocketStore

    @Environment(\.dismiss) private var dismiss
    @State private var startedAt: Date
    @State private var isPresentingBotSetup = false

    private static let softenAfterSeconds = 10

    /// `startedAt` defaults to "now" for real use; previews back-date it to
    /// exercise the post-10s softened copy without waiting in the canvas.
    init(socket: SocketStore, startedAt: Date = Date()) {
        self.socket = socket
        self._startedAt = State(initialValue: startedAt)
    }

    var body: some View {
        ZStack {
            // Inert dimmed backdrop — no tap-to-dismiss (see type doc).
            Color.black.opacity(0.45)
                .ignoresSafeArea()

            TimelineView(.periodic(from: startedAt, by: 1)) { timeline in
                let elapsed = max(0, Int(timeline.date.timeIntervalSince(startedAt)))
                card(elapsed: elapsed)
            }
            .padding(Theme.Spacing.xl)
        }
        .presentationBackground(.clear)
        .onChange(of: socket.game?.id) { _, newValue in
            if newValue != nil { dismiss() }
        }
        .fullScreenCover(isPresented: $isPresentingBotSetup, onDismiss: { dismiss() }) {
            BotSetupView()
        }
    }

    private func card(elapsed: Int) -> some View {
        let softened = elapsed >= Self.softenAfterSeconds
        return VStack(spacing: Theme.Spacing.lg) {
            if let pool = queuedPoolLabel {
                Text(pool.uppercased())
                    .font(Theme.caption(12).monospacedDigit())
                    .tracking(1.4)
                    .foregroundStyle(Theme.Colors.accent)
            }

            ProgressView()
                .controlSize(.large)
                .tint(Theme.Colors.accent)

            VStack(spacing: Theme.Spacing.xs) {
                Text("Searching… \(Self.format(elapsed))")
                    .font(Theme.headline(20).monospacedDigit())
                    .foregroundStyle(Theme.Colors.primaryText)

                Text(softened
                     ? "Still searching — we'll add a computer opponent shortly if no one's free."
                     : "Hang tight while we match you with a player of similar strength.")
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: Theme.Spacing.sm) {
                Button("Play the computer instead") {
                    socket.cancelQueue()
                    isPresentingBotSetup = true
                }
                .prominentGlassButton()

                Button("Cancel") {
                    socket.cancelQueue()
                    dismiss()
                }
                .glassButton()
            }
        }
        .padding(Theme.Spacing.lg)
        .frame(maxWidth: 360)
        .background(
            Theme.Colors.surfaceElevated,
            in: RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .stroke(Theme.Colors.primaryText.opacity(0.08), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.28), radius: 30, y: 12)
    }

    private var queuedPoolLabel: String? {
        guard case .queued(let pool, let variant) = socket.lobby else { return nil }
        guard variant != "standard" else { return pool }
        return "\(pool) · \(Variant(rawValue: variant)?.displayName ?? variant)"
    }

    private static func format(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

#Preview("SearchingModal — early") {
    let store = SocketStore()
    store.lobby = .queued(pool: "5+3", variant: "standard")
    return Color(Theme.Colors.background)
        .ignoresSafeArea()
        .fullScreenCover(isPresented: .constant(true)) {
            SearchingModal(socket: store)
        }
}

#Preview("SearchingModal — softened") {
    let store = SocketStore()
    store.lobby = .queued(pool: "3+0", variant: "duck")
    return Color(Theme.Colors.background)
        .ignoresSafeArea()
        .fullScreenCover(isPresented: .constant(true)) {
            SearchingModal(socket: store, startedAt: Date().addingTimeInterval(-12))
        }
}
