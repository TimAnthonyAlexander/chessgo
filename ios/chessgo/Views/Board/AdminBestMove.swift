import SwiftUI

/// Admin-only inline control: when enabled, fetches the FULL-STRENGTH engine
/// best move for the current position (only while it's the player's own
/// turn) and shows it compactly as `move · continuation · eval · depth`,
/// reporting the move's from/to squares up so the hosting board can light
/// them on a hold-to-reveal peek. Self-contained and admin-gated — hosting
/// views render it BELOW the board, left-aligned (`authStore.user?.role ==
/// "admin"` is checked internally), and feed the current FEN.
///
/// Faithful port of the web `frontend/src/components/AdminBestMove.tsx`: the
/// readout shows inline whenever enabled, but the board only highlights the
/// move's from/to squares while the admin HOLDS the floating `AdminPeekButton`
/// the hosting view provides (press-and-hold, not a toggle) — never an
/// always-on arrow.
///
/// Duck Chess: the standard engine has no Duck rules and its "best move" is
/// often exactly the square the duck now blocks, so in Duck mode this queries
/// the DUCK engine (`/duck/analyze`) instead — its composite best move's SAN
/// already carries the duck placement.
///
/// Antichess: captures are compulsory and material is inverted, so the
/// standard engine's "best move" is frequently ILLEGAL here. In Antichess
/// mode this queries the ANTICHESS engine (`/antichess/analyze`) instead,
/// which returns a full-strength best LEGAL move + eval.
struct AdminBestMove: View {
    let fen: String
    let myTurn: Bool
    /// The variant's raw wire string (`Variant.rawValue` / `LiveGameState.variant`)
    /// — only `"duck"` and `"antichess"` route to a different engine; every
    /// other value uses the standard `/analyze` path.
    let variant: String
    /// The current duck square, required to query the Duck engine.
    let duck: String?
    /// Reports the current best move's from/to squares so the hosting view can
    /// highlight them on a hold-to-reveal peek. Called with `[]` whenever
    /// there's nothing to show (disabled, off-turn, error, or on disappear).
    let onBestMove: ([Square]) -> Void
    /// Reports the peek button's press state (press-and-hold). The button lives
    /// in THIS row (below the board), never on the board — holding it reveals
    /// the highlight the hosting view draws.
    let onPeek: (Bool) -> Void

    @Environment(AuthStore.self) private var authStore

    @AppStorage("admin.bestMove") private var enabled = false
    @State private var best: BestDisplay?
    @State private var errorText: String?
    @State private var loading = false

    /// Progressive movetime ladder (ms): a near-instant guess, refined twice.
    /// The engine keeps its transposition table warm across these stateless
    /// calls, so each deeper rung is cheap.
    private static let ladder = [20, 100, 1000]

    private var isDuck: Bool { variant == "duck" }
    private var isAntichess: Bool { variant == "antichess" }

    private var isAdmin: Bool { authStore.user?.role == "admin" }

    var body: some View {
        if isAdmin {
            content
        } else {
            EmptyView()
        }
    }

    private var content: some View {
        HStack(alignment: .center, spacing: Theme.Spacing.sm) {
            Toggle("", isOn: $enabled)
                .labelsHidden()
                .tint(Theme.Colors.accent)

            if enabled {
                readout
            }

            Spacer(minLength: 0)

            // Hold-to-reveal peek button lives here in the admin row, off the
            // board — only once a best move is available to reveal.
            if enabled, best != nil {
                AdminPeekButton { onPeek($0) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task(id: RunKey(fen: fen, myTurn: myTurn, enabled: enabled, variant: variant, duck: duck)) {
            await run()
        }
        .onDisappear { onBestMove([]) }
    }

    @ViewBuilder
    private var readout: some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
            if let errorText {
                Text(errorText)
                    .font(Theme.caption(11.5).monospaced())
                    .foregroundStyle(Theme.Colors.negative)
                    .lineLimit(1)
            } else if let best {
                Text(best.san)
                    .font(Theme.body(14).bold().monospaced())
                    .foregroundStyle(Theme.Colors.accent)
                    .lineLimit(1)
                    .layoutPriority(2)

                if !best.pv.isEmpty {
                    Text(best.pv.joined(separator: " "))
                        .font(Theme.caption(11.5).monospaced())
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                Text(best.evalDepthText)
                    .font(Theme.caption(11.5).monospaced())
                    .foregroundStyle(Theme.Colors.secondaryText)
                    .lineLimit(1)
                    .layoutPriority(1)
            } else if loading {
                Text("…")
                    .font(Theme.caption(11.5).monospaced())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    // MARK: - Fetch ladder

    /// Identifies one run of the ladder — a fresh `.task(id:)` value cancels
    /// whatever ladder is in flight and starts over, mirroring the web
    /// effect's `[enabled, fen, myTurn, isDuck, isAntichess, duck]` deps.
    private struct RunKey: Equatable {
        let fen: String
        let myTurn: Bool
        let enabled: Bool
        let variant: String
        let duck: String?
    }

    private func run() async {
        guard enabled, myTurn, !fen.isEmpty else {
            best = nil
            errorText = nil
            loading = false
            onBestMove([])
            return
        }

        errorText = nil
        loading = true
        var landed = false

        for movetime in Self.ladder {
            if Task.isCancelled { return }
            do {
                let display = try await fetchDisplay(movetime: movetime)
                if Task.isCancelled { return }
                landed = true
                best = display
                errorText = nil
                loading = false
                onBestMove(display.squares)
            } catch {
                if Task.isCancelled { return }
                // A deeper rung failing never wipes a good shallower result —
                // only surface an error if nothing has landed yet, and stop
                // climbing the ladder either way.
                if !landed {
                    errorText = errorMessage(error)
                    loading = false
                    onBestMove([])
                }
                return
            }
        }
    }

    private func errorMessage(_ error: Error) -> String {
        (error as? APIError)?.errorDescription ?? "Analysis failed"
    }

    /// One rung of the ladder: a fixed-movetime best move, normalized to
    /// `BestDisplay` regardless of which engine answered it.
    private func fetchDisplay(movetime: Int) async throws -> BestDisplay {
        let board = ChessBoard(fen: fen)
        if isDuck {
            let d = try await AnalysisService.shared.duckAnalyze(fen: fen, duck: duck ?? "", movetime: movetime)
            return BestDisplay(
                san: d.bestSan ?? d.bestmove ?? "—",
                pv: [],
                evalDepthText: evalLabel(d.eval, sideToMove: board.sideToMove),
                squares: squares(fromUci:d.bestmove)
            )
        }
        if isAntichess {
            let a = try await AnalysisService.shared.antichessAnalyze(fen: fen, movetime: movetime)
            return BestDisplay(
                san: a.bestSan ?? a.bestmove ?? "—",
                pv: [],
                evalDepthText: evalLabel(a.eval, sideToMove: board.sideToMove),
                squares: squares(fromUci:a.bestmove)
            )
        }
        let a = try await AnalysisService.shared.analyze(fen: fen, movetime: movetime)
        let san = a.bestmove.map { SAN.format(uci: $0, board: board) } ?? "—"
        // The full PV starts with the best move itself — the continuation
        // shown alongside it is the next couple of plies after that.
        let continuation = Array(sanPV(a.pv, from: board).dropFirst().prefix(2))
        var evalDepthText = evalLabel(a.eval, sideToMove: board.sideToMove)
        if let depth = a.depth {
            evalDepthText += " · d\(depth)"
        }
        return BestDisplay(san: san, pv: continuation, evalDepthText: evalDepthText, squares: squares(fromUci:a.bestmove))
    }

    /// Formats a UCI principal variation as SAN ply-by-ply, applying each
    /// move to advance the board (same pattern as `EngineLinesPanel.sanPV`).
    private func sanPV(_ pv: [String], from board: ChessBoard) -> [String] {
        var current = board
        return pv.map { uci in
            let san = SAN.format(uci: uci, board: current)
            current = current.applying(uci)
            return san
        }
    }

    /// `/analyze`, `/duck/analyze`, and `/antichess/analyze` all report
    /// side-to-move-relative eval — convert to white-relative and apply the
    /// same 0.5 display-cp scale as `EngineLinesPanel.evalLabel` so numbers
    /// match the rest of the app.
    private func evalLabel(_ eval: EvalScore?, sideToMove: PieceColor) -> String {
        guard let eval else { return "—" }
        let whiteRelative = sideToMove == .white ? eval.value : -eval.value
        if eval.type == "mate" { return "M\(whiteRelative)" }
        return String(format: "%+.1f", Double(whiteRelative) * 0.5 / 100)
    }

    /// The from/to squares to report for the board peek highlight. Duck's best
    /// move is a composite `"<pieceUci>:<duckSquare>"` — highlight only the
    /// piece move (the first token before `:`), same as web `hintFromUci`.
    private func squares(fromUci uci: String?) -> [Square] {
        guard let uci else { return [] }
        let pieceUci = uci.split(separator: ":", maxSplits: 1).first.map(String.init) ?? uci
        guard let move = Move(uci: pieceUci) else { return [] }
        return [move.from, move.to]
    }
}

/// Normalized best-move readout so every engine (standard/Duck/Antichess)
/// renders through the same row.
private struct BestDisplay {
    let san: String
    /// The next 1-2 PV continuation moves (SAN), after the best move itself.
    /// Empty for Duck/Antichess (neither engine reports a PV).
    let pv: [String]
    /// Pre-formatted `"+0.5 · d18"` (or just `"+0.5"` when there's no depth).
    let evalDepthText: String
    /// The best move's from/to squares for the board peek highlight.
    let squares: [Square]
}

#Preview("AdminBestMove — admin, enabled") {
    AdminBestMovePreview(role: "admin")
}

#Preview("AdminBestMove — non-admin (renders nothing)") {
    AdminBestMovePreview(role: "player")
}

private struct AdminBestMovePreview: View {
    let role: String
    @State private var squares: [Square] = []

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            AdminBestMove(
                fen: "r1bqk2r/ppp2ppp/2n2n2/2bpp3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 2 6",
                myTurn: true,
                variant: "standard",
                duck: nil,
                onBestMove: { squares = $0 },
                onPeek: { _ in }
            )
            Text(squares.isEmpty ? "hint: none" : "hint: " + squares.map(\.algebraic).joined(separator: "→"))
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
        }
        .padding()
        .background(Theme.Colors.background)
        .environment(AuthStore.preview(user: .adminBestMovePreviewStub(role: role)))
    }
}

private extension User {
    /// Decoded (not memberwise-initialized, per `User`'s `@Default`
    /// construction gotcha) so every other rating field falls back to its
    /// normal decode default. Mirrors `IdentityHeader.identityHeaderPreviewStub`.
    static func adminBestMovePreviewStub(role: String) -> User {
        let json = Data("""
        {"id":"preview","name":"Admin","email":"admin@example.com","role":"\(role)"}
        """.utf8)
        return try! JSONDecoder().decode(User.self, from: json)
    }
}
