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
        /// is no legal-move generator to produce real algebraic notation, so
        /// it falls back to the UCI string itself (see `submit(_:)`).
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

    /// 11 rungs, shallow-to-deep (frontend-features.md: "poll 11-rung depth
    /// ladder (6/1200ms → 30/35000ms)"). Intermediate steps are an even
    /// spread between those two documented endpoints.
    private static let ladder: [(depth: Int, movetimeMs: Int)] = [
        (6, 1200), (8, 2000), (10, 3200), (12, 5000), (14, 7500),
        (16, 10500), (18, 14000), (20, 18000), (23, 23000), (26, 29000), (30, 35000),
    ]

    // MARK: - BoardControl

    let orientation: PieceColor = .white
    let myTurn: Bool = true
    let canPremove: Bool = false
    /// Analysis is free-explore: the human moves whichever side is to move,
    /// not just `orientation`'s (fixed white-at-bottom) color.
    let movesBothSides: Bool = true
    private(set) var legalMoves: [String] = []

    var fen: String { steps[safe: currentIndex]?.fen ?? ChessBoard.startFEN }
    var lastMove: String? { steps[safe: currentIndex]?.uci }

    /// No server check flag exists for an arbitrary viewed position — this
    /// reads the "+"/"#" suffix off the step's own SAN the way `BotGameDriver`
    /// does off a bot move's SAN. Always false for a locally-played step,
    /// since those fall back to plain UCI text with no such suffix.
    var inCheck: Bool {
        guard let san = steps[safe: currentIndex]?.san else { return false }
        return san.hasSuffix("+") || san.hasSuffix("#")
    }

    var currentStep: Step? { steps[safe: currentIndex] }

    /// UCI history from the start position up to (not including) the
    /// currently-viewed step — passed to `/candidates` so opening lookups
    /// stay unambiguous.
    var historyUci: [String] {
        guard currentIndex > 0, steps.count > 1 else { return [] }
        return steps[1...currentIndex].compactMap { $0.uci }
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
        restartLiveEval()
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
        restartLiveEval()
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
        restartLiveEval()
    }

    // MARK: - BoardControl: submit

    /// Applies a permissively-generated move visually (`ChessBoard.applying`
    /// is best-effort rendering only, never a legality judge), truncates any
    /// steps after the one currently viewed, and appends the result as a new
    /// step — a branch off the mainline whenever the played move isn't the
    /// one the loaded game actually continued with.
    func submit(_ uci: String) {
        guard legalMoves.contains(uci) else { return }
        let nextFen = ChessBoard(fen: fen).applying(uci).fen()
        let newStep = Step(
            ply: (steps[safe: currentIndex]?.ply ?? 0) + 1,
            fen: nextFen,
            san: uci, // no client-side legal-move generator to produce real SAN
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
        restartLiveEval()
    }

    // MARK: - Legal-move geometry

    private func refreshLegalMoves() {
        legalMoves = Self.permissiveLegalMoves(fen: fen)
    }

    /// Every pseudo-legal destination for every piece belonging to the side
    /// to move, using the same permissive premove geometry the board already
    /// uses elsewhere (ignores pins/check — there is no server to re-verify
    /// against here, so this IS the final word for what's offered).
    private static func permissiveLegalMoves(fen: String) -> [String] {
        let board = ChessBoard(fen: fen)
        var out: [String] = []
        for square in Square.all {
            guard let piece = board.piece(at: square), piece.color == board.sideToMove else { continue }
            for target in premoveTargets(from: square, board: board) {
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

    // MARK: - Live eval ladder

    /// Cancels any in-flight ladder and starts a fresh one against the
    /// currently-viewed step's fen. Call on every navigation/position change
    /// (stepping, submitting a move, or a fresh review load).
    private func restartLiveEval() {
        evalTask?.cancel()
        liveEval = nil
        let targetFen = fen

        evalTask = Task {
            isEvalRunning = true
            defer { isEvalRunning = false }
            for rung in Self.ladder {
                if Task.isCancelled { return }
                guard let outcome = try? await AnalysisService.shared.analyze(
                    fen: targetFen, movetime: rung.movetimeMs, depth: rung.depth
                ) else { continue }
                if Task.isCancelled { return }
                guard self.fen == targetFen else { return } // moved on already
                self.liveEval = outcome
            }
        }
    }

    /// Called by the hosting view on disappear/navigation-away so a deep
    /// rung still resolving in the background doesn't keep running.
    func cancelLiveEval() {
        evalTask?.cancel()
        evalTask = nil
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
