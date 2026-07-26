import SwiftUI

/// Shows the live eval ladder's current best line for whatever position
/// `driver` is viewing (depth + eval + best move + PV), plus an optional
/// full-strength Stockfish "second opinion" (`POST /sf-analyze`) toggle.
struct EngineLinesPanel: View {
    let driver: AnalysisDriver

    @State private var sfEnabled = false
    @State private var sfResult: SfAnalyzeResult?
    @State private var sfLoading = false
    @State private var sfError: String?

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
        .glassCard()
        .onChange(of: sfEnabled) { _, enabled in
            if enabled { Task { await loadSf() } }
        }
        .onChange(of: driver.fen) { _, _ in
            if sfEnabled { Task { await loadSf() } }
        }
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
                        Text("Best: \(bestmove)")
                            .font(Theme.body(14))
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                }
                if !liveEval.pv.isEmpty {
                    Text(liveEval.pv.prefix(8).joined(separator: " "))
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
        if sfLoading, sfResult == nil {
            ProgressView().frame(maxWidth: .infinity, alignment: .leading)
        } else if let sfError {
            Text(sfError)
                .font(Theme.caption(12))
                .foregroundStyle(Theme.Colors.secondaryText)
        } else if let sfResult {
            HStack(spacing: Theme.Spacing.sm) {
                Text(evalLabel(sfResult.eval, sideToMove: sideToMove))
                    .font(Theme.body(15).monospacedDigit())
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(sfResult.san ?? sfResult.bestmove ?? "—")
                    .font(Theme.body(15))
                    .foregroundStyle(Theme.Colors.primaryText)
                Spacer()
                Text("Stockfish")
                    .font(Theme.caption(11))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        }
    }

    private var sideToMove: PieceColor { ChessBoard(fen: driver.fen).sideToMove }

    /// `/analyze` and `/sf-analyze` both report side-to-move-relative eval —
    /// convert to white-relative and apply the same 0.5 display-cp scale as
    /// `EvalBar` so every number on the analysis screen reads consistently.
    private func evalLabel(_ eval: EvalScore?, sideToMove: PieceColor) -> String {
        guard let eval else { return "—" }
        let whiteRelative = sideToMove == .white ? eval.value : -eval.value
        if eval.type == "mate" { return "M\(whiteRelative)" }
        return String(format: "%+.1f", Double(whiteRelative) * 0.5 / 100)
    }

    private func loadSf() async {
        sfLoading = true
        sfError = nil
        defer { sfLoading = false }
        do {
            sfResult = try await AnalysisService.shared.sfAnalyze(fen: driver.fen)
        } catch let error as APIError {
            sfError = error.errorDescription
        } catch {
            sfError = error.localizedDescription
        }
    }
}

#Preview("EngineLinesPanel — free explore") {
    EngineLinesPanel(driver: AnalysisDriver(fen: nil))
        .padding()
        .background(Theme.Colors.background)
}
