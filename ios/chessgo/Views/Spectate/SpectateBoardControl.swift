import Foundation

/// Adapts `SpectateStore.game` to `BoardControl` for `BoardView` — the
/// read-only counterpart to `LiveGameDriver`. `myTurn` and `canPremove` are
/// hardwired `false`, so `BoardView`'s own commit paths (`attemptMove`,
/// `handleTurnHandoffIfNeeded`) never call `submit` in the first place —
/// `submit`/`submitDuckPlacement` below are no-ops purely as a second line
/// of defense, not the mechanism that makes this read-only.
///
/// That still leaves the DRAG gesture itself: `BoardView.dragGesture` starts
/// following a piece under the finger as soon as the finger touches one of
/// "your own pieces" (color == `orientation`), before it knows whether the
/// move will commit — so a black piece could visually drag-and-snap-back
/// with this control alone. `SpectateView` neutralizes that the simple way,
/// per `BoardControl`'s own doc comment on `orientation`: it wraps `BoardView`
/// in `.allowsHitTesting(false)`, so no gesture reaches the board at all.
///
/// Orientation is always white-at-bottom for spectating, regardless of which
/// side is "you" (there is no "you") — per the task brief.
@Observable
@MainActor
final class SpectateBoardControl: BoardControl {
    private let store: SpectateStore

    init(store: SpectateStore) {
        self.store = store
    }

    private var state: SpectateGameState? { store.game }

    var fen: String { state?.fen ?? ChessBoard.startFEN }

    let orientation: PieceColor = .white
    let myTurn = false
    let canPremove = false

    var legalMoves: [String] { [] }
    var lastMove: String? { state?.lastMove }
    var showCheck: Bool { Variant.hasCheck(state?.variant) }

    var duckSquare: String? {
        guard let duck = state?.duck, !duck.isEmpty else { return nil }
        return duck
    }

    var pocket: String? { state?.pocket }

    let duckPlacementActive = false
    let inputMethod: BoardInputMethod = .clickOnly
    let autoQueen = true

    /// Read-only: the board never has anything to submit. `SpectateStore`
    /// exposes no move sender at all — this simply satisfies the protocol.
    func submit(_ uci: String) {}
    func submitDuckPlacement(_ square: String) {}
}
