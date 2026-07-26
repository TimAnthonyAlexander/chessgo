import SwiftUI

/// Admin-only inline control: when enabled, fetches the FULL-STRENGTH engine
/// best move for the current position (only while it's the player's own
/// turn) and shows it compactly as `move · continuation · eval · depth`,
/// reporting the move's from→to squares up so the hosting board can draw a
/// hint arrow. Self-contained and admin-gated — hosting views just render it
/// (`if authStore.user?.role == "admin"` is checked internally) and feed the
/// current FEN.
///
/// Port of the web `frontend/src/components/AdminBestMove.tsx`, with one
/// deliberate simplification: the web only draws the hint behind a
/// hold-to-reveal "peek" gesture (desktop key hold / mobile touch pad); this
/// port draws the hint arrow any time the control is enabled and a best move
/// is known — a simpler, always-on hint. No peek gesture is built here.
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
    /// Reports the current best-move squares so the hosting view can draw a
    /// board hint. Called with `nil` whenever there's nothing to show
    /// (disabled, off-turn, error, or on disappear).
    let onHint: (BoardArrow?) -> Void

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
        HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
            Toggle("", isOn: $enabled)
                .labelsHidden()
                .tint(Theme.Colors.accent)

            if enabled {
                readout
            }
        }
        .task(id: RunKey(fen: fen, myTurn: myTurn, enabled: enabled, variant: variant, duck: duck)) {
            await run()
        }
        .onDisappear { onHint(nil) }
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
        .frame(maxWidth: .infinity, alignment: .trailing)
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
            onHint(nil)
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
                onHint(display.hint)
            } catch {
                if Task.isCancelled { return }
                // A deeper rung failing never wipes a good shallower result —
                // only surface an error if nothing has landed yet, and stop
                // climbing the ladder either way.
                if !landed {
                    errorText = errorMessage(error)
                    loading = false
                    onHint(nil)
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
                hint: hint(fromUci: d.bestmove)
            )
        }
        if isAntichess {
            let a = try await AnalysisService.shared.antichessAnalyze(fen: fen, movetime: movetime)
            return BestDisplay(
                san: a.bestSan ?? a.bestmove ?? "—",
                pv: [],
                evalDepthText: evalLabel(a.eval, sideToMove: board.sideToMove),
                hint: hint(fromUci: a.bestmove)
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
        return BestDisplay(san: san, pv: continuation, evalDepthText: evalDepthText, hint: hint(fromUci: a.bestmove))
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

    /// Extracts the from/to squares to report as a board hint. Duck's best
    /// move is a composite `"<pieceUci>:<duckSquare>"` — hint only the piece
    /// move (the first token before `:`), same as web `hintFromUci`.
    private func hint(fromUci uci: String?) -> BoardArrow? {
        guard let uci else { return nil }
        let pieceUci = uci.split(separator: ":", maxSplits: 1).first.map(String.init) ?? uci
        guard let move = Move(uci: pieceUci) else { return nil }
        return BoardArrow(from: move.from, to: move.to, color: Theme.Colors.accent)
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
    let hint: BoardArrow?
}

#Preview("AdminBestMove — admin, enabled") {
    AdminBestMovePreview(role: "admin")
}

#Preview("AdminBestMove — non-admin (renders nothing)") {
    AdminBestMovePreview(role: "player")
}

private struct AdminBestMovePreview: View {
    let role: String
    @State private var hint: BoardArrow?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            AdminBestMove(
                fen: "r1bqk2r/ppp2ppp/2n2n2/2bpp3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 2 6",
                myTurn: true,
                variant: "standard",
                duck: nil,
                onHint: { hint = $0 }
            )
            Text(hint.map { "hint: \($0.from.algebraic)→\($0.to.algebraic)" } ?? "hint: none")
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
