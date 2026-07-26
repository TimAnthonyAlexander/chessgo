import SwiftUI

@main
struct ChessgoApp: App {
    @State private var auth = AuthStore()
    @State private var socket = SocketStore()
    @State private var settings = SettingsStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(auth)
                .environment(socket)
                .environment(settings)
                .preferredColorScheme(settings.preferredColorScheme)
                .task {
                    // Warm the audio stack in the background at launch so the
                    // first move's sound never pays the cold-start cost on the
                    // main thread. Returns immediately (work runs off-main).
                    SoundEngine.shared.prewarm()
                    await auth.bootstrap()
                }
        }
    }
}

/// Normally the tab shell. Under DEBUG a launch argument can substitute a
/// single screen so the running app can be screenshotted headlessly (there's
/// no on-device tap automation in this environment).
private struct RootView: View {
    var body: some View {
        #if DEBUG
        if CommandLine.arguments.contains("-uitestBoard") {
            BoardDemoScreen()
        } else {
            RootTabView()
        }
        #else
        RootTabView()
        #endif
    }
}

#if DEBUG
private struct BoardDemoScreen: View {
    // A mid-game position (Italian) with a couple of legal moves and a last move,
    // enough to verify piece glyphs, colors, highlights, and coordinates render.
    private let control = PreviewBoardControl(
        fen: "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4",
        orientation: .black,
        myTurn: true,
        legalMoves: ["e8g8", "d7d6", "d7d5", "c6d4", "f6e4"],
        lastMove: "e1g1"
    )

    var body: some View {
        VStack {
            Text("Board render check")
                .font(.headline)
                .padding(.top, 24)
            BoardView(control: control, flipped: true)
                .padding()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.Colors.background)
    }
}
#endif
