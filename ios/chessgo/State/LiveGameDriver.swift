import Foundation
import SwiftUI

/// Adapts `SocketStore.game` to `BoardControl` for `BoardView`. Holds no
/// authoritative state of its own — every property reads through to the
/// socket's current `LiveGameState` — except the Duck two-phase hand-off,
/// which is genuinely local UI state (the server never hears about the
/// piece-move half until the duck square is also chosen).
///
/// `@Observable` so a read of e.g. `driver.fen` inside `BoardView.body`
/// participates in the same Observation tracking transaction as the
/// underlying `socket.game` read it performs — SwiftUI re-renders on either
/// object's change without any extra plumbing.
@Observable
@MainActor
final class LiveGameDriver: BoardControl {
    private let socket: SocketStore

    /// Set the instant the human completes the piece-move half of a Duck
    /// turn; cleared once the duck square is chosen and the composite move
    /// is sent. `nil` outside Duck games and between turns.
    private var pendingPieceMove: Move?

    /// App-wide display/input/sound preferences. `nil` until the hosting
    /// view (`LiveGameView`) injects the environment's `SettingsStore` post-
    /// construction — every read below falls back to the pre-settings
    /// hardcoded default so previews behave exactly as before.
    var appSettings: SettingsStore?

    var autoQueen: Bool { appSettings?.autoQueen ?? true }
    var inputMethod: BoardInputMethod { appSettings?.moveMethod.boardInputMethod ?? .both }

    private var soundVolume: Double {
        guard let appSettings, appSettings.soundEnabled else { return 0 }
        return appSettings.soundVolume
    }

    init(socket: SocketStore) {
        self.socket = socket
    }

    private var state: LiveGameState? { socket.game }

    var fen: String {
        let base = state?.fen ?? ChessBoard.startFEN
        guard let pendingPieceMove else { return base }
        // Optimistic: show the piece already moved while we wait for the
        // human to tap the duck's new square.
        return ChessBoard(fen: base).applying(pendingPieceMove.uci).fen()
    }

    var orientation: PieceColor {
        state?.color == "b" ? .black : .white
    }

    var myTurn: Bool {
        guard let state, !state.ended else { return false }
        return state.sideToMove == state.color
    }

    var legalMoves: [String] {
        state?.legalMoves ?? []
    }

    var lastMove: String? { state?.lastMove }

    var showCheck: Bool { Variant.hasCheck(state?.variant) }

    var canPremove: Bool {
        guard let state else { return false }
        return !state.ended
    }

    var duckSquare: String? {
        guard let duck = state?.duck, !duck.isEmpty else { return nil }
        return duck
    }

    var pocket: String? { state?.pocket }

    var duckPlacementActive: Bool { pendingPieceMove != nil }

    /// Non-Duck games: forward straight to the socket — this covers plain
    /// UCI moves and Crazyhouse drops ("P@e4"), both sent as a `move` frame
    /// verbatim. Duck games: the board just completed the piece-move half;
    /// hold it and wait for `submitDuckPlacement`.
    func submit(_ uci: String) {
        guard let state, state.variant == "duck" else {
            playOwnMoveSound(uci: uci)
            socket.move(uci)
            return
        }
        guard let move = Move(uci: uci) else { return }
        pendingPieceMove = move
    }

    func submitDuckPlacement(_ square: String) {
        guard let pendingPieceMove else { return }
        self.pendingPieceMove = nil
        let composite = "\(pendingPieceMove.uci):\(square)"
        playOwnMoveSound(uci: composite)
        socket.move(composite)
    }

    // MARK: - Sound

    /// Own move sounds the instant it's committed, before the server
    /// confirms — SAN isn't known yet, so this reconstructs just enough of
    /// one ("x"/"="/"O-O") from the pre-move board to pick the right tone.
    /// The opponent's move sounds separately (`LiveGameView` watches for a
    /// new `lastMove` that flips turn back to the human).
    private func playOwnMoveSound(uci: String) {
        let volume = soundVolume
        guard volume > 0 else { return }
        let preBoard = ChessBoard(fen: state?.fen ?? ChessBoard.startFEN).withPocket(state?.pocket)
        SoundEngine.shared.playForSan(Self.pseudoSan(uci: uci, board: preBoard), isGameOver: false, volume: volume)
    }

    /// Composite Duck strings ("e2e4:d5") don't parse as a plain `Move` and
    /// fall back to a bare move tone.
    private static func pseudoSan(uci: String, board: ChessBoard) -> String {
        guard let move = Move(uci: uci) else { return "" }
        var san = ""
        if board.piece(at: move.from)?.kind == .king, abs(move.from.file - move.to.file) == 2 {
            san += "O-O"
        }
        if board.piece(at: move.to) != nil { san += "x" }
        if move.promotion != nil { san += "=" }
        return san
    }
}

#if DEBUG
#Preview("LiveGameDriver via BoardView — mid-game") {
    let store = SocketStore.preview(game: .mock())
    return BoardView(control: LiveGameDriver(socket: store))
        .padding()
        .background(Theme.Colors.background)
}

#Preview("LiveGameDriver via BoardView — Duck mid-turn") {
    let store = SocketStore.preview(game: .mock(variant: "duck"))
    let driver = LiveGameDriver(socket: store)
    driver.submit("e2e4") // arms the piece-move half; board should show the duck-placement affordance
    return BoardView(control: driver)
        .padding()
        .background(Theme.Colors.background)
}
#endif
