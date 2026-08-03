import Foundation

/// Drives the analysis board through `BoardControl` in either of two modes:
///
/// - **Game review** (`init(gameId:)`): loads a finished game's cached
///   post-mortem (`GET /games/{id}/analysis`, rest-api.md), retrying a few
///   times on 404 (the persistence race right after a game ends) before
///   giving up. Builds a linear step list straight from the server's
///   per-ply `evalWhite`/`bestUci`/`bestSan`/`judgment` data.
/// - **Free explore** (`init(fen:)`): starts from a scratch position (or the
///   standard start position) with no server analysis at all.
///
/// Either way `myTurn` is always true — this is a sandbox, not a turn-based
/// game — and `legalMoves` is a permissive, engine-agnostic geometry
/// generator (`premoveTargets`, reused from Chess/Premove.swift) rather than
/// a server-verified list, since there is no legal-move endpoint for an
/// arbitrary scratch position. Playing a move on the board (in either mode)
/// truncates everything after the currently-viewed step and starts a fresh
/// local line from there — a one-branch "variation", not a full move tree.
///
/// A single progressive-depth eval ladder always tracks whatever step is
/// currently being viewed (`restartLiveEval`), independent of any
/// server-cached `evalWhite` a review step might already carry — that cached
/// number is shown immediately while the ladder deepens past it.
@Observable
@MainActor
final class AnalysisDriver: BoardControl {
    enum Mode: Sendable, Equatable {
        case review
        case freeExplore
    }

    /// One position in the driven line.
    struct Step: Identifiable, Sendable {
        var id: Int { ply }

        /// 0 = start position, otherwise the 1-based ply that landed here.
        let ply: Int
        let fen: String
        /// The move that led to this step. `nil` at the start position.
        /// In review mode this is server SAN; in a locally-played step there
        /// is no server-verified legal-move list, so `SAN.format` best-effort
        /// derives it from the app's pseudo-legal geometry instead (see
        /// `submit(_:)`).
        let san: String?
        let uci: String?
        /// White-relative, from the cached review analysis only — `nil` for
        /// every locally-played (free-explore or branched) step.
        let evalWhite: EvalScore?
        let bestSan: String?
        let bestUci: String?
        let bestDepth: Int?
        /// "best"/"good"/"inaccuracy"/"mistake"/"blunder" — review only.
        let judgment: String?
    }

    let mode: Mode
    private let gameId: String?

    private(set) var steps: [Step] = []
    private(set) var currentIndex: Int = 0

    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var unsupported = false

    private(set) var whiteName: String?
    private(set) var blackName: String?
    private(set) var result: String?

    /// The progressive eval ladder's latest result for the currently-viewed
    /// step's fen. Resets to `nil` every time the viewed position changes.
    private(set) var liveEval: AnalyzeResult?
    private(set) var isEvalRunning = false
    private var evalTask: Task<Void, Never>?

    /// The MultiPV move list and opening name for the currently-viewed step,
    /// carried by the SAME ladder responses that drive `liveEval` — the
    /// opening explorer used to run its own second `/candidates` search of the
    /// identical position, which meant two searches that could (and did)
    /// disagree with each other and with the eval bar. One search now feeds
    /// both. Deep rungs return no lines by design (see `ladder`), so these are
    /// only ever REPLACED by a response that actually carries lines, never
    /// cleared by one that doesn't.
    private(set) var analysisLines: [AnalysisLine] = []
    private(set) var analysisOpening: Opening?

    /// Full-strength Stockfish "second opinion" (`POST /sf-analyze`) for the
    /// currently-viewed step's fen — the ONE source both `EngineLinesPanel`'s
    /// row and `AnalysisView`'s violet arrow read, so they can never disagree
    /// or double-fetch. Off by default; flipping it on (either from the
    /// panel's toggle or the board's SF-arrow toggle — they share this same
    /// flag) kicks off a fetch immediately, and every subsequent position
    /// change re-fetches while it stays on.
    var sfEnabled: Bool = false {
        didSet {
            guard sfEnabled != oldValue else { return }
            if sfEnabled {
                restartSfFetch()
            } else {
                sfTask?.cancel()
                sfTask = nil
                sfResult = nil
                sfError = nil
                sfLoading = false
            }
        }
    }
    private(set) var sfResult: SfAnalyzeResult?
    private(set) var sfLoading = false
    private(set) var sfError: String?
    private var sfTask: Task<Void, Never>?

    /// 11 rungs, shallow-to-deep (frontend-features.md: "poll 11-rung depth
    /// ladder (6/1200ms → 30/35000ms)"). Intermediate steps are an even
    /// spread between those two documented endpoints.
    ///
    /// `multipv` is per-rung and DROPS TO 1 past `linesMaxDepth`, matching the
    /// web ladder. Asking for N lines makes the engine run N root searches per
    /// iteration — measured ~4.4x the wall clock of one line at depth 22, and
    /// Stockfish pays the same ~4.6x, so it is inherent to alpha-beta rather
    /// than something either engine can optimize away. The move list does not
    /// need depth 30 to be useful; the eval bar does. So the deep tail buys
    /// depth instead of width, and the panel keeps the lines the shallower
    /// rungs already delivered (results only ever REPLACE lines when they
    /// carry some).
    private static let linesMaxDepth = 16
    private static let ladder: [(depth: Int, movetimeMs: Int, multipv: Int)] = [
        (6, 1200, 5), (8, 2000, 5), (10, 3200, 5), (12, 5000, 5), (14, 7500, 5),
        (16, 10500, 5), (18, 14000, 1), (20, 18000, 1), (23, 23000, 1),
        (26, 29000, 1), (30, 35000, 1),
    ]

    // MARK: - BoardControl

    let orientation: PieceColor = .white
    let myTurn: Bool = true
    let canPremove: Bool = false
    /// Analysis is free-explore: the human moves whichever side is to move,
    /// not just `orientation`'s (fixed white-at-bottom) color.
    let movesBothSides: Bool = true
    private(set) var legalMoves: [String] = []

    /// Injected by `AnalysisView` (`onAppear`) so playing a move on the board
    /// makes the same sound it does everywhere else — a plain `@Observable`
    /// store can't read `@Environment`, so the view hands the settings in
    /// (same pattern as `LiveGameDriver`/`SpectateStore`).
    var appSettings: SettingsStore?
    private var soundVolume: Double {
        guard let appSettings, appSettings.soundEnabled else { return 0 }
        return appSettings.soundVolume
    }

    var fen: String { steps[safe: currentIndex]?.fen ?? ChessBoard.startFEN }
    var lastMove: String? { steps[safe: currentIndex]?.uci }

    var currentStep: Step? { steps[safe: currentIndex] }

    /// Prior-position FENs, root→previous (excluding the currently-viewed
    /// step), for the engine's opening lookup.
    ///
    /// This used to send UCI moves (`historyUci`), which the endpoint quietly
    /// threw away: server-side every history entry is validated as a FEN and
    /// skipped if it isn't one, so a list of `["e2e4", "e7e5"]` reduced to an
    /// EMPTY history. The opening name was then only ever classified from the
    /// current position's own key, never the deepest match along the line —
    /// which is why iOS could name a transposition differently from the web.
    var historyFens: [String] {
        guard currentIndex > 0 else { return [] }
        return steps[0..<currentIndex].map(\.fen)
    }

    // MARK: - Init

    init(gameId: String) {
        mode = .review
        self.gameId = gameId
    }

    init(fen: String? = nil) {
        mode = .freeExplore
        gameId = nil
        let start = fen ?? ChessBoard.startFEN
        steps = [Step(ply: 0, fen: start, san: nil, uci: nil, evalWhite: nil, bestSan: nil, bestUci: nil, bestDepth: nil, judgment: nil)]
        currentIndex = 0
        refreshLegalMoves()
        onPositionChanged()
    }

    // MARK: - Loading (review mode)

    /// Idempotent — safe to call again after a failure (`steps` is still
    /// empty), and a no-op once analysis has already loaded.
    func load() async {
        guard mode == .review, let gameId, steps.isEmpty, !unsupported else { return }
        isLoading = true
        loadError = nil
        defer { isLoading = false }

        for attempt in 0..<5 {
            do {
                let analysis = try await AnalysisService.shared.gameAnalysis(id: gameId)
                apply(analysis)
                return
            } catch let error as APIError {
                if error.statusCode == 404, attempt < 4 {
                    try? await Task.sleep(nanoseconds: 1_200_000_000)
                    continue
                }
                loadError = error.statusCode == 404
                    ? "Analysis isn't ready yet. Try again in a moment."
                    : error.errorDescription
                return
            } catch {
                loadError = error.localizedDescription
                return
            }
        }
    }

    private func apply(_ analysis: GameAnalysis) {
        guard !analysis.unsupported else {
            unsupported = true
            return
        }
        whiteName = analysis.whiteName
        blackName = analysis.blackName
        result = analysis.result

        var built: [Step] = []
        if let startFen = analysis.startFen {
            built.append(Step(ply: 0, fen: startFen, san: nil, uci: nil, evalWhite: nil, bestSan: nil, bestUci: nil, bestDepth: nil, judgment: nil))
        }
        for ply in analysis.plies {
            guard let plyFen = ply.fen else { continue }
            built.append(Step(
                ply: ply.ply,
                fen: plyFen,
                san: ply.move?.san,
                uci: ply.move?.uci,
                evalWhite: ply.evalWhite.map { EvalScore(type: $0.type, value: $0.white) },
                bestSan: ply.bestSan,
                bestUci: ply.bestUci,
                bestDepth: ply.bestDepth,
                judgment: ply.move?.judgment
            ))
        }
        guard !built.isEmpty else {
            loadError = "No analysis data for this game."
            return
        }
        steps = built
        currentIndex = 0
        refreshLegalMoves()
        onPositionChanged()
    }

    // MARK: - Stepping

    func stepToStart() { setIndex(0) }
    func stepBack() { setIndex(currentIndex - 1) }
    func stepForward() { setIndex(currentIndex + 1) }
    func stepToEnd() { setIndex(steps.count - 1) }

    func jump(toPly ply: Int) {
        guard let index = steps.firstIndex(where: { $0.ply == ply }) else { return }
        setIndex(index)
    }

    private func setIndex(_ index: Int) {
        guard steps.indices.contains(index), index != currentIndex else { return }
        currentIndex = index
        refreshLegalMoves()
        onPositionChanged()
    }

    // MARK: - BoardControl: submit

    /// Applies a permissively-generated move visually (`ChessBoard.applying`
    /// is best-effort rendering only, never a legality judge), truncates any
    /// steps after the one currently viewed, and appends the result as a new
    /// step — a branch off the mainline whenever the played move isn't the
    /// one the loaded game actually continued with.
    func submit(_ uci: String) {
        guard legalMoves.contains(uci) else { return }
        let preBoard = ChessBoard(fen: fen)
        let nextFen = preBoard.applying(uci).fen()
        let newStep = Step(
            ply: (steps[safe: currentIndex]?.ply ?? 0) + 1,
            fen: nextFen,
            san: SAN.format(uci: uci, board: preBoard),
            uci: uci,
            evalWhite: nil,
            bestSan: nil,
            bestUci: nil,
            bestDepth: nil,
            judgment: nil
        )
        steps = Array(steps[0...currentIndex]) + [newStep]
        currentIndex = steps.count - 1
        refreshLegalMoves()
        onPositionChanged()

        let volume = soundVolume
        if volume > 0 {
            SoundEngine.shared.play(Self.soundEvent(uci: uci, preBoard: preBoard), volume: volume)
        }
    }

    /// Picks the move sound from the move + the board BEFORE it was played.
    /// Reads the move geometry directly rather than parsing `SAN.format`'s
    /// output back apart — cheaper, and this runs on every submitted move.
    private static func soundEvent(uci: String, preBoard: ChessBoard) -> SoundEngine.SoundEvent {
        guard let move = Move(uci: uci) else { return .move }
        let mover = preBoard.piece(at: move.from)
        // Castle: the king steps two files.
        if mover?.kind == .king, abs(move.to.file - move.from.file) == 2 { return .castle }
        // Capture: destination occupied, or an en-passant pawn capture (a pawn
        // changing file onto an empty square).
        let destOccupied = preBoard.piece(at: move.to) != nil
        let enPassant = mover?.kind == .pawn && move.from.file != move.to.file && !destOccupied
        if destOccupied || enPassant { return .capture }
        if move.promotion != nil { return .promote }
        return .move
    }

    // MARK: - Legal-move geometry

    private func refreshLegalMoves() {
        legalMoves = Self.permissiveLegalMoves(fen: fen)
    }

    /// Every pseudo-legal destination for every piece belonging to the side to
    /// move (ignores pins/check — there is no server to re-verify against
    /// here, so this IS the final word for what's offered). Unlike
    /// `premoveTargets` (Chess/Premove.swift), which is deliberately blind to
    /// occupancy because a premove's board state at execution time is
    /// unknown, the analysis board always knows the CURRENT position exactly
    /// — so this respects it: pawns can't capture into empty air or jump a
    /// blocker, sliders stop at the first piece, and nothing lands on a
    /// friendly square.
    private static func permissiveLegalMoves(fen: String) -> [String] {
        let board = ChessBoard(fen: fen)
        var out: [String] = []
        for square in Square.all {
            guard let piece = board.piece(at: square), piece.color == board.sideToMove else { continue }
            for target in pseudoLegalTargets(from: square, piece: piece, board: board) {
                let promotionRank = piece.color == .white ? 7 : 0
                if piece.kind == .pawn, target.rank == promotionRank {
                    for promo: PieceKind in [.queen, .rook, .bishop, .knight] {
                        out.append(Move(from: square, to: target, promotion: promo).uci)
                    }
                } else {
                    out.append(Move(from: square, to: target).uci)
                }
            }
        }
        return out
    }

    /// Occupancy-aware destinations for one piece on the given (known)
    /// board — the analysis-board counterpart to `premoveTargets`.
    private static func pseudoLegalTargets(from: Square, piece: Piece, board: ChessBoard) -> [Square] {
        var out: [Square] = []

        func target(_ file: Int, _ rank: Int) -> Square? {
            Square(file: file, rank: rank)
        }

        switch piece.kind {
        case .pawn:
            let direction = piece.color == .white ? 1 : -1
            let startRank = piece.color == .white ? 1 : 6
            if let oneAhead = target(from.file, from.rank + direction), board.piece(at: oneAhead) == nil {
                out.append(oneAhead)
                if from.rank == startRank, let twoAhead = target(from.file, from.rank + 2 * direction),
                   board.piece(at: twoAhead) == nil {
                    out.append(twoAhead)
                }
            }
            for df in [-1, 1] {
                guard let diag = target(from.file + df, from.rank + direction) else { continue }
                if let occupant = board.piece(at: diag), occupant.color != piece.color {
                    out.append(diag)
                } else if diag == board.enPassant {
                    out.append(diag)
                }
            }
        case .knight:
            for (df, dr) in [(1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2)] {
                guard let square = target(from.file + df, from.rank + dr) else { continue }
                if board.piece(at: square)?.color != piece.color { out.append(square) }
            }
        case .king:
            for df in -1...1 {
                for dr in -1...1 where df != 0 || dr != 0 {
                    guard let square = target(from.file + df, from.rank + dr) else { continue }
                    if board.piece(at: square)?.color != piece.color { out.append(square) }
                }
            }
            if from.file == 4 {
                let rank = from.rank
                let rights = board.castlingRights
                let kingsideLetter: Character = piece.color == .white ? "K" : "k"
                let queensideLetter: Character = piece.color == .white ? "Q" : "q"
                if rights.contains(kingsideLetter),
                   let f = target(5, rank), let g = target(6, rank),
                   board.piece(at: f) == nil, board.piece(at: g) == nil {
                    out.append(g)
                }
                if rights.contains(queensideLetter),
                   let d = target(3, rank), let c = target(2, rank), let b = target(1, rank),
                   board.piece(at: d) == nil, board.piece(at: c) == nil, board.piece(at: b) == nil {
                    out.append(c)
                }
            }
        case .bishop, .rook, .queen:
            let directions: [(Int, Int)]
            switch piece.kind {
            case .bishop: directions = [(1, 1), (1, -1), (-1, 1), (-1, -1)]
            case .rook: directions = [(1, 0), (-1, 0), (0, 1), (0, -1)]
            default: directions = [(1, 1), (1, -1), (-1, 1), (-1, -1), (1, 0), (-1, 0), (0, 1), (0, -1)]
            }
            for (df, dr) in directions {
                for i in 1...7 {
                    guard let square = target(from.file + df * i, from.rank + dr * i) else { break }
                    if let occupant = board.piece(at: square) {
                        if occupant.color != piece.color { out.append(square) }
                        break
                    }
                    out.append(square)
                }
            }
        }

        return out
    }

    // MARK: - Live eval ladder

    /// Every navigation/position change (stepping, submitting a move, or a
    /// fresh review load) restarts both the live eval ladder and, if it's
    /// currently on, the Stockfish second opinion — the two independent async
    /// sources this driver keeps warm for whatever step is being viewed.
    private func onPositionChanged() {
        restartLiveEval()
        if sfEnabled { restartSfFetch() }
    }

    /// Cancels any in-flight ladder and starts a fresh one against the
    /// currently-viewed step's fen. Call on every navigation/position change
    /// (stepping, submitting a move, or a fresh review load).
    private func restartLiveEval() {
        evalTask?.cancel()
        liveEval = nil
        analysisLines = []
        analysisOpening = nil
        let targetFen = fen
        let targetHistory = historyFens

        evalTask = Task {
            isEvalRunning = true
            defer { isEvalRunning = false }
            for rung in Self.ladder {
                if Task.isCancelled { return }
                guard let outcome = try? await AnalysisService.shared.analyze(
                    fen: targetFen,
                    movetime: rung.movetimeMs,
                    depth: rung.depth,
                    multipv: rung.multipv > 1 ? rung.multipv : nil,
                    history: targetHistory.isEmpty ? nil : targetHistory
                ) else { continue }
                if Task.isCancelled { return }
                guard self.fen == targetFen else { return } // moved on already
                self.liveEval = outcome
                // Single-line rungs carry no move list — keep what the earlier
                // multi-line rungs produced rather than blanking the panel.
                if !outcome.lines.isEmpty { self.analysisLines = outcome.lines }
                // The opening name rides on EVERY response (it's a book lookup,
                // not a search result), so take it independently of the lines —
                // both were cleared above, and every rung here is the same
                // position, so this can never latch a stale name.
                if let opening = outcome.opening { self.analysisOpening = opening }
            }
        }
    }

    /// Called by the hosting view on disappear/navigation-away so a deep
    /// rung still resolving in the background doesn't keep running.
    func cancelLiveEval() {
        evalTask?.cancel()
        evalTask = nil
        sfTask?.cancel()
        sfTask = nil
    }

    // MARK: - Stockfish second opinion

    /// Cancels any in-flight request and fires a fresh `/sf-analyze` for the
    /// currently-viewed step's fen. Guarded on arrival (not just at kickoff)
    /// so a slow response for a position the user has already navigated away
    /// from never stomps a newer one — same "moved on already" guard the live
    /// eval ladder uses.
    private func restartSfFetch() {
        sfTask?.cancel()
        sfError = nil
        let targetFen = fen

        sfTask = Task {
            sfLoading = true
            defer { sfLoading = false }
            do {
                let result = try await AnalysisService.shared.sfAnalyze(fen: targetFen)
                guard !Task.isCancelled, self.fen == targetFen else { return }
                sfResult = result
            } catch is CancellationError {
                // Superseded by a newer fetch — nothing to report.
            } catch let error as APIError {
                guard !Task.isCancelled, self.fen == targetFen else { return }
                sfError = error.errorDescription
            } catch {
                guard !Task.isCancelled, self.fen == targetFen else { return }
                sfError = error.localizedDescription
            }
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

#if DEBUG
extension AnalysisDriver {
    /// Preview/test-only: seeds a review driver by decoding a literal
    /// `GameAnalysis` JSON payload through the real model — `GameAnalysis` is
    /// `@Default*`-wrapped (SPEC's construction gotcha), so it can't be
    /// hand-built with a memberwise initializer.
    static func previewReview(json: String = previewAnalysisJSON) -> AnalysisDriver {
        let driver = AnalysisDriver(gameId: "preview-game")
        guard let data = json.data(using: .utf8),
              let analysis = try? JSONDecoder().decode(GameAnalysis.self, from: data)
        else { return driver }
        driver.apply(analysis)
        return driver
    }

    nonisolated static let previewAnalysisJSON = """
    {
      "version": 1,
      "variant": "standard",
      "hubGameId": "preview-game",
      "result": "1-0",
      "reason": "checkmate",
      "pool": "blitz",
      "rated": true,
      "whiteName": "alice",
      "blackName": "bob",
      "whiteIsBot": false,
      "blackIsBot": false,
      "startFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "plies": [
        {
          "ply": 1,
          "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
          "sideToMove": "b",
          "evalWhite": {"type": "cp", "white": 25},
          "bestUci": "e2e4",
          "bestSan": "e4",
          "bestPv": ["e2e4", "e7e5"],
          "bestDepth": 18,
          "move": {"uci": "e2e4", "san": "e4", "color": "w", "cpLoss": 0, "isBest": true, "judgment": "best"}
        },
        {
          "ply": 2,
          "fen": "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
          "sideToMove": "w",
          "evalWhite": {"type": "cp", "white": 20},
          "bestUci": "g1f3",
          "bestSan": "Nf3",
          "bestPv": ["g1f3", "b8c6"],
          "bestDepth": 18,
          "move": {"uci": "e7e5", "san": "e5", "color": "b", "cpLoss": 0, "isBest": true, "judgment": "best"}
        },
        {
          "ply": 3,
          "fen": "rnbqkbnr/pppp1ppp/8/4p3/3PP3/8/PPP2PPP/RNBQKBNR b KQkq - 0 3",
          "sideToMove": "b",
          "evalWhite": {"type": "cp", "white": -180},
          "bestUci": "g1f3",
          "bestSan": "Nf3",
          "bestPv": ["g1f3", "b8c6"],
          "bestDepth": 18,
          "move": {"uci": "d2d4", "san": "d4", "color": "w", "cpLoss": 205, "isBest": false, "judgment": "blunder"}
        }
      ],
      "summary": {
        "w": {"best": 2, "good": 0, "inaccuracy": 0, "mistake": 0, "blunder": 1, "acpl": 68.3, "accuracy": 74.2},
        "b": {"best": 2, "good": 0, "inaccuracy": 0, "mistake": 0, "blunder": 0, "acpl": 5.0, "accuracy": 98.0}
      }
    }
    """
}
#endif
