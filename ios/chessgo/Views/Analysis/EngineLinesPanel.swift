import SwiftUI

/// Shows the live eval ladder's current best line for whatever position
/// `driver` is viewing (depth + eval + best move + PV), plus an optional
/// full-strength Stockfish "second opinion" (`POST /sf-analyze`) toggle.
///
/// The Stockfish fetch itself is NOT owned here — it lives on `driver`
/// (`driver.sfEnabled`/`.sfResult`/`.sfLoading`/`.sfError`) so `AnalysisView`'s
/// board arrow reads the exact same in-flight/last-fetched result this panel
/// shows, with one fetch instead of two. `sfEnabled` is a `Binding` because
/// both this panel's toggle AND the board's SF-arrow toggle write the same
/// flag — flipping either one is the single on/off switch.
struct EngineLinesPanel: View {
    let driver: AnalysisDriver
    @Binding var sfEnabled: Bool
    let sfResult: SfAnalyzeResult?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            header
            engineLineRow

            Toggle(isOn: $sfEnabled) {
                Text("Stockfish second opinion")
                    .font(Theme.body(14))
                    .foregroundStyle(Theme.Colors.primaryText)
            }
            .tint(Theme.Colors.accent)

            if sfEnabled {
                sfRow
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.md)
        .flatPanel()
    }

    private var header: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Text("Engine")
                .font(Theme.caption().bold())
                .foregroundStyle(Theme.Colors.secondaryText)
            if driver.isEvalRunning {
                ProgressView().controlSize(.small)
            }
            Spacer()
            if let depth = driver.liveEval?.depth {
                Text("depth \(depth)")
                    .font(Theme.caption(12).monospacedDigit())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    @ViewBuilder
    private var engineLineRow: some View {
        if let liveEval = driver.liveEval {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: Theme.Spacing.sm) {
                    Text(evalLabel(liveEval.eval, sideToMove: sideToMove))
                        .font(Theme.body(16).bold().monospacedDigit())
                        .foregroundStyle(Theme.Colors.primaryText)
                    if let bestmove = liveEval.bestmove {
                        Text("Best: \(SAN.format(uci: bestmove, board: board))")
                            .font(Theme.body(14))
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                if !liveEval.pv.isEmpty {
                    Text(sanPV(liveEval.pv, from: board).prefix(8).joined(separator: " "))
                        .font(Theme.caption(12).monospaced())
                        .foregroundStyle(Theme.Colors.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
        } else {
            Text("Thinking…")
                .font(Theme.body(14))
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    @ViewBuilder
    private var sfRow: some View {
        if driver.sfLoading, sfResult == nil {
            ProgressView().frame(maxWidth: .infinity, alignment: .leading)
        } else if let sfError = driver.sfError {
            Text(sfError)
                .font(Theme.caption(12))
                .foregroundStyle(Theme.Colors.secondaryText)
        } else if let sfResult {
            HStack(spacing: Theme.Spacing.sm) {
                Text(evalLabel(sfResult.eval, sideToMove: sideToMove))
                    .font(Theme.body(15).monospacedDigit())
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(sfResult.san ?? sfResult.bestmove.map { SAN.format(uci: $0, board: board) } ?? "—")
                    .font(Theme.body(15))
                    .foregroundStyle(Theme.Colors.primaryText)
                Spacer()
                Text("Stockfish")
                    .font(Theme.caption(11))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    private var board: ChessBoard { ChessBoard(fen: driver.fen) }
    private var sideToMove: PieceColor { board.sideToMove }

    /// Formats a UCI principal variation as SAN ply-by-ply, applying each
    /// move to advance the board so every ply is formatted from its own
    /// position (a later disambiguator/capture/check can depend on it).
    /// Best-effort — see `SAN.format`.
    private func sanPV(_ pv: [String], from board: ChessBoard) -> [String] {
        var current = board
        return pv.map { uci in
            let san = SAN.format(uci: uci, board: current)
            current = current.applying(uci)
            return san
        }
    }

    /// `/analyze` and `/sf-analyze` both report side-to-move-relative eval —
    /// convert to white-relative and apply the same 0.5 display-cp scale as
    /// `EvalBar` so every number on the analysis screen reads consistently.
    private func evalLabel(_ eval: EvalScore?, sideToMove: PieceColor) -> String {
        guard let eval else { return "—" }
        let whiteRelative = sideToMove == .white ? eval.value : -eval.value
        if eval.type == "mate" { return "M\(whiteRelative)" }
        return String(format: "%+.1f", Double(whiteRelative) * 0.5 / 100)
    }
}

#Preview("EngineLinesPanel — free explore") {
    EngineLinesPanelPreview()
}

private struct EngineLinesPanelPreview: View {
    let driver = AnalysisDriver(fen: nil)
    @State private var sfEnabled = false

    var body: some View {
        EngineLinesPanel(driver: driver, sfEnabled: $sfEnabled, sfResult: nil)
            .padding()
            .background(Theme.Colors.background)
    }
}
