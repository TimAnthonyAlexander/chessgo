import SwiftUI

/// Opening explorer: `POST /candidates` for the currently-viewed fen —
/// opening name (ECO + name) when the position is still in book, plus the
/// ranked candidate moves with a mini eval each. Once out of book there's no
/// opening name, so this falls back to showing just the top candidate.
struct OpeningPanel: View {
    let fen: String
    var history: [String] = []

    @State private var candidates: Candidates?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Opening")
                .font(Theme.caption().bold())
                .foregroundStyle(Theme.Colors.secondaryText)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.md)
        .flatPanel()
        .task(id: fen) { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading, candidates == nil {
            ProgressView().frame(maxWidth: .infinity, alignment: .leading)
        } else if let errorMessage {
            Text(errorMessage)
                .font(Theme.body(13))
                .foregroundStyle(Theme.Colors.secondaryText)
        } else if let candidates {
            openingHeader(candidates)
            moveList(candidates)
        } else {
            Text("No data.")
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    @ViewBuilder
    private func openingHeader(_ candidates: Candidates) -> some View {
        if let opening = candidates.opening {
            Text("\(opening.eco) · \(opening.name)")
                .font(Theme.body(15).bold())
                .foregroundStyle(Theme.Colors.primaryText)
        } else {
            Text("Out of book")
                .font(Theme.body(15))
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    @ViewBuilder
    private func moveList(_ candidates: Candidates) -> some View {
        if candidates.moves.isEmpty {
            Text("No candidate moves.")
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
        } else if candidates.opening == nil, let best = candidates.moves.first {
            // Out of book: just the best move, no full ranked list.
            candidateRow(rank: 1, move: best)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(candidates.moves.prefix(4).enumerated()), id: \.offset) { index, move in
                    candidateRow(rank: index + 1, move: move)
                }
            }
        }
    }

    private func candidateRow(rank: Int, move: CandidateMove) -> some View {
        HStack {
            Text("\(rank).")
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
                .frame(width: 20, alignment: .trailing)
            Text(move.san)
                .font(Theme.body(15))
                .foregroundStyle(Theme.Colors.primaryText)
            Spacer()
            Text(evalLabel(move.eval, sideToMove: sideToMove))
                .font(Theme.caption(13).monospacedDigit())
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private var sideToMove: PieceColor { ChessBoard(fen: fen).sideToMove }

    /// `CandidateMove.eval` is side-to-move relative (rest-api.md), same as
    /// `/analyze`. Converts to white-relative and applies the same 0.5
    /// display-cp scale as `EvalBar` so every number on the analysis screen
    /// reads consistently.
    private func evalLabel(_ eval: EvalScore?, sideToMove: PieceColor) -> String {
        guard let eval else { return "—" }
        let whiteRelative = sideToMove == .white ? eval.value : -eval.value
        if eval.type == "mate" { return "M\(whiteRelative)" }
        return String(format: "%+.1f", Double(whiteRelative) * 0.5 / 100)
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            candidates = try await AnalysisService.shared.candidates(
                fen: fen,
                history: history.isEmpty ? nil : history,
                multipv: 4
            )
        } catch let error as APIError {
            errorMessage = error.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

#Preview("OpeningPanel — start position") {
    OpeningPanel(fen: ChessBoard.startFEN)
        .padding()
        .background(Theme.Colors.background)
}
