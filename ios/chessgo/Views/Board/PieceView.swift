import SwiftUI

/// Renders one piece in the active piece set (`SettingsStore.pieceSet`, one of
/// the seven sets in `Theme/BoardTheme.swift`). Artwork lives in
/// `Assets.xcassets` as `<set>_<code>` — e.g. `neo_wK` — and carries its own
/// white/black colouring, so there is no tinting here.
///
/// The set is read from the environment rather than passed in, so every piece
/// on every screen follows the preference without threading it through each
/// board. `set:` overrides it for the settings picker, which has to draw the
/// other options next to the active one. With no `SettingsStore` in the
/// environment (previews) it falls back to the app default, Neo.
struct PieceView: View {
    let piece: Piece
    /// Explicit set; `nil` means "follow the preference."
    private let explicitSet: PieceSetID?

    @Environment(SettingsStore.self) private var settings: SettingsStore?

    init(piece: Piece, set: PieceSetID? = nil) {
        self.piece = piece
        self.explicitSet = set
    }

    var body: some View {
        Image(resolvedSet.assetName(for: piece))
            .resizable()
            .scaledToFit()
            .shadow(color: .black.opacity(0.18), radius: 0.6, y: 0.5)
    }

    private var resolvedSet: PieceSetID {
        explicitSet ?? settings?.pieceSet ?? .neo
    }
}

#Preview("Piece sets") {
    VStack(spacing: 8) {
        ForEach(PieceSetID.allCases) { set in
            HStack(spacing: 4) {
                ForEach(PieceKind.allCases, id: \.fenLetter) { kind in
                    PieceView(piece: Piece(color: .white, kind: kind), set: set)
                        .frame(width: 36, height: 36)
                }
                ForEach(PieceKind.allCases, id: \.fenLetter) { kind in
                    PieceView(piece: Piece(color: .black, kind: kind), set: set)
                        .frame(width: 36, height: 36)
                }
            }
        }
    }
    .padding()
    .background(BoardSquareFace(face: BoardThemeID.amethyst.palette.dark))
}
