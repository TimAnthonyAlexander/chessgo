import SwiftUI

/// Crazyhouse pocket strip: one row of tappable piece counts for the side to
/// move. Tapping arms a drop (tap-tap, matching the web — arm, then place);
/// tapping the armed piece again disarms it. `armed` is a `Binding` so the
/// screen that hosts both this and `BoardView` shares one piece of state:
/// wire the same binding into `BoardView(armedDrop:)` and `PocketView(armed:)`
/// and the board takes care of highlighting legal drop squares and
/// completing the drop on tap.
struct PocketView: View {
    /// Raw server pocket string, white upper-case / black lower-case
    /// (e.g. "PPNq"). `nil` outside Crazyhouse.
    let pocket: String?
    /// Side to move — only that side's pieces are shown/tappable.
    let sideToMove: PieceColor
    @Binding var armed: PieceKind?

    private var counts: [(kind: PieceKind, count: Int)] {
        guard let pocket else { return [] }
        // Keyed by the uppercase FEN letter, not `PieceKind` itself — it's
        // Equatable but not Hashable, so it can't be a dictionary key.
        var tally: [Character: Int] = [:]
        for char in pocket {
            guard let kind = PieceKind(fenLetter: char) else { continue }
            let belongsToSideToMove = sideToMove == .white ? char.isUppercase : char.isLowercase
            guard belongsToSideToMove else { continue }
            tally[kind.fenLetter, default: 0] += 1
        }
        // Stable, familiar order: pawn, knight, bishop, rook, queen.
        let order: [PieceKind] = [.pawn, .knight, .bishop, .rook, .queen]
        return order.compactMap { kind in
            guard let count = tally[kind.fenLetter], count > 0 else { return nil }
            return (kind: kind, count: count)
        }
    }

    var body: some View {
        HStack(spacing: Theme.Spacing.sm) {
            if counts.isEmpty {
                Text("Pocket empty")
                    .font(Theme.caption())
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            ForEach(counts, id: \.kind.fenLetter) { entry in
                Button {
                    armed = (armed == entry.kind) ? nil : entry.kind
                } label: {
                    VStack(spacing: 2) {
                        PieceView(piece: Piece(color: sideToMove, kind: entry.kind))
                            .frame(width: 32, height: 32)
                        Text("\(entry.count)")
                            .font(Theme.caption(11))
                            .foregroundStyle(Theme.Colors.secondaryText)
                    }
                    .padding(Theme.Spacing.xs)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous)
                            .fill(armed == entry.kind ? Theme.Colors.accent.opacity(0.28) : Theme.Colors.surface)
                    )
                }
            }
        }
        .padding(.horizontal, Theme.Spacing.sm)
        .padding(.vertical, Theme.Spacing.xs)
    }
}

#Preview("Pocket — white to move") {
    PocketViewPreview(pocket: "PPNq", sideToMove: .white)
}

#Preview("Pocket — empty") {
    PocketViewPreview(pocket: nil, sideToMove: .black)
}

private struct PocketViewPreview: View {
    let pocket: String?
    let sideToMove: PieceColor
    @State private var armed: PieceKind?

    var body: some View {
        PocketView(pocket: pocket, sideToMove: sideToMove, armed: $armed)
            .background(Theme.Colors.background)
    }
}
