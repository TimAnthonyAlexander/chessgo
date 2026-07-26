import SwiftUI

/// The iOS analog of the web `BoardPage` component
/// (`frontend/src/components/BoardPage.tsx`): the ONE place board+eval-bar
/// geometry lives, so every board screen renders the board identically — a
/// real SQUARE, with an eval bar (when shown) reserved to its LEFT at a
/// fixed width that contributes zero extra layout height, so toggling the
/// eval bar never resizes/moves the board. Reserving the gutter whenever
/// `showsEvalBar` is true (rather than only while an eval value exists)
/// mirrors the web's "reserved gutter" idea, kept simple here for a phone's
/// single column.
///
/// Geometry: `side = availableWidth − (showsEvalBar ? evalWidth + gap : 0)`.
/// The board renders at `side × side`. The eval bar (if shown) renders at
/// `evalWidth × side` — EXACTLY the board's height, never taller. The whole
/// stage is exactly `side` tall, no extra vertical space.
struct BoardStage<EvalBar: View, Board: View>: View {
    /// Single source of truth for eval-bar width and the board/bar gap —
    /// every board+eval-bar screen defers to these instead of hand-rolling
    /// its own numbers.
    static var evalWidth: CGFloat { 28 }
    static var gap: CGFloat { Theme.Spacing.sm }

    var showsEvalBar: Bool = true
    @ViewBuilder var evalBar: () -> EvalBar
    @ViewBuilder var board: () -> Board

    /// The width actually offered to the stage, read via `widthReader`
    /// below. Held in state (rather than computed inline inside a plain
    /// `GeometryReader`) so measuring it never lets the stage itself claim
    /// unbounded vertical space in a VStack before the real, exact
    /// `side`-tall frame is known — see `widthReader`.
    @State private var availableWidth: CGFloat = 0

    private var side: CGFloat {
        let gutter = showsEvalBar ? Self.evalWidth + Self.gap : 0
        return max(0, availableWidth - gutter)
    }

    var body: some View {
        HStack(spacing: Self.gap) {
            if showsEvalBar {
                evalBar()
                    .frame(width: Self.evalWidth, height: side)
            }
            board()
                .frame(width: side, height: side)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: side)
        .background(widthReader)
    }

    /// `.background` is always resolved to this HStack's own frame — width:
    /// the full offered width (`.frame(maxWidth: .infinity)` above), height:
    /// `side` — so this reads the TRUE available width regardless of
    /// `side`'s current value (no circularity), and never grabs extra
    /// vertical space itself since it's confined to the host's own bounds.
    private var widthReader: some View {
        GeometryReader { geo in
            Color.clear
                .onAppear { availableWidth = geo.size.width }
                .onChange(of: geo.size.width) { _, newWidth in
                    availableWidth = newWidth
                }
        }
    }
}

extension BoardStage where EvalBar == EmptyView {
    /// Convenience for a board with no eval bar at all — `showsEvalBar`
    /// defaults false and the board simply gets the full available width.
    init(@ViewBuilder board: @escaping () -> Board) {
        self.showsEvalBar = false
        self.evalBar = { EmptyView() }
        self.board = board
    }
}

#Preview("BoardStage — with eval bar") {
    BoardStage(showsEvalBar: true) {
        EvalBar(eval: EvalScore(type: "cp", value: 180), sideToMove: .white)
    } board: {
        BoardView(control: PreviewBoardControl(
            fen: ChessBoard.startFEN,
            orientation: .white,
            myTurn: true,
            legalMoves: ["e2e4", "d2d4", "g1f3"]
        ))
    }
    .padding(Theme.Spacing.md)
    .background(Theme.Colors.background)
}

#Preview("BoardStage — no eval bar") {
    BoardStage {
        BoardView(control: PreviewBoardControl(
            fen: ChessBoard.startFEN,
            orientation: .white,
            myTurn: true,
            legalMoves: ["e2e4", "d2d4", "g1f3"]
        ))
    }
    .padding(Theme.Spacing.md)
    .background(Theme.Colors.background)
}
