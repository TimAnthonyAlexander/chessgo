import SwiftUI

/// Floating "hold to reveal" button for the admin best-move peek — a faithful
/// port of the web's press-and-hold behaviour (desktop uses an `H` keybind;
/// mobile uses this button). It is a HOLD, not a toggle: `onPress(true)` fires
/// the instant it's touched and `onPress(false)` the instant it's released, so
/// the board highlights the engine's move only while the admin actively holds
/// it. Hosting views float it over the board and gate its visibility on a best
/// move being available.
struct AdminPeekButton: View {
    /// Called with `true` on press-down, `false` on release.
    let onPress: (Bool) -> Void

    @State private var down = false

    var body: some View {
        Image(systemName: down ? "eye.fill" : "eye")
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 52, height: 52)
            .background(Theme.Colors.accent.opacity(down ? 1 : 0.9), in: Circle())
            .overlay(Circle().stroke(.white.opacity(0.25), lineWidth: 1))
            .shadow(color: .black.opacity(0.3), radius: 8, y: 3)
            .scaleEffect(down ? 0.94 : 1)
            .animation(.easeOut(duration: 0.12), value: down)
            // minimumDistance 0 → onChanged fires immediately on touch-down;
            // onEnded on lift. The `down` guard keeps onPress(true) to one call.
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        if !down { down = true; onPress(true) }
                    }
                    .onEnded { _ in
                        down = false
                        onPress(false)
                    }
            )
            .accessibilityLabel("Hold to reveal the best move")
    }
}

#Preview("AdminPeekButton") {
    AdminPeekButton { print("pressed: \($0)") }
        .padding(Theme.Spacing.xl)
        .background(Theme.Colors.background)
}
