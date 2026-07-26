import SwiftUI

/// Modal shown while `socket.lobby == .queued`. The only way out is Cancel
/// (or letting the match land) — mirrors the web's `SearchingDialog`, which
/// deliberately has no swipe-to-dismiss so a tap-away can't silently strand
/// the queue entry server-side.
struct SearchingSheet: View {
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
        TimelineView(.periodic(from: startedAt, by: 1)) { timeline in
            let elapsed = max(0, Int(timeline.date.timeIntervalSince(startedAt)))
            content(elapsed: elapsed)
        }
        .padding(Theme.Spacing.lg)
        .background(Theme.Colors.background)
        .interactiveDismissDisabled()
        .onChange(of: socket.game?.id) { _, newValue in
            if newValue != nil { dismiss() }
        }
        .sheet(isPresented: $isPresentingBotSetup, onDismiss: { dismiss() }) {
            BotSetupView()
        }
    }

    private func content(elapsed: Int) -> some View {
        VStack(spacing: Theme.Spacing.lg) {
            Spacer()

            ProgressView()
                .controlSize(.large)
                .tint(Theme.Colors.accent)

            VStack(spacing: Theme.Spacing.sm) {
                Text(Self.format(elapsed))
                    .font(Theme.title(32).monospacedDigit())
                    .foregroundStyle(Theme.Colors.primaryText)

                Text(elapsed >= Self.softenAfterSeconds ? "Adding a computer opponent shortly…" : "Looking for an opponent…")
                    .font(Theme.body(15))
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .multilineTextAlignment(.center)

                if let pool = queuedPoolLabel {
                    Text(pool)
                        .font(Theme.caption())
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }

            Spacer()

            VStack(spacing: Theme.Spacing.sm) {
                if elapsed >= Self.softenAfterSeconds {
                    Button("Play the computer instead") {
                        socket.cancelQueue()
                        isPresentingBotSetup = true
                    }
                    .prominentGlassButton()
                }

                Button("Cancel") {
                    socket.cancelQueue()
                    dismiss()
                }
                .glassButton()
            }
        }
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

#Preview("SearchingSheet — early") {
    let store = SocketStore()
    store.lobby = .queued(pool: "5+3", variant: "standard")
    return Color.clear
        .sheet(isPresented: .constant(true)) {
            SearchingSheet(socket: store)
        }
        .background(Theme.Colors.background)
}

#Preview("SearchingSheet — softened") {
    let store = SocketStore()
    store.lobby = .queued(pool: "3+0", variant: "standard")
    return SearchingSheetPreviewHost(socket: store)
}

/// Preview-only: seeds `startedAt` in the past so the "softened" copy and
/// the bot-backfill offer render immediately instead of waiting 10 real
/// seconds inside the canvas.
private struct SearchingSheetPreviewHost: View {
    let socket: SocketStore
    var body: some View {
        Color.clear
            .sheet(isPresented: .constant(true)) {
                SearchingSheet(socket: socket, startedAt: Date().addingTimeInterval(-12))
            }
            .background(Theme.Colors.background)
    }
}
