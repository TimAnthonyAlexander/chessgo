import SwiftUI

/// Renders one piece from the cburnett vector set. The SVGs live in
/// `Assets.xcassets` (asset names `wP`…`bK`) and Xcode rasterizes them from
/// their preserved vector data, so they stay crisp at any board size. The
/// artwork carries its own white/black colouring, so there is no tinting here.
///
/// Piece set: cburnett by Colin M.L. Burnett (GPLv2+), the same set the web
/// client ships as its default.
struct PieceView: View {
    let piece: Piece

    var body: some View {
        Image(assetName)
            .resizable()
            .scaledToFit()
            .shadow(color: .black.opacity(0.18), radius: 0.6, y: 0.5)
    }

    private var assetName: String {
        let color = piece.color == .white ? "w" : "b"
        let kind: String
        switch piece.kind {
        case .king: kind = "K"
        case .queen: kind = "Q"
        case .rook: kind = "R"
        case .bishop: kind = "B"
        case .knight: kind = "N"
        case .pawn: kind = "P"
        }
        return color + kind
    }
}

#Preview("Pieces — light square") {
    HStack(spacing: 4) {
        ForEach(PieceKind.allCases, id: \.fenLetter) { kind in
            PieceView(piece: Piece(color: .white, kind: kind))
                .frame(width: 44, height: 44)
        }
    }
    .padding()
    .background(Theme.Colors.boardLight)
}

#Preview("Pieces — dark square") {
    HStack(spacing: 4) {
        ForEach(PieceKind.allCases, id: \.fenLetter) { kind in
            PieceView(piece: Piece(color: .black, kind: kind))
                .frame(width: 44, height: 44)
        }
    }
    .padding()
    .background(Theme.Colors.boardDark)
}
