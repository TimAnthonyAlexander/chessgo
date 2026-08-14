import Foundation
import SwiftUI

/// Vertical eval bar, Lichess-style win% fill. `EvalScore` (Models/BotGame.swift)
/// is side-to-move relative, so this converts to white-relative before the
/// sigmoid — a positive white-relative score always fills more white.
///
/// Display cp scale: the engine's native centipawn score runs about 2x hot
/// compared to what feels calibrated on screen (frontend-features.md, the
/// analysis eval bar note), so this applies the same 0.5 display scale before
/// the win% conversion. Mate scores fill the bar fully to the mating side.
struct EvalBar: View {
    let eval: EvalScore?
    let sideToMove: PieceColor

    /// Lichess's standard cp -> win% sigmoid constant.
    private static let sigmoidK = -0.00368208

    private var whitePercent: Double {
        guard let eval else { return 0.5 }
        // A tablebase verdict is certainty, so the bar fills like a mate does
        // rather than being driven by the cp stand-in riding on it.
        if let tb = eval.tbWhite(sideToMove: sideToMove) { return tb == .win ? 1.0 : 0.0 }
        if eval.type == "mate" {
            let whiteRelative = sideToMove == .white ? eval.value : -eval.value
            return whiteRelative >= 0 ? 1.0 : 0.0
        }
        let sideRelativeCp = Double(eval.value) * 0.5 // display cp scale
        let whiteRelativeCp = sideToMove == .white ? sideRelativeCp : -sideRelativeCp
        let winPercent = 50 + 50 * (2 / (1 + exp(Self.sigmoidK * whiteRelativeCp)) - 1)
        return min(1, max(0, winPercent / 100))
    }

    private var label: String {
        guard let eval else { return "" }
        // The label sits at the winning side's end of the bar, so the side is
        // already said by where it is — "TB", like "M3", carries no sign here.
        if eval.tbVerdict != nil { return "TB" }
        if eval.type == "mate" {
            let whiteRelative = sideToMove == .white ? eval.value : -eval.value
            return "M\(abs(whiteRelative))"
        }
        let sideRelativeCp = Double(eval.value) * 0.5
        let whiteRelativeCp = sideToMove == .white ? sideRelativeCp : -sideRelativeCp
        return String(format: "%+.1f", whiteRelativeCp / 100)
    }

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                // Black fill on top, white fill on bottom — white's share
                // grows up from the bottom as `whitePercent` rises.
                Rectangle()
                    .fill(Theme.Colors.primaryText.opacity(0.85))
                    .frame(height: geo.size.height * (1 - whitePercent))
                Rectangle()
                    .fill(Color(red: 0.98, green: 0.96, blue: 0.90))
                    .frame(height: geo.size.height * whitePercent)
            }
            .overlay(alignment: whitePercent >= 0.5 ? .bottom : .top) {
                Text(label)
                    .font(Theme.caption(10).monospacedDigit())
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .foregroundStyle(whitePercent >= 0.5 ? Theme.Colors.primaryText : Color(red: 0.98, green: 0.96, blue: 0.90))
                    .padding(.vertical, 3)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                .stroke(Theme.Colors.primaryText.opacity(0.12), lineWidth: 1)
        )
        .animation(.easeOut(duration: 0.25), value: whitePercent)
    }
}

#Preview("EvalBar — even") {
    EvalBar(eval: EvalScore(type: "cp", value: 12), sideToMove: .white)
        .frame(width: 28, height: 280)
        .padding()
        .background(Theme.Colors.background)
}

#Preview("EvalBar — white clearly ahead") {
    EvalBar(eval: EvalScore(type: "cp", value: 420), sideToMove: .white)
        .frame(width: 28, height: 280)
        .padding()
        .background(Theme.Colors.background)
}

#Preview("EvalBar — black to move, black ahead") {
    EvalBar(eval: EvalScore(type: "cp", value: 300), sideToMove: .black)
        .frame(width: 28, height: 280)
        .padding()
        .background(Theme.Colors.background)
}

#Preview("EvalBar — tablebase win for white") {
    EvalBar(eval: EvalScore(type: "cp", value: 1000, tb: "win"), sideToMove: .white)
        .frame(width: 28, height: 280)
        .padding()
        .background(Theme.Colors.background)
}

#Preview("EvalBar — mate for white") {
    EvalBar(eval: EvalScore(type: "mate", value: 3), sideToMove: .white)
        .frame(width: 28, height: 280)
        .padding()
        .background(Theme.Colors.background)
}
