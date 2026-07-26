import SwiftUI

/// Purely cosmetic board-rendering knobs, sourced from `SettingsStore` by the
/// hosting view. Every field defaults to the previous hardcoded behavior, so
/// call sites that don't pass this (previews, other screens not wired to
/// settings yet) render exactly as before.
struct BoardDisplayOptions {
    var showCoordinates: Bool = true
    var highlightLastMove: Bool = true
    var showLegalMoves: Bool = true
    /// 0.7-1.0, mirrors `SettingsStore.boardBrightness`.
    var boardBrightness: Double = 1.0

    static let `default` = BoardDisplayOptions()

    init(
        showCoordinates: Bool = true,
        highlightLastMove: Bool = true,
        showLegalMoves: Bool = true,
        boardBrightness: Double = 1.0
    ) {
        self.showCoordinates = showCoordinates
        self.highlightLastMove = highlightLastMove
        self.showLegalMoves = showLegalMoves
        self.boardBrightness = boardBrightness
    }

    init(_ settings: SettingsStore) {
        showCoordinates = settings.showCoordinates
        highlightLastMove = settings.highlightLastMove
        showLegalMoves = settings.showLegalMoves
        boardBrightness = settings.boardBrightness
    }
}

/// The 8x8 board renderer. Driven entirely by a `BoardControl` — it never
/// decides legality, it only lays out `control.fen`, filters
/// `control.legalMoves` down to whatever the user just touched, and calls
/// `control.submit`.
///
/// Three mechanisms worth reading before touching this file:
///
/// 1. **One commit path.** Tap-to-move and drag both resolve to the same
///    `attemptMove(from:to:)`, which either calls `attemptStandardMove`
///    (your turn — checked against `legalMoves`, may show `PromotionPicker`)
///    or `queuePremove` (not your turn — permissive `premoveTargets`
///    geometry). `commit(_:)` is the single place that sets the optimistic
///    `pendingUci` and calls `control.submit`.
///
/// 2. **Premove hand-off.** Queued premoves live in `premoveChain`
///    (Chess/Premove.swift). The board renders `premoveChain.folded(over:)`
///    on top of the live position, so a queued chain visually "plays out"
///    immediately. Every time `control.fen` or `control.myTurn` changes,
///    `handleTurnHandoffIfNeeded()` runs: if it's now the human's turn and
///    the chain is non-empty, match the head against the real
///    `legalMoves` — a match commits it (through the same `commit(_:)` as
///    any other move) and drops it from the chain; a mismatch discards the
///    WHOLE chain. `pendingUci` (not the chain) is what keeps the
///    just-submitted head visible without a flicker while the server
///    confirms — see the doc comment on `pendingUci` below.
///
/// 3. **Duck two-phase.** See the doc comment on `BoardControl.
///    submitDuckPlacement` — the driver holds the phase state, the board
///    only reacts to `control.duckPlacementActive` by letting the next tap
///    on an empty square go to `submitDuckPlacement` instead of a normal move.
///
/// Crazyhouse drops are tap-arm-then-tap-place: `armedDrop` is a `Binding`
/// shared with `PocketView` so the two views agree on which piece is armed.
struct BoardView: View {
    let control: any BoardControl
    @Binding private var armedDrop: PieceKind?

    /// Cosmetic "Flip board" toggle a hosting view can offer (e.g.
    /// `BotGameView`'s Flip button) — layered on top of `control.orientation`
    /// here rather than a `.rotationEffect` on the whole view, so pieces
    /// render upright no matter which side is at the bottom.
    private let flipped: Bool
    private let displayOptions: BoardDisplayOptions

    init(
        control: any BoardControl,
        armedDrop: Binding<PieceKind?> = .constant(nil),
        flipped: Bool = false,
        displayOptions: BoardDisplayOptions = .default
    ) {
        self.control = control
        self._armedDrop = armedDrop
        self.flipped = flipped
        self.displayOptions = displayOptions
    }

    @State private var selected: Square?
    @State private var dragOrigin: Square?
    @State private var dragLocation: CGPoint?
    @State private var premoveChain: PremoveChain = .empty
    @State private var pendingPromotion: PendingPromotion?

    /// The move/drop/duck string just handed to `control.submit`, kept
    /// visible on the board (folded on top of `control.fen`) until the fen
    /// actually changes. This is what makes a submitted premove-chain head
    /// (or any ordinary move) look instant instead of reverting for a beat
    /// while the network round trip is in flight.
    @State private var pendingUci: String?

    private struct PendingPromotion {
        let from: Square
        let to: Square
        let options: [PieceKind]
    }

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            boardContent(side: side)
                .frame(width: side, height: side)
                .position(x: geo.size.width / 2, y: geo.size.height / 2)
        }
        .onChange(of: control.fen) { _, _ in
            pendingUci = nil
            handleTurnHandoffIfNeeded()
        }
        .onChange(of: control.myTurn) { _, _ in
            handleTurnHandoffIfNeeded()
        }
    }

    private func boardContent(side: CGFloat) -> some View {
        let cell = side / 8
        return ZStack {
            VStack(spacing: 0) {
                ForEach(0..<8, id: \.self) { row in
                    HStack(spacing: 0) {
                        ForEach(0..<8, id: \.self) { col in
                            squareView(squareAt(row: row, col: col), cellSize: cell, isBottomRow: row == 7, isLeftColumn: col == 0)
                        }
                    }
                }
            }
            if let piece = draggedPiece, let dragLocation {
                PieceView(piece: piece)
                    .frame(width: cell * 0.94, height: cell * 0.94)
                    .position(dragLocation)
                    .allowsHitTesting(false)
            }
            if let pending = pendingPromotion {
                PromotionPicker(color: control.orientation, options: pending.options) { kind in
                    resolvePromotion(pending, kind: kind)
                }
            }
        }
        .contentShape(Rectangle())
        .gesture(dragGesture(side: side))
    }

    // MARK: - Board state derived from the control

    private var baseBoard: ChessBoard {
        var board = ChessBoard(fen: control.fen)
        if let alg = control.duckSquare, let square = Square(algebraic: alg) {
            board = board.withDuckSquare(square)
        }
        board = board.withPocket(control.pocket)
        return board
    }

    private var displayBoard: ChessBoard {
        var board = baseBoard
        if let pendingUci { board = board.applying(pendingUci) }
        return premoveChain.folded(over: board)
    }

    private var draggedPiece: Piece? {
        dragOrigin.flatMap { displayBoard.piece(at: $0) }
    }

    private var targetsForSelected: Set<Square> {
        guard let selected else { return [] }
        if control.myTurn {
            return Set(control.legalMoves.compactMap { Move(uci: $0) }.filter { $0.from == selected }.map(\.to))
        }
        if control.canPremove {
            return Set(premoveTargets(from: selected, board: displayBoard))
        }
        return []
    }

    private var premoveChainSquares: Set<Square> {
        Set(premoveChain.moves.flatMap { [$0.from, $0.to] })
    }

    private var lastMoveSquares: Set<Square> {
        guard let lastMove = control.lastMove, let wire = WireMove(uci: lastMove) else { return [] }
        switch wire {
        case .standard(let move): return [move.from, move.to]
        case .drop(let drop): return [drop.target]
        case .duck(let duck): return [duck.pieceMove.from, duck.pieceMove.to, duck.duckTarget]
        }
    }

    private var checkedKingSquare: Square? {
        guard control.inCheck else { return nil }
        let king = Piece(color: baseBoard.sideToMove, kind: .king)
        return Square.all.first { baseBoard.piece(at: $0) == king }
    }

    // MARK: - Square layout (orientation-aware)

    /// The color rendered at the bottom of the board: `control.orientation`
    /// (the human's real color — still what ownership/premove checks use)
    /// XORed with the cosmetic `flipped` toggle.
    private var effectiveBottomColor: PieceColor {
        flipped ? control.orientation.opposite : control.orientation
    }

    private func squareAt(row: Int, col: Int) -> Square {
        let rank = effectiveBottomColor == .white ? 7 - row : row
        let file = effectiveBottomColor == .white ? col : 7 - col
        return Square(file: file, rank: rank) ?? Square(file: 0, rank: 0)!
    }

    private func square(at location: CGPoint, side: CGFloat) -> Square? {
        let cell = side / 8
        guard cell > 0 else { return nil }
        let col = Int(location.x / cell)
        let row = Int(location.y / cell)
        guard (0..<8).contains(col), (0..<8).contains(row) else { return nil }
        return squareAt(row: row, col: col)
    }

    // MARK: - Square rendering

    @ViewBuilder
    private func squareView(_ square: Square, cellSize: CGFloat, isBottomRow: Bool, isLeftColumn: Bool) -> some View {
        let isLight = (square.file + square.rank) % 2 == 1
        ZStack {
            (isLight ? Theme.Colors.boardLight : Theme.Colors.boardDark)
                .brightness(-(1 - displayOptions.boardBrightness))
            if displayOptions.highlightLastMove, lastMoveSquares.contains(square) { Theme.Colors.lastMove }
            if checkedKingSquare == square { Theme.Colors.check }
            if premoveChainSquares.contains(square) { Theme.Colors.accent.opacity(0.22) }
            if selected == square { Theme.Colors.boardHighlight }

            if let piece = displayBoard.piece(at: square), dragOrigin != square {
                PieceView(piece: piece).padding(cellSize * 0.06)
            }
            if displayBoard.duckSquare == square { duckMarker(cellSize: cellSize) }
            if displayOptions.showLegalMoves, targetsForSelected.contains(square) { targetDot(cellSize: cellSize) }
            if displayOptions.showLegalMoves, isArmedDropTarget(square) { targetDot(cellSize: cellSize) }
            if control.duckPlacementActive, displayBoard.piece(at: square) == nil {
                Circle().fill(Theme.Colors.warning.opacity(0.35)).padding(cellSize * 0.3)
            }
            if displayOptions.showCoordinates {
                coordinateLabel(square: square, cellSize: cellSize, isBottomRow: isBottomRow, isLeftColumn: isLeftColumn)
            }
        }
        .frame(width: cellSize, height: cellSize)
        .contentShape(Rectangle())
        .onTapGesture { handleTap(square) }
    }

    /// Small file-letter (bottom row) / rank-number (left column) overlay,
    /// tinted to the opposite square shade so it stays legible without a
    /// dedicated coordinate gutter. Both `if`s can be false (interior
    /// squares) — that's just an empty overlay.
    @ViewBuilder
    private func coordinateLabel(square: Square, cellSize: CGFloat, isBottomRow: Bool, isLeftColumn: Bool) -> some View {
        let isLight = (square.file + square.rank) % 2 == 1
        let tint = (isLight ? Theme.Colors.boardDark : Theme.Colors.boardLight).opacity(0.85)
        VStack {
            if isLeftColumn {
                HStack {
                    Text("\(square.rank + 1)")
                        .font(.system(size: cellSize * 0.17, weight: .semibold))
                        .foregroundStyle(tint)
                    Spacer()
                }
            }
            Spacer(minLength: 0)
            if isBottomRow {
                HStack {
                    Spacer()
                    Text(String(square.algebraic.first!))
                        .font(.system(size: cellSize * 0.17, weight: .semibold))
                        .foregroundStyle(tint)
                }
            }
        }
        .padding(cellSize * 0.05)
        .allowsHitTesting(false)
    }

    private func isArmedDropTarget(_ square: Square) -> Bool {
        guard let armedDrop, displayBoard.piece(at: square) == nil else { return false }
        return control.legalMoves.contains("\(armedDrop.fenLetter)@\(square.algebraic)")
    }

    private func duckMarker(cellSize: CGFloat) -> some View {
        ZStack {
            Circle().fill(Color.yellow).frame(width: cellSize * 0.5, height: cellSize * 0.5)
            Image(systemName: "bird.fill")
                .font(.system(size: cellSize * 0.26))
                .foregroundStyle(.black.opacity(0.75))
        }
    }

    private func targetDot(cellSize: CGFloat) -> some View {
        Circle().fill(Theme.Colors.accent.opacity(0.55)).frame(width: cellSize * 0.28, height: cellSize * 0.28)
    }

    // MARK: - Gestures

    private func isOwnPiece(at square: Square) -> Bool {
        guard let color = displayBoard.piece(at: square)?.color else { return false }
        if control.movesBothSides { return color == displayBoard.sideToMove }
        return color == control.orientation
    }

    private func handleTap(_ square: Square) {
        guard control.inputMethod != .dragOnly else { return }

        if control.duckPlacementActive {
            handleDuckPlacementTap(square)
            return
        }
        if let armedDrop, displayBoard.piece(at: square) == nil {
            attemptDrop(armedDrop, at: square)
            return
        }
        guard control.myTurn || control.canPremove else { return }

        if let previouslySelected = selected {
            selected = nil
            if previouslySelected == square { return }
            if isOwnPiece(at: square) {
                selected = square
                return
            }
            attemptMove(from: previouslySelected, to: square)
            return
        }
        if isOwnPiece(at: square) { selected = square }
    }

    private func dragGesture(side: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .local)
            .onChanged { value in
                guard control.inputMethod != .clickOnly, armedDrop == nil, !control.duckPlacementActive else { return }
                if dragOrigin == nil {
                    guard let origin = square(at: value.startLocation, side: side), isOwnPiece(at: origin) else { return }
                    dragOrigin = origin
                    selected = nil
                }
                dragLocation = value.location
            }
            .onEnded { value in
                defer { dragOrigin = nil; dragLocation = nil }
                guard let origin = dragOrigin else { return }
                if let target = square(at: value.location, side: side) {
                    attemptMove(from: origin, to: target)
                }
            }
    }

    // MARK: - Commit paths

    private func attemptMove(from: Square, to: Square) {
        guard from != to else { return }
        if control.myTurn {
            attemptStandardMove(from: from, to: to)
        } else if control.canPremove {
            queuePremove(from: from, to: to)
        }
    }

    private func attemptStandardMove(from: Square, to: Square) {
        let matches = control.legalMoves.filter { uci in
            guard let move = Move(uci: uci) else { return false }
            return move.from == from && move.to == to
        }
        guard !matches.isEmpty else { return }

        let promotionOptions = matches.compactMap { Move(uci: $0)?.promotion }
        if promotionOptions.count > 1, !control.autoQueen {
            pendingPromotion = PendingPromotion(from: from, to: to, options: promotionOptions)
            return
        }
        let uci = promotionOptions.count > 1 ? "\(from.algebraic)\(to.algebraic)q" : (matches.first ?? "\(from.algebraic)\(to.algebraic)")
        commit(uci)
    }

    /// Premoves are queued client-only with no server legal-move list to
    /// consult yet, so a pawn reaching the last rank always auto-queens here
    /// — there's no promotion prompt mid-premove. This is a v1 simplification;
    /// `matchedHead` already ignores the promotion piece when it re-validates
    /// against the real `legalMoves` on your turn, so a wrong guess never
    /// sends an illegal move, it just isn't necessarily the piece you wanted.
    private func queuePremove(from: Square, to: Square) {
        guard let piece = displayBoard.piece(at: from) else { return }
        var promotion: PieceKind?
        if piece.kind == .pawn, to.rank == (piece.color == .white ? 7 : 0) {
            promotion = .queen
        }
        premoveChain = premoveChain.appending(Move(from: from, to: to, promotion: promotion))
    }

    private func attemptDrop(_ kind: PieceKind, at square: Square) {
        let uci = "\(kind.fenLetter)@\(square.algebraic)"
        guard control.legalMoves.contains(uci) else { return }
        armedDrop = nil
        commit(uci)
    }

    private func handleDuckPlacementTap(_ square: Square) {
        guard displayBoard.piece(at: square) == nil else { return }
        control.submitDuckPlacement(square.algebraic)
    }

    private func resolvePromotion(_ pending: PendingPromotion, kind: PieceKind) {
        commit("\(pending.from.algebraic)\(pending.to.algebraic)\(String(kind.fenLetter).lowercased())")
    }

    private func commit(_ uci: String) {
        pendingUci = uci
        selected = nil
        pendingPromotion = nil
        control.submit(uci)
    }

    private func handleTurnHandoffIfNeeded() {
        guard control.myTurn, !premoveChain.isEmpty else { return }
        if let matchedUci = premoveChain.matchedHead(against: control.legalMoves) {
            premoveChain = premoveChain.droppingFirst()
            commit(matchedUci)
        } else {
            premoveChain = .empty
        }
    }
}

#Preview("BoardView — white orientation, mid-game") {
    BoardView(control: PreviewBoardControl(
        fen: "r1bqk2r/ppp2ppp/2n2n2/2bpp3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 2 6",
        orientation: .white,
        myTurn: true,
        legalMoves: ["g1f3", "d1e2", "e1g1", "f3e5", "f3d4", "f3g5", "f3h4", "b1c3", "b1d2", "a2a3", "a2a4"],
        lastMove: "d7d5"
    ))
    .padding()
    .background(Theme.Colors.background)
}

#Preview("BoardView — black orientation, in check") {
    BoardView(control: PreviewBoardControl(
        fen: "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",
        orientation: .black,
        myTurn: true,
        legalMoves: ["e1e2", "g1h3", "d1e2"],
        lastMove: "d8h4",
        inCheck: true
    ))
    .padding()
    .background(Theme.Colors.background)
}
