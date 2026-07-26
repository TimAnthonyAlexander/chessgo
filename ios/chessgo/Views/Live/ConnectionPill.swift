import SwiftUI

/// Overlay pill shown while the socket is reconnecting mid-game. The game
/// itself keeps ticking (the hub doesn't end it on disconnect) — this is
/// purely a "we're working on it" signal, not a blocking modal.
struct ConnectionPill: View {
    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            ProgressView()
                .controlSize(.small)
            Text("Connection lost — reconnecting…")
                .font(Theme.caption(13))
                .foregroundStyle(Theme.Colors.primaryText)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .glassed(in: Capsule())
    }
}

#Preview("ConnectionPill") {
    ConnectionPill()
        .padding()
        .background(Theme.Colors.background)
}
