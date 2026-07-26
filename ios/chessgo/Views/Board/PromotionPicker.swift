import SwiftUI

/// Overlay shown when a pawn move has more than one server-listed promotion
/// option and auto-queen is off. `options` come straight from parsing the
/// matching `legalMoves` entries (e.g. e7e8q/e7e8r/e7e8b/e7e8n) — Antichess
/// can list `.king` too (a pawn may "promote" to king there), so this makes
/// no assumption about which kinds appear, it just lays out whatever it's given.
struct PromotionPicker: View {
    let color: PieceColor
    let options: [PieceKind]
    let onSelect: (PieceKind) -> Void

    /// Queen/rook/bishop/knight/king, filtered to whatever `options` actually
    /// contains, so the picker has a stable, familiar left-to-right order
    /// regardless of the order `legalMoves` happened to list them in.
    private var ordered: [PieceKind] {
        [.queen, .rook, .bishop, .knight, .king].filter { options.contains($0) }
    }

    var body: some View {
        VStack(spacing: Theme.Spacing.sm) {
            Text("Promote to")
                .font(Theme.caption())
                .foregroundStyle(Theme.Colors.secondaryText)
            HStack(spacing: Theme.Spacing.sm) {
                ForEach(ordered, id: \.fenLetter) { kind in
                    Button {
                        onSelect(kind)
                    } label: {
                        PieceView(piece: Piece(color: color, kind: kind))
                            .frame(width: 48, height: 48)
                            .padding(Theme.Spacing.xs)
                    }
                    .background(Theme.Colors.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous))
                }
            }
        }
        .padding(Theme.Spacing.md)
        .glassCard()
    }
}

#Preview("Promotion — standard") {
    ZStack {
        Theme.Colors.background
        PromotionPicker(color: .white, options: [.queen, .rook, .bishop, .knight]) { _ in }
    }
    .frame(width: 320, height: 320)
}

#Preview("Promotion — Antichess (with king)") {
    ZStack {
        Theme.Colors.background
        PromotionPicker(color: .black, options: [.queen, .rook, .bishop, .knight, .king]) { _ in }
    }
    .frame(width: 320, height: 320)
}
