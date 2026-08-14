import SwiftUI

/// Opening explorer: the opening name (ECO + name) when the position is still
/// in book, plus the engine's ranked move list with a mini eval each.
///
/// This panel does NOT search. It renders the MultiPV `lines` that
/// `AnalysisDriver`'s eval ladder already fetched for this exact position —
/// it used to fire its own `POST /candidates` for the same fen, which meant
/// two independent searches of one position whose numbers could disagree with
/// each other and with the eval bar. One search now feeds both, and the list
/// deepens as the ladder climbs instead of being frozen at one shallow budget.
struct OpeningPanel: View {
    let fen: String
    let lines: [AnalysisLine]
    let opening: Opening?
    /// True while the ladder has yet to deliver anything for this position —
    /// lets the panel show a spinner rather than "no moves" before the first
    /// rung lands.
    var isLoading: Bool = false

    /// How many ranked moves to show. The ladder requests 5; the extra one
    /// absorbs the book move being pinned to the front without pushing a real
    /// engine line off the bottom.
    private static let maxRows = 4

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
    }

    @ViewBuilder
    private var content: some View {
        openingHeader
        if lines.isEmpty {
            if isLoading {
                ProgressView().frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text("No candidate moves.")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(lines.prefix(Self.maxRows).enumerated()), id: \.offset) { index, line in
                    candidateRow(rank: index + 1, line: line)
                }
            }
        }
    }

    @ViewBuilder
    private var openingHeader: some View {
        if let opening {
            Text("\(opening.eco) · \(opening.name)")
                .font(Theme.body(15).bold())
                .foregroundStyle(Theme.Colors.primaryText)
        } else {
            Text("Out of book")
                .font(Theme.body(15))
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private func candidateRow(rank: Int, line: AnalysisLine) -> some View {
        HStack {
            Text("\(rank).")
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
                .frame(width: 20, alignment: .trailing)
            Text(line.san)
                .font(Theme.body(15))
                .foregroundStyle(Theme.Colors.primaryText)
            Spacer()
            Text(evalLabel(line.eval, sideToMove: sideToMove))
                .font(Theme.caption(13).monospacedDigit())
                .foregroundStyle(Theme.Colors.secondaryText)
        }
    }

    private var sideToMove: PieceColor { ChessBoard(fen: fen).sideToMove }

    /// Line evals are side-to-move relative (rest-api.md), same as `/analyze`.
    /// Converts to white-relative and applies the same 0.5 display-cp scale as
    /// `EvalBar` so every number on the analysis screen reads consistently.
    private func evalLabel(_ eval: EvalScore?, sideToMove: PieceColor) -> String {
        guard let eval else { return "—" }
        // A tablebase verdict replaces the number outright: a solved position
        // has no evaluation to print, only a result.
        if let tb = eval.tbWhite(sideToMove: sideToMove) { return tb.label }
        let whiteRelative = sideToMove == .white ? eval.value : -eval.value
        if eval.type == "mate" { return "M\(whiteRelative)" }
        return String(format: "%+.1f", Double(whiteRelative) * 0.5 / 100)
    }
}

#Preview("OpeningPanel — start position") {
    OpeningPanel(
        fen: ChessBoard.startFEN,
        lines: [],
        opening: Opening(eco: "B00", name: "King's Pawn Game"),
        isLoading: true
    )
    .padding()
    .background(Theme.Colors.background)
}
